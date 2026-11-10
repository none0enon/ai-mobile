import { getLocation, getScene, isRealPlace, parseControlTags, type Message, type MessagePart, type MessageRole } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { buildChats, buildMessages } from '@/mock/chats';
import { services } from '@/services';
import { buildPromptMessages } from '@/services/prompt';
import { uid } from '@/utils/id';

/** 正在生成的回复。只放内存，不进同步数据（math-reader 回滚提交的教训） */
interface StreamState {
  messageId: string;
  thinking: boolean;
  abort: AbortController;
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Record<string, Message[]>>(buildMessages());
  const chats = ref(buildChats(messages.value));
  const streams = reactive<Record<string, StreamState | undefined>>({});

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
    streams[chatId] = { messageId: id, thinking: true, abort };
    const scene = getScene(chat.currentScene ?? 'free');
    let raw = '';

    try {
      await services.llm.chat(
        { agent: 'main', messages: buildPromptMessages(chat, character, history), signal: abort.signal },
        {
          onState: (s) => {
            const st = streams[chatId];
            if (st) st.thinking = s !== 'streaming';
          },
          onText: (full) => {
            raw = full;
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
      const parsed = parseControlTags(raw, scene.allowedTags);
      msg.text = parsed.visible.trim();
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
      // 配图：假装交给生图提示词智能体 + NovelAI，过一会儿出图
      if (parts.some((p) => p.type === 'image')) {
        setTimeout(() => {
          const m = find(chatId, id);
          const img = m?.parts.find((p) => p.type === 'image');
          if (img && img.type === 'image') {
            img.generated = true;
            img.seed = 20261110;
            img.prompt = `${character.appearanceTags}, ${img.caption}`;
          }
        }, 2400);
      }
    } catch {
      const msg = find(chatId, id);
      if (msg) msg.meta.interrupted = true;
    } finally {
      delete streams[chatId];
    }
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
    if (!msg.swipes.length) msg.swipes = [{ text: msg.text, parts: msg.parts, expression: msg.expression, createdAt: msg.createdAt }];
    await generate(chatId, messageId);
  }

  /** 戳一戳：先在聊天里留一条"你拍了拍她的头"，需要时再让她回应 */
  async function poke(chatId: string, target: string, withReply = true) {
    push(chatId, 'user', [{ type: 'poke', actor: 'user', target }]);
    if (withReply) await generate(chatId);
  }

  /** 一起出门前她在哪、在做什么：去了又什么都没发生时还原。只放内存 */
  const beforeVisit = new Map<string, { locationId: string | null; status: string }>();

  /**
   * 和她一起去某个地点、开始某个场景：在聊天里插一条"来到图书馆 · 陪伴学习"的分隔，记下你们此刻在一起的地点。
   * - 她小世界里的地点：你去她的世界找她，她的位置也跟着过去；
   * - 你真实世界里的地点（街角咖啡店……）：你带她出门，她暂时"来你这边"，离开后回到自己的世界。
   */
  function enterScene(characterId: string, locationId: string, sceneId: string) {
    const chat = chatOfCharacter(characterId);
    const character = useCharacterStore().byId(characterId);
    if (!chat || !character) return;
    if (chat.togetherAt === locationId && chat.currentScene === sceneId) return;
    if (chat.togetherAt) leaveScene(characterId);
    const loc = getLocation(locationId);
    const activity = loc?.activities.find((a) => a.sceneId === sceneId)?.label ?? getScene(sceneId).name;
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    // 刚离开同一个地方又回来（离开时没留下总结）：把"离开"撤掉，当作没离开过
    if (last && lastPart?.type === 'scene' && lastPart.event === 'leave' && lastPart.locationId === locationId && !lastPart.summary && last.parts.length === 1) {
      messages.value[chat.id]?.pop();
    } else {
      const title = isRealPlace(loc) ? `带${character.name}去${loc?.name ?? ''} · ${activity}` : `和${character.name}来到${loc?.name ?? ''} · ${activity}`;
      push(chat.id, 'narrator', [{ type: 'scene', event: 'enter', sceneId, locationId, title }]);
    }
    if (!beforeVisit.has(characterId)) beforeVisit.set(characterId, { locationId: character.locationId, status: character.status });
    chat.togetherAt = locationId;
    chat.currentScene = sceneId;
    character.locationId = locationId;
    // 家里的活动带房间名（卧室 · 哄睡），状态只要后半截
    character.status = activity.split(' · ').at(-1) ?? activity;
  }

  /**
   * 离开当前地点。如果进来之后什么都没发生，就把"来到…"也撤掉，她也回到原来的地方，不留痕迹。
   * 从你的真实世界离开时，她总是回到自己的世界（回到出门前的地方）。
   */
  function leaveScene(characterId: string, summary?: string) {
    const chat = chatOfCharacter(characterId);
    if (!chat?.togetherAt) return;
    const character = useCharacterStore().byId(characterId);
    const before = beforeVisit.get(characterId);
    beforeVisit.delete(characterId);
    const loc = getLocation(chat.togetherAt);
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    if (last && lastPart?.type === 'scene' && lastPart.event === 'enter' && last.parts.length === 1 && !summary) {
      messages.value[chat.id]?.pop();
      if (character && before) Object.assign(character, before);
    } else {
      push(chat.id, 'narrator', [
        { type: 'scene', event: 'leave', sceneId: chat.currentScene ?? 'free', locationId: chat.togetherAt, title: `离开${loc?.name ?? ''}`, summary },
      ]);
      if (character && isRealPlace(loc)) Object.assign(character, { locationId: before?.locationId ?? character.locationId, status: '刚从你那边回来' });
      else if (character) character.status = '刚和你分开';
    }
    chat.togetherAt = null;
    chat.currentScene = null;
  }

  /** 场景结束时把记录卡片发进聊天（运动、饭照、学习、约会回忆……） */
  function postCard(chatId: string, role: MessageRole, part: MessagePart, text?: string) {
    const parts: MessagePart[] = text ? [{ type: 'text', text }, part] : [part];
    return push(chatId, role, parts);
  }

  return {
    chats,
    messages,
    streams,
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
    poke,
    postCard,
    enterScene,
    leaveScene,
  };
});
