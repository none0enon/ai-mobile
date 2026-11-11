import {
  getLocation,
  getScene,
  isRealPlace,
  parseControlTags,
  substituteMacros,
  type Character,
  type Chat,
  type Message,
  type MessagePart,
  type MessageRole,
  type TogetherMode,
} from '@app/shared';
import { errorText, isAbortError } from '@app/ai';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useRealWorldStore } from './realworld';
import { autoSave, getAll } from '@/db/idb';
import { buildChats, buildMessages } from '@/mock/chats';
import { services } from '@/services';
import { assembleForChat, personaOf, toLLMMessages, type ChatPrompt } from '@/services/prompt';
import { uid } from '@/utils/id';

/** 正在生成的回复。只放内存，不进同步数据（math-reader 回滚提交的教训） */
interface StreamState {
  messageId: string;
  /** 还没有正文：请求刚发出、模型在思考、流式失败正改用普通请求 */
  thinking: boolean;
  /** 模型的思考内容（有的模型会返回） */
  reasoning: string;
  abort: AbortController;
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Record<string, Message[]>>(buildMessages());
  const chats = ref<Chat[]>(buildChats(messages.value));
  const streams = reactive<Record<string, StreamState | undefined>>({});
  /** 每条聊天上一次实际发出去的提示词（"查看提示词"里看）。只放内存 */
  const lastPrompt = reactive<Record<string, { prompt: ChatPrompt; at: number } | undefined>>({});

  // 演示聊天每次打开重新生成；和导入角色的聊天存在本机
  const DEMO_CHATS = new Set(chats.value.map((c) => c.id));
  const chatSaver = autoSave(
    'chats',
    () => chats.value.filter((c) => !DEMO_CHATS.has(c.id)).map((c) => ({ key: c.id, value: c })),
    chats,
  );
  const messageSaver = autoSave(
    'messages',
    () => chats.value.filter((c) => !DEMO_CHATS.has(c.id)).map((c) => ({ key: c.id, value: messages.value[c.id] ?? [] })),
    messages,
  );

  async function hydrate() {
    const [cs, ms] = await Promise.all([getAll<Chat>('chats'), getAll<Message[]>('messages')]);
    for (const c of cs.sort((a, b) => a.createdAt - b.createdAt)) if (!chats.value.some((x) => x.id === c.id)) chats.value.push(c);
    for (const list of ms) {
      const chatId = list[0]?.chatId;
      if (chatId && !DEMO_CHATS.has(chatId)) messages.value[chatId] = list;
    }
    chatSaver.start();
    messageSaver.start();
  }

  /**
   * 给新角色开一条聊天：第一条是角色卡的开场白（宏替换后），备选开场白可以左右切换（同 ST）。
   * 已经有聊天就直接返回那条（消息按人分）。
   */
  function startChat(character: Character, presetId: string | null = null): Chat {
    const existing = chatOfCharacter(character.id);
    if (existing) return existing;
    const now = Date.now();
    const chat: Chat = {
      id: uid('chat'),
      createdAt: now,
      updatedAt: now,
      characterId: character.id,
      personaId: null,
      title: character.name,
      presetId: presetId ?? character.presetId,
      mode: 'im',
      currentScene: null,
      togetherAt: null,
      togetherMode: null,
      summaryUntilMessageId: null,
      pinned: false,
      lastMessageAt: now,
      background: null,
      loreState: { sticky: {}, cooldown: {} },
      vars: {},
    };
    chats.value.push(chat);
    messages.value[chat.id] = [];
    const user = personaOf(chat).name;
    const greet = (t: string) => substituteMacros(t, { char: character.name, user }).replace(/\r/g, '');
    const greetings = [character.card.firstMes, ...character.card.alternateGreetings].filter((t) => t.trim()).map(greet);
    if (greetings.length) {
      push(chat.id, 'assistant', [{ type: 'text', text: greetings[0] as string }], {
        read: false,
        swipes: greetings.map((text, i) => ({ text, createdAt: now + i })),
        swipeIndex: 0,
      });
    }
    return chatById(chat.id) as Chat;
  }

  function removeChat(chatId: string) {
    chats.value = chats.value.filter((c) => c.id !== chatId);
    delete messages.value[chatId];
  }

  const sortedChats = computed(() =>
    [...chats.value].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt - a.lastMessageAt),
  );

  function chatById(id: string | undefined) {
    return chats.value.find((c) => c.id === id);
  }

  /** 消息按人分：一个角色只有一条聊天 */
  function chatOfCharacter(characterId: string) {
    return chats.value.find((c) => c.characterId === characterId);
  }

  function list(chatId: string): Message[] {
    return messages.value[chatId] ?? [];
  }

  function unread(chatId: string): number {
    return list(chatId).filter((m) => !m.read).length;
  }

  const totalUnread = computed(() => chats.value.reduce((n, c) => n + unread(c.id), 0));


  function markRead(chatId: string) {
    for (const m of list(chatId)) if (!m.read) m.read = true;
  }

  /** 追加一条消息，返回响应式版本（之后要改它，必须改这个返回值或按 id 重新取） */
  function push(chatId: string, role: MessageRole, parts: MessagePart[], extra: Partial<Message> = {}): Message {
    const now = Date.now();
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const msg: Message = {
      id: uid('m'),
      chatId,
      role,
      createdAt: now,
      updatedAt: now,
      text,
      parts,
      expression: null,
      swipes: [],
      swipeIndex: 0,
      proactive: false,
      read: true,
      meta: {},
      ...extra,
    };
    if (!messages.value[chatId]) messages.value[chatId] = [];
    messages.value[chatId]?.push(msg);
    const chat = chatById(chatId);
    if (chat) {
      chat.lastMessageAt = now;
      chat.updatedAt = now;
    }
    return list(chatId).at(-1) as Message;
  }

  function find(chatId: string, id: string): Message | undefined {
    return list(chatId).find((m) => m.id === id);
  }

  /**
   * 让角色回一条：流式更新正文、实时切表情，结束后执行其他标签（歌曲卡、配图、选项、来电）。
   * target 不为空时是"重新生成"：结果作为新的 swipe 追加到这条消息上。
   */
  async function generate(chatId: string, target?: string) {
    if (streams[chatId]) return;
    const chat = chatById(chatId);
    const chars = useCharacterStore();
    const character = chars.byId(chat?.characterId);
    if (!chat || !character) return;

    const id = target ?? push(chatId, 'assistant', [{ type: 'text', text: '' }]).id;
    const history = list(chatId).filter((m) => m.id !== id && (!target || m.createdAt < (find(chatId, id)?.createdAt ?? Infinity)));
    const abort = new AbortController();
    streams[chatId] = { messageId: id, thinking: true, reasoning: '', abort };
    const scene = getScene(chat.currentScene ?? 'free');
    let raw = '';

    // 拼提示词（真实发送：推进世界书粘性 / 冷却，保存 {{setvar}} 改过的变量）
    const prompt = assembleForChat(chat, character, history, { type: target ? 'swipe' : 'normal' });
    chat.loreState = prompt.loreState;
    chat.vars = prompt.vars;
    lastPrompt[chatId] = { prompt, at: Date.now() };

    try {
      const result = await services.llm.chat(
        {
          agent: 'main',
          messages: toLLMMessages(prompt),
          body: prompt.request,
          characterId: character.id,
          names: { user: prompt.persona.name, char: character.name },
          signal: abort.signal,
        },
        {
          onState: (s) => {
            const st = streams[chatId];
            if (!st) return;
            if (s === 'streaming') st.thinking = false;
            else if (s === 'sent' || s === 'connected' || s === 'thinking' || s === 'fallback') st.thinking = !raw;
          },
          onThinking: (t) => {
            const st = streams[chatId];
            if (st) st.reasoning = t;
          },
          onText: (full) => {
            raw = full;
            const st = streams[chatId];
            if (st && full) st.thinking = false;
            const msg = find(chatId, id);
            if (!msg) return;
            const parsed = parseControlTags(full, scene.allowedTags);
            msg.text = parsed.visible.trimStart();
            msg.parts = [{ type: 'text', text: msg.text }];
            const expr = [...parsed.tags].reverse().find((t) => t.tag.kind === 'expr')?.tag;
            if (expr && 'value' in expr) {
              chars.setExpression(character.id, expr.value);
              msg.expression = expr.value;
            }
          },
        },
      );

      const msg = find(chatId, id);
      if (!msg) return;
      raw = result.text || raw;
      const parsed = parseControlTags(raw, scene.allowedTags);
      msg.text = parsed.visible.trim();
      msg.meta.error = undefined;
      msg.meta.interrupted = undefined;
      if (!result.demo) {
        msg.meta.model = result.model;
        msg.meta.agent = 'main';
        msg.meta.latencyMs = result.latencyMs;
        msg.meta.tokens = result.tokens;
        msg.meta.fellBack = result.fellBack || undefined;
      }
      const parts: MessagePart[] = [{ type: 'text', text: msg.text }];
      for (const { tag } of parsed.tags) {
        if (tag.kind === 'music') parts.push({ type: 'music', songId: 's1', title: tag.title, artist: tag.artist });
        if (tag.kind === 'cg') parts.push({ type: 'image', assetKey: null, caption: tag.value, generated: false });
        if (tag.kind === 'choice') msg.meta.choices = tag.options;
        if (tag.kind === 'call') {
          setTimeout(() => {
            useAppStore().showBanner({
              characterId: character.id,
              title: `${character.name} 邀请你语音通话`,
              text: '点这里接听',
              to: `/call/${character.id}?incoming=1`,
              icon: 'i-lucide-phone-incoming',
            });
          }, 900);
        }
      }
      msg.parts = parts;
      const swipe = { text: msg.text, parts, expression: msg.expression, createdAt: Date.now() };
      if (target) {
        msg.swipes = [...(msg.swipes.length ? msg.swipes : []), swipe];
        msg.swipeIndex = msg.swipes.length - 1;
      } else {
        msg.swipes = [swipe];
      }
      // 配图：生图提示词智能体写 tags → 生图智能体出图；没有生图连接时演示一下
      for (const part of parts) if (part.type === 'image') void drawPart(chatId, id, part.caption);
    } catch (e) {
      const msg = find(chatId, id);
      if (msg) {
        if (isAbortError(e) || abort.signal.aborted) msg.meta.interrupted = true;
        else msg.meta.error = errorText(e);
      }
    } finally {
      delete streams[chatId];
    }
  }

  /** 最近几句对话（给生图提示词智能体、番外智能体看） */
  function recentLines(chatId: string, n = 6): string[] {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    const user = personaOf(chat).name;
    return list(chatId)
      .filter((m) => m.text && (m.role === 'user' || m.role === 'assistant'))
      .slice(-n)
      .map((m) => `${m.role === 'user' ? user : (character?.name ?? '她')}: ${m.text}`);
  }

  /**
   * 给一条消息里的配图出图。await 之后按 id 重新取消息和卡片（设计文档 §3.1 的教训：生成期间对象可能被替换）
   */
  async function drawPart(chatId: string, messageId: string, caption: string) {
    const chat = chatById(chatId);
    const chars = useCharacterStore();
    const character = chars.byId(chat?.characterId);
    const findPart = () => {
      const p = find(chatId, messageId)?.parts.find((x) => x.type === 'image' && x.caption === caption);
      return p?.type === 'image' ? p : undefined;
    };
    if (!chat || !character) return;
    if (!services.image.live) {
      // 演示：过一会儿"画好"，用占位画
      await new Promise((r) => setTimeout(r, 2400));
      const part = findPart();
      if (part) Object.assign(part, { generated: true, seed: 20261110, prompt: `${character.appearanceTags}, ${caption}` });
      return;
    }
    const before = findPart();
    if (before) Object.assign(before, { generated: false, error: undefined });
    try {
      const out = await services.image.illustrate({
        characterId: character.id,
        caption,
        place: getLocation(chat.togetherAt ?? character.locationId)?.name,
        expression: chars.expression[character.id],
        recent: recentLines(chatId),
      });
      const part = findPart();
      if (!part) return;
      Object.assign(part, {
        assetKey: out.assetKey ?? out.url ?? null,
        prompt: out.prompt,
        negative: out.negative,
        seed: out.seed ?? undefined,
        model: out.model,
        generated: true,
        error: undefined,
      });
    } catch (e) {
      const part = findPart();
      if (part) part.error = errorText(e);
    }
  }

  /** 重画一张配图（失败后、或者想换一张） */
  function redraw(chatId: string, part: MessagePart) {
    if (part.type !== 'image') return;
    const msg = list(chatId).find((m) => m.parts.includes(part));
    if (msg) void drawPart(chatId, msg.id, part.caption);
  }

  async function send(chatId: string, text: string) {
    const t = text.trim();
    if (!t) return;
    const last = list(chatId).at(-1);
    if (last?.meta.choices) last.meta.choices = undefined;
    push(chatId, 'user', [{ type: 'text', text: t }]);
    await generate(chatId);
  }

  function stop(chatId: string) {
    streams[chatId]?.abort.abort();
  }

  function swipe(chatId: string, messageId: string, dir: 1 | -1) {
    const msg = find(chatId, messageId);
    if (!msg || msg.swipes.length < 2) return;
    msg.swipeIndex = (msg.swipeIndex + dir + msg.swipes.length) % msg.swipes.length;
    const s = msg.swipes[msg.swipeIndex];
    if (!s) return;
    msg.text = s.text;
    msg.parts = s.parts ?? [{ type: 'text', text: s.text }];
    if (s.expression) msg.expression = s.expression;
  }

  async function regenerate(chatId: string, messageId: string) {
    const msg = find(chatId, messageId);
    if (!msg) return;
    // 失败时这条可能是空的：空的不当成一个备选回复
    if (!msg.swipes.length && msg.text) msg.swipes = [{ text: msg.text, parts: msg.parts, expression: msg.expression, createdAt: msg.createdAt }];
    await generate(chatId, messageId);
  }

  /** 戳一戳：先在聊天里留一条"你拍了拍她的头"，需要时再让她回应 */
  async function poke(chatId: string, target: string, withReply = true) {
    push(chatId, 'user', [{ type: 'poke', actor: 'user', target }]);
    if (withReply) await generate(chatId);
  }

  /** 一起出门前她在哪、在做什么：去了又什么都没发生时还原。只放内存 */
  const beforeVisit = new Map<string, { locationId: string | null; status: string }>();

  /** 没指定怎么在一起时：约会、戳戳乐默认去她那儿，其余默认连线 */
  const DEFAULT_MODE: Record<string, TogetherMode> = { date: 'visit', poke: 'visit' };

  /** 你此刻在真实世界的哪儿（连线时记下来，成为"我们的足迹"） */
  function yourPlace() {
    const real = useRealWorldStore();
    return getLocation(real.hereId) ?? real.home;
  }

  function enterTitle(mode: TogetherMode, characterName: string, pronoun: string, locName: string, activity: string) {
    if (mode === 'remote') return { title: `和${characterName}连线 · ${activity}`, summary: `你在${yourPlace().name}，${pronoun}在${locName}` };
    if (mode === 'bring') return { title: `带${characterName}去${locName} · ${activity}` };
    return { title: `和${characterName}来到${locName} · ${activity}` };
  }

  /**
   * 和她一起做某件事：在聊天里插一条开始的分隔，记下她那边在哪、怎么在一起。
   * - 连线（默认）：你在你那儿，她去她世界里做这件事的地方，各做各的、一起做；
   * - 去她那：地点在她的世界，你"坐到她旁边"；
   * - 带她来：地点在你的真实世界，她暂时"来你这边"，离开后回到自己的世界。
   */
  function enterScene(characterId: string, locationId: string, sceneId: string, mode?: TogetherMode) {
    const chat = chatOfCharacter(characterId);
    const character = useCharacterStore().byId(characterId);
    if (!chat || !character) return;
    const loc = getLocation(locationId);
    const how: TogetherMode = isRealPlace(loc) ? 'bring' : (mode ?? DEFAULT_MODE[sceneId] ?? 'remote');
    if (chat.togetherAt === locationId && chat.currentScene === sceneId) {
      if (chat.togetherMode !== how) setTogetherMode(characterId, how);
      return;
    }
    if (chat.togetherAt) leaveScene(characterId);
    const activity = loc?.activities.find((a) => a.sceneId === sceneId)?.label ?? getScene(sceneId).name;
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    // 刚结束同一件事又回来（结束时没留下总结）：把"结束"撤掉，当作没断过
    if (last && lastPart?.type === 'scene' && lastPart.event === 'leave' && lastPart.locationId === locationId && !lastPart.summary && last.parts.length === 1) {
      messages.value[chat.id]?.pop();
    } else {
      const youAt = how === 'bring' ? locationId : how === 'remote' ? yourPlace().id : undefined;
      push(chat.id, 'narrator', [
        { type: 'scene', event: 'enter', sceneId, locationId, mode: how, youAt, ...enterTitle(how, character.name, character.pronoun, loc?.name ?? '', activity) },
      ]);
    }
    if (!beforeVisit.has(characterId)) beforeVisit.set(characterId, { locationId: character.locationId, status: character.status });
    chat.togetherAt = locationId;
    chat.togetherMode = how;
    chat.currentScene = sceneId;
    character.locationId = locationId;
    // 家里的活动带房间名（卧室 · 哄睡），状态只要后半截
    character.status = activity.split(' · ').at(-1) ?? activity;
  }

  /** 连线 ⇄ 去她那（同一件事里切换）：刚开始还没聊什么时，顺手改掉开始那条分隔 */
  function setTogetherMode(characterId: string, mode: TogetherMode) {
    const chat = chatOfCharacter(characterId);
    const character = useCharacterStore().byId(characterId);
    if (!chat?.togetherAt || !character || chat.togetherMode === 'bring' || mode === 'bring') return;
    chat.togetherMode = mode;
    const last = list(chat.id).at(-1);
    const part = last?.parts[0];
    if (last && part?.type === 'scene' && part.event === 'enter' && last.parts.length === 1) {
      const loc = getLocation(chat.togetherAt);
      const activity = loc?.activities.find((a) => a.sceneId === part.sceneId)?.label ?? getScene(part.sceneId).name;
      const { title, summary } = enterTitle(mode, character.name, character.pronoun, loc?.name ?? '', activity) as { title: string; summary?: string };
      Object.assign(part, { mode, title, summary, youAt: mode === 'remote' ? yourPlace().id : undefined });
    }
  }

  /**
   * 结束这件事。如果开始之后什么都没发生，就把开始那条也撤掉，她也回到原来的地方，不留痕迹。
   * 带她出门的，她总是回到自己的世界（回到出门前的地方）；连线结束后，她接着在自己那边做自己的事。
   */
  function leaveScene(characterId: string, summary?: string) {
    const chat = chatOfCharacter(characterId);
    if (!chat?.togetherAt) return;
    const character = useCharacterStore().byId(characterId);
    const before = beforeVisit.get(characterId);
    beforeVisit.delete(characterId);
    const how = chat.togetherMode ?? 'visit';
    const loc = getLocation(chat.togetherAt);
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    if (last && lastPart?.type === 'scene' && lastPart.event === 'enter' && last.parts.length === 1 && !summary) {
      messages.value[chat.id]?.pop();
      if (character && before) Object.assign(character, before);
    } else {
      const youAt = lastEnterYouAt(chat.id);
      push(chat.id, 'narrator', [
        {
          type: 'scene',
          event: 'leave',
          sceneId: chat.currentScene ?? 'free',
          locationId: chat.togetherAt,
          title: how === 'remote' ? '结束连线' : `离开${loc?.name ?? ''}`,
          summary,
          mode: how,
          youAt,
        },
      ]);
      if (character && how === 'bring') Object.assign(character, { locationId: before?.locationId ?? character.locationId, status: '刚从你那边回来' });
      else if (character && how === 'visit') character.status = '刚和你分开';
    }
    chat.togetherAt = null;
    chat.togetherMode = null;
    chat.currentScene = null;
  }

  function lastEnterYouAt(chatId: string): string | undefined {
    for (const m of [...list(chatId)].reverse()) {
      const p = m.parts[0];
      if (p?.type === 'scene' && p.event === 'enter') return p.youAt;
    }
    return undefined;
  }

  /**
   * 我们的足迹：你在真实世界里和她们一起待过的地方（连线时你在哪、带她去过哪）。
   * 按地点汇总，最近的在前。
   */
  const footprints = computed(() => {
    const byPlace = new Map<string, { placeId: string; characterIds: string[]; last: number; titles: string[] }>();
    for (const c of chats.value) {
      for (const m of list(c.id)) {
        const p = m.parts[0];
        if (p?.type !== 'scene' || p.event !== 'enter' || !p.youAt) continue;
        const f = byPlace.get(p.youAt) ?? { placeId: p.youAt, characterIds: [], last: 0, titles: [] };
        if (!f.characterIds.includes(c.characterId)) f.characterIds.push(c.characterId);
        f.last = Math.max(f.last, m.createdAt);
        f.titles.push(p.title);
        byPlace.set(p.youAt, f);
      }
    }
    return [...byPlace.values()].sort((a, b) => b.last - a.last);
  });

  /** 场景结束时把记录卡片发进聊天（运动、饭照、学习、约会回忆……） */
  function postCard(chatId: string, role: MessageRole, part: MessagePart, text?: string) {
    const parts: MessagePart[] = text ? [{ type: 'text', text }, part] : [part];
    return push(chatId, role, parts);
  }

  return {
    chats,
    messages,
    streams,
    lastPrompt,
    hydrate,
    startChat,
    removeChat,
    sortedChats,
    totalUnread,
    chatById,
    chatOfCharacter,
    list,
    unread,
    markRead,
    push,
    send,
    stop,
    generate,
    swipe,
    regenerate,
    redraw,
    recentLines,
    poke,
    postCard,
    enterScene,
    leaveScene,
    setTogetherMode,
    footprints,
  };
});
