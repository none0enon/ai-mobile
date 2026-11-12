import {
  getLocation,
  getScene,
  isRealPlace,
  parseControlTags,
  substituteMacros,
  type Character,
  type Chat,
  type ImageMode,
  type Message,
  type MessagePart,
  type MessageRole,
  type TogetherMode,
  type AgentRole,
  type ControlTagKind,
  type PresetUseId,
} from '@app/shared';
import { errorReport, errorText, isAbortError, samplerRequest } from '@app/ai';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useRealWorldStore } from './realworld';
import { autoSave, getAll, getEntries, write } from '@/db/idb';
import { buildChats, buildMessages } from '@/mock/chats';
import { services } from '@/services';
import { putAsset } from '@/services/assets';
import { describePhoto } from '@/services/photos';
import { sessionSummary as musicSummary, stop as stopMusic } from '@/services/musicPlayer';
import { assembleForChat, personaOf, storeRegex, toLLMMessages, type ChatPrompt } from '@/services/prompt';
import { pendingForSummary, SUMMARY_EVERY, summarizeChat, type SummaryOutcome } from '@/services/summary';
import { uid } from '@/utils/id';

/** generate 的选项：一起做事时用哪个功能、这一次的场景任务、在这件事里的位置 */
export interface GenerateOptions {
  agent?: AgentRole;
  task?: { name: string; input: string };
  cue?: string;
  /** 按哪个用途选预设（语音通话用 call）；不给时按场景 / 对话预设 */
  use?: PresetUseId;
  /** 只执行这些标签（通话里只换表情，不发图、不弹选项、不再"打电话"）；不给按场景 */
  allowedTags?: ControlTagKind[];
  /** 流式时每次给"到目前为止的正文"（已去掉标签）：通话、讲故事时边生成边分句合成语音 */
  onText?(visible: string): void;
  /** 这一次回复上限至少这么多 token（讲故事这种长一点的，预设里给短句的上限不够） */
  minTokens?: number;
  /** 要快（通话、哄睡、看片时随口一句）：在认得思考参数的原生接口上把思考关到最少，见 quickReasoning */
  quick?: boolean;
}

export interface SceneReplyOptions {
  /** 场景任务名：功能预设里触发条件写了它的块只在这时发送 */
  task: string;
  /** 程序写的这一次的输入（只放数据） */
  input: string;
  /** 你这一次说的话（纸条、提问……）：先存进聊天，再让她回 */
  userText?: string;
  /** 在这件事里的位置，存在两条消息上（"第 2 个番茄"） */
  cue?: string;
  /** 流式时每次给到目前为止的正文（讲故事时边生成边读） */
  onText?(visible: string): void;
  /** 只执行这些标签；不给按场景 */
  allowedTags?: ControlTagKind[];
  minTokens?: number;
  quick?: boolean;
}

export type SceneReplyResult = { ok: true; message: Message } | { ok: false; reason: string; notConnected?: boolean };

/**
 * 要快的回复（通话、哄睡、看片时随口一句）能不能把思考关到最少：只在认得思考参数的原生接口上做
 * （Gemini / Vertex 设思考预算 0 或最低等级，DeepSeek 关掉思考，Claude 不开思考）。
 * OpenAI 格式的中转不一定认 reasoning_effort（有的直接报错），不发；你在 API 设置里自己设了推理强度时照你的
 */
function quickReasoning(agent: AgentRole): boolean {
  try {
    const ai = useAiStore();
    const set = ai.effectiveRoute(agent).params?.reasoningEffort;
    if (set && set !== 'auto') return false;
    const kind = ai.system.router.attempts(agent)[0]?.endpoint.kind;
    return kind === 'gemini' || kind === 'vertex' || kind === 'deepseek' || kind === 'anthropic';
  } catch {
    return false;
  }
}

/** 按这一次的要求调请求体（预设拼出来的 OpenAI 格式）：上限至少 minTokens；要快时推理强度设 none */
function tuneRequest(body: Record<string, unknown>, agent: AgentRole, opts: { minTokens?: number; quick?: boolean }): Record<string, unknown> {
  const out = { ...body };
  if (opts.minTokens && !(typeof out.max_tokens === 'number' && out.max_tokens >= opts.minTokens)) out.max_tokens = opts.minTokens;
  if (opts.quick && out.reasoning_effort === undefined && quickReasoning(agent)) out.reasoning_effort = 'none';
  return out;
}

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

  // 全部聊天持久化，含演示角色收到的真实云端消息。
  const chatSaver = autoSave(
    'chats',
    () => chats.value.map((c) => ({ key: c.id, value: c })),
    chats,
  );
  const messageSaver = autoSave(
    'messages',
    () => chats.value.map((c) => ({ key: c.id, value: messages.value[c.id] ?? [] })),
    messages,
  );

  async function hydrate() {
    const [cs, ms] = await Promise.all([getAll<Chat>('chats'), getEntries<Message[]>('messages')]);
    for (const c of cs.sort((a, b) => a.createdAt - b.createdAt)) {
      chats.value = chats.value.filter((x) => x.id !== c.id);
      delete (c as Chat & { presetId?: unknown }).presetId; // 旧数据里聊天上也存了一份预设，现在只看角色上的
      chats.value.push(c);
    }
    for (const { key: chatId, value: list } of ms) {
      if (!Array.isArray(list)) continue;
      // 上次画到一半 App 关了 / 刷新了：卡片别一直"生成中"
      for (const m of list) {
        for (const p of m.parts ?? []) {
          if (p.type === 'image' && !p.generated && !p.error) {
            p.error = '上次没画完（App 关了或刷新了）';
            p.errorDetail = '点开这张图，按"重新生成"再画一次。';
          }
        }
      }
      messages.value[chatId] = list;
    }
    await Promise.all([
      write('chats', chats.value.map((c) => ({ key: c.id, value: JSON.parse(JSON.stringify(c)) }))),
      write('messages', Object.entries(messages.value).map(([key, value]) => ({ key, value: JSON.parse(JSON.stringify(value)) }))),
    ]);
    chatSaver.start();
    messageSaver.start();
  }

  /**
   * 给新角色开一条聊天：第一条是角色卡的开场白（宏替换后），备选开场白可以左右切换（同 ST）。
   * 已经有聊天就直接返回那条（消息按人分）。
   */
  function startChat(character: Character): Chat {
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
   * opts：一起做事时用「陪伴 · 快速」、带上这一次的场景任务，回复记下场景和位置。返回这条回复的 id
   */
  async function generate(chatId: string, target?: string, opts: GenerateOptions = {}): Promise<string | undefined> {
    if (streams[chatId]) return undefined;
    const chat = chatById(chatId);
    const chars = useCharacterStore();
    const character = chars.byId(chat?.characterId);
    if (!chat || !character) return undefined;
    const agent = opts.agent ?? 'main';

    const id = target ?? push(chatId, 'assistant', [{ type: 'text', text: '' }], opts.task || opts.cue ? { meta: { scene: chat.currentScene ?? undefined, cue: opts.cue } } : {}).id;
    const history = list(chatId).filter((m) => m.id !== id && (!target || m.createdAt < (find(chatId, id)?.createdAt ?? Infinity)));
    const abort = new AbortController();
    streams[chatId] = { messageId: id, thinking: true, reasoning: '', abort };
    const scene = getScene(chat.currentScene ?? 'free');
    const allowedTags = opts.allowedTags ?? scene.allowedTags;
    let raw = '';

    try {
      // 拼提示词（真实发送：推进世界书粘性 / 冷却，保存 {{setvar}} 改过的变量）。
      // 预设按用途选：语音通话用"语音通话"的预设，在场景页里一起做某件事时用那件事的功能预设，聊天里用这个角色的对话预设；一个都选不到时报错
      const prompt = assembleForChat(chat, character, history, { type: target ? 'swipe' : 'normal', agent, task: opts.task, use: opts.use });
      if (opts.minTokens || opts.quick) prompt.request = tuneRequest(prompt.request, agent, opts);
      chat.loreState = prompt.loreState;
      chat.vars = prompt.vars;
      lastPrompt[chatId] = { prompt, at: Date.now() };

      const result = await services.llm.chat(
        {
          agent,
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
            const parsed = parseControlTags(full, allowedTags);
            msg.text = parsed.visible.trimStart();
            msg.parts = [{ type: 'text', text: msg.text }];
            const expr = [...parsed.tags].reverse().find((t) => t.tag.kind === 'expr')?.tag;
            if (expr && 'value' in expr) {
              chars.setExpression(character.id, expr.value);
              msg.expression = expr.value;
            }
            opts.onText?.(msg.text);
          },
        },
      );

      const msg = find(chatId, id);
      if (!msg) return;
      // 写完了：预设里改存下来的消息的正则（同 ST：流式时只改显示，写完才改存下来的）
      raw = storeRegex(chat, character, result.text || raw, 'assistant', { preset: prompt.preset });
      const parsed = parseControlTags(raw, allowedTags);
      msg.text = parsed.visible.trim();
      msg.meta.error = undefined;
      msg.meta.errorDetail = undefined;
      msg.meta.interrupted = undefined;
      if (!result.demo) {
        msg.meta.model = result.model;
        msg.meta.agent = agent;
        msg.meta.latencyMs = result.latencyMs;
        msg.meta.tokens = result.tokens;
        msg.meta.fellBack = result.fellBack || undefined;
      }
      const parts: MessagePart[] = [{ type: 'text', text: msg.text }];
      for (const { tag } of parsed.tags) {
        // 歌曲卡片：点"一起听"时按歌名 + 歌手去网易云搜（还没有 id）
        if (tag.kind === 'music') parts.push({ type: 'music', songId: '', title: tag.title, artist: tag.artist });
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
      // 配图：生图预设写 tags → 生图 API 出图；生图 API 没接通时卡片上写原因
      for (const part of parts) if (part.type === 'image') void drawPart(chatId, id, part.caption);
      // 攒够了就在后台整理一段（"总结"预设）
      setTimeout(() => void maybeSummarize(chatId), 0);
    } catch (e) {
      const msg = find(chatId, id);
      if (msg) {
        if (isAbortError(e) || abort.signal.aborted) msg.meta.interrupted = true;
        else {
          msg.meta.error = errorText(e);
          msg.meta.errorDetail = errorReport(e);
        }
      }
    } finally {
      delete streams[chatId];
    }
    return id;
  }

  /**
   * 一起做事时让她回一句（回纸条、休息时聊天、讲题……）：你说的话和她的回复都存进这条聊天，带上场景和位置。
   * 用「陪伴 · 快速」，提示词是这个场景的功能预设 + 这一次的场景任务。没接通时不出演示台词，告诉界面原因
   */
  async function sceneReply(chatId: string, opts: SceneReplyOptions): Promise<SceneReplyResult> {
    const chat = chatById(chatId);
    if (!chat) return { ok: false, reason: '找不到这条聊天' };
    const said = opts.userText?.trim();
    if (said) push(chatId, 'user', [{ type: 'text', text: said }], { meta: { scene: chat.currentScene ?? undefined, cue: opts.cue } });
    const status = useAiStore().status('companion');
    if (!status.live) return { ok: false, reason: `「陪伴 · 快速」还没接通：${status.reason}`, notConnected: true };
    if (streams[chatId]) return { ok: false, reason: '她还在回上一句' };
    const id = await generate(chatId, undefined, {
      agent: 'companion',
      task: { name: opts.task, input: opts.input },
      cue: opts.cue,
      onText: opts.onText,
      allowedTags: opts.allowedTags,
      minTokens: opts.minTokens,
      quick: opts.quick,
    });
    const msg = id ? find(chatId, id) : undefined;
    if (!msg) return { ok: false, reason: '没有生成回复' };
    if (msg.meta.error) return { ok: false, reason: msg.meta.error };
    return { ok: true, message: msg };
  }

  /**
   * 一起做事时要她按格式写一批东西（观影时接下来一段的弹幕、看书时接下来几页的批注……）：
   * 同样用这个场景的功能预设 + 场景任务，交给「陪伴 · 快速」，按 JSON 读回来。不推进世界书的粘性 / 冷却。
   * 写出来的东西由场景决定什么时候显示、显示时再存进聊天
   */
  async function sceneJson<T>(
    chatId: string,
    task: { name: string; input: string },
    parse: (value: unknown) => T | null,
    signal?: AbortSignal,
    tune: { minTokens?: number; quick?: boolean } = {},
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string; notConnected?: boolean }> {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (!chat || !character) return { ok: false, reason: '找不到这条聊天' };
    const ai = useAiStore();
    const status = ai.status('companion');
    if (!status.live) return { ok: false, reason: `「陪伴 · 快速」还没接通：${status.reason}`, notConnected: true };
    try {
      const prompt = assembleForChat(chat, character, list(chatId), { agent: 'companion', task, dryRun: true });
      lastPrompt[chatId] = { prompt, at: Date.now() };
      const req = { messages: toLLMMessages(prompt), ...samplerRequest(prompt.preset.sampler) };
      if (tune.minTokens && (req.maxTokens ?? 0) < tune.minTokens) req.maxTokens = tune.minTokens;
      const effort = tune.quick && quickReasoning('companion') ? { reasoningEffort: 'none' as const } : {};
      const { value } = await ai.system.json('companion', { ...req, ...effort }, parse, { signal });
      return { ok: true, value };
    } catch (e) {
      return { ok: false, reason: errorText(e) };
    }
  }

  // —— 总结：攒够 SUMMARY_EVERY 条定稿的消息就在后台整理一段（"总结 / 记忆"接通了 API 时） ——
  const summarizing = reactive<Record<string, boolean>>({});
  /** 自动整理失败后，这条聊天 10 分钟内不再自动试（完整报错在 API 设置 → 总结 / 记忆） */
  const summaryBackoff = new Map<string, number>();

  async function maybeSummarize(chatId: string) {
    const chat = chatById(chatId);
    // 一起做事的过程中不整理，结束（leaveScene）以后再整理
    if (!chat || chat.currentScene || summarizing[chatId] || streams[chatId] || !useAiStore().isLive('summary')) return;
    if ((summaryBackoff.get(chatId) ?? 0) > Date.now()) return;
    if (pendingForSummary(chat, list(chatId)).length < SUMMARY_EVERY) return;
    summarizing[chatId] = true;
    try {
      await summarizeChat(chat, list(chatId));
      summaryBackoff.delete(chatId);
    } catch (e) {
      if (!isAbortError(e)) summaryBackoff.set(chatId, Date.now() + 10 * 60_000);
    } finally {
      delete summarizing[chatId];
    }
  }

  /** 手动整理（聊天 ⋯ → 整理这段聊天）：结果或报错交给界面显示 */
  async function summarizeNow(chatId: string): Promise<SummaryOutcome | null> {
    const chat = chatById(chatId);
    if (!chat) return null;
    summarizing[chatId] = true;
    try {
      const r = await summarizeChat(chat, list(chatId));
      summaryBackoff.delete(chatId);
      return r;
    } finally {
      delete summarizing[chatId];
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
   * 给一条消息里的配图出图：生图预设写 tags（生图提示词）→ 生图 API 出图 → 存进本机素材库。
   * 生图 API 没接通时卡片上直接写原因，不拿占位画冒充"画好了"。
   * await 之后按 id 重新取消息和卡片（设计文档 §3.1 的教训：生成期间对象可能被替换）
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
    const before = findPart();
    if (!before) return;
    if (!services.image.live) {
      const s = useAiStore().status('image');
      Object.assign(before, {
        generated: false,
        error: '生图 API 还没接通',
        errorDetail: `${s.live ? '' : `${s.reason}\n\n`}在"我的 → API 设置 → 生图"里选渠道（NovelAI、硅基流动或自定义）、填地址和 Key，测试连接通过后，点这张图重新生成。`,
      });
      return;
    }
    // 重画时旧图先留着（画失败了也还在），画好了再换
    Object.assign(before, { generated: false, error: undefined, errorDetail: undefined });
    try {
      const out = await services.image.illustrate({
        characterId: character.id,
        caption,
        mode: before.mode,
        use: 'image',
        // 一起做事时按这件事该穿的那套告诉模型（运动服、睡衣……），平时按日常的；画面要换装时模型自己写
        sceneId: chat.currentScene,
        place: getLocation(chat.togetherAt ?? character.locationId)?.name,
        expression: chars.expression[character.id],
        recent: recentLines(chatId),
      });
      const part = findPart();
      if (!part) return;
      Object.assign(part, {
        assetKey: out.assetKey ?? out.url ?? null,
        title: out.caption && out.caption !== caption ? out.caption : undefined,
        prompt: out.prompt,
        negative: out.negative,
        seed: out.seed ?? undefined,
        model: out.model,
        generated: true,
        error: undefined,
        errorDetail: undefined,
      });
    } catch (e) {
      const part = findPart();
      if (part) {
        part.error = errorText(e);
        part.errorDetail = errorReport(e);
      }
    }
  }

  /**
   * "生成配图"：不经过对话模型，直接按"生图"预设写 tags、调生图 API。
   * 画好的图作为她发来的一张图放进聊天（发给模型的聊天记录里是"[图片：标题]"）。
   * caption 不写时按这次画什么、她在哪、最近的聊天画。
   */
  function drawImage(chatId: string, req: { mode: ImageMode; caption: string }) {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (!chat || !character) return;
    const place = getLocation(chat.togetherAt ?? character.locationId)?.name;
    const auto: Record<ImageMode, string> = {
      scene: '按最近的聊天，画此刻的画面',
      portrait: `${character.name}此刻的全身像`,
      face: `${character.name}此刻的脸部特写`,
      background: place ? `${place}，${character.name}此刻所在的地方` : `${character.name}此刻所在的地方`,
    };
    const caption = req.caption.trim() || auto[req.mode];
    const msg = push(chatId, 'assistant', [{ type: 'image', assetKey: null, caption, mode: req.mode, generated: false }]);
    msg.meta.agent = 'image';
    void drawPart(chatId, msg.id, caption);
  }

  /** 重画一张配图（失败后、或者想换一张） */
  function redraw(chatId: string, part: MessagePart) {
    if (part.type !== 'image') return;
    const msg = list(chatId).find((m) => m.parts.includes(part));
    if (msg) void drawPart(chatId, msg.id, part.caption);
  }

  /** 你写的话先过预设里改存下来的消息的正则（作用在"你发的消息"上的） */
  function regexUserText(chatId: string, text: string): string {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    return chat && character ? storeRegex(chat, character, text, 'user').trim() : text;
  }

  async function send(chatId: string, text: string) {
    const t = text.trim();
    if (!t) return;
    const last = list(chatId).at(-1);
    if (last?.meta.choices) last.meta.choices = undefined;
    // 正则把整句都删了：不留空消息，她照常回
    const said = regexUserText(chatId, t);
    if (said) push(chatId, 'user', [{ type: 'text', text: said }]);
    await generate(chatId);
  }

  function stop(chatId: string) {
    streams[chatId]?.abort.abort();
  }

  // —— 发照片（＋ → 相册 / 拍照）——
  /** 每条聊天里识图正在看的照片张数；正在看的照片（按素材 key） */
  const looking = reactive<Record<string, number>>({});
  const lookingKeys = reactive(new Set<string>());

  /**
   * 识图看这条消息里还没看过的照片，写下看到了什么（提示词里用它代替照片）。
   * 识图没接通时照片照样留着，卡片上写原因；返回没接通的原因
   */
  async function lookAt(chatId: string, messageId: string, retry = false): Promise<{ notConnected?: string }> {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    const pending = (find(chatId, messageId)?.parts ?? []).filter(
      (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image' && !!p.photo && !!p.assetKey && !p.seen && (retry || !p.seenError),
    );
    if (!pending.length) return {};
    const st = useAiStore().status('vision');
    if (!st.live) {
      for (const p of pending) p.seenError = `识图还没接通：${st.reason}`;
      return { notConnected: st.reason };
    }
    looking[chatId] = (looking[chatId] ?? 0) + pending.length;
    const keys = pending.map((p) => p.assetKey as string);
    for (const k of keys) lookingKeys.add(k);
    await Promise.all(
      keys.map(async (key) => {
        // await 之后按 key 重新取卡片（这期间消息可能被换成了新对象）
        const part = () => find(chatId, messageId)?.parts.find((x): x is Extract<MessagePart, { type: 'image' }> => x.type === 'image' && x.assetKey === key);
        try {
          const r = await describePhoto(key, character);
          const p = part();
          if (p) Object.assign(p, { seen: r.text, seenModel: r.model, seenError: undefined });
        } catch (e) {
          const p = part();
          if (p) p.seenError = errorText(e);
        } finally {
          looking[chatId] = Math.max(0, (looking[chatId] ?? 1) - 1);
          lookingKeys.delete(key);
        }
      }),
    );
    return {};
  }

  /**
   * 发照片给她：压缩好的照片存进本机素材库 → 发一条你的消息（照片 + 你写的话）→ 识图看一遍 → 她回一条。
   * 识图没接通时也发，她知道你发了照片、但看不到内容（不编）
   */
  async function sendPhotos(chatId: string, photos: { bytes: Uint8Array<ArrayBuffer>; mime: string }[], text?: string): Promise<{ notConnected?: string }> {
    if (!photos.length) return {};
    const keys = await Promise.all(photos.map((p) => putAsset(p.bytes, p.mime)));
    const parts: MessagePart[] = keys.map((assetKey) => ({ type: 'image', assetKey, caption: '', generated: true, photo: true }));
    const said = text?.trim() ? regexUserText(chatId, text.trim()) : '';
    if (said) parts.push({ type: 'text', text: said });
    const last = list(chatId).at(-1);
    if (last?.meta.choices) last.meta.choices = undefined;
    const msg = push(chatId, 'user', parts);
    const r = await lookAt(chatId, msg.id);
    void generate(chatId);
    return r;
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

  /**
   * 改一条消息的文字（你的、她的都能改），卡片（图片、歌曲……）不动。
   * 她的回复同时改当前这个备选回复：左右切换再回来还是改过的
   */
  function editMessage(chatId: string, id: string, text: string) {
    const msg = find(chatId, id);
    if (!msg) return;
    let t = text.replace(/\r/g, '').trim();
    // 预设里勾了"改消息时也执行"的正则（同 ST 的 runOnEdit）
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (chat && character && (msg.role === 'user' || msg.role === 'assistant')) t = storeRegex(chat, character, t, msg.role, { edit: true }).trim();
    const cards = msg.parts.filter((p) => p.type !== 'text');
    if (!t && !cards.length) return;
    const parts: MessagePart[] = t ? [{ type: 'text', text: t }, ...cards] : cards;
    Object.assign(msg, { text: t, parts, updatedAt: Date.now() });
    const current = msg.swipes[msg.swipeIndex];
    if (current) Object.assign(current, { text: t, parts });
    // 改过就是你认可的内容了，"被打断""回复失败"的提示不再显示
    Object.assign(msg.meta, { interrupted: undefined, error: undefined, errorDetail: undefined });
  }

  /**
   * 通话里你开口打断了她：她这条只留下已经说出口的部分（设计文档 §11.2"保留已说的部分"）。
   * 这是正常的对话，不算"回复被打断"；一句都没说出口就把这条删掉
   */
  function keepSpoken(chatId: string, id: string, spoken: string) {
    const msg = find(chatId, id);
    if (!msg) return;
    const t = spoken.trim();
    if (!t) {
      const msgs = messages.value[chatId];
      if (msgs) messages.value[chatId] = msgs.filter((m) => m.id !== id);
      return;
    }
    // 其实已经说完了（打断在最后一句上）：原样留着
    const plain = (s: string) => s.replace(/[\s\p{P}]/gu, '');
    if (plain(t) === plain(msg.text) && !msg.meta.interrupted) return;
    const text = /[。！？!?…~～]$/.test(t) ? `${t}——` : `${t}……`;
    const parts: MessagePart[] = [{ type: 'text', text }];
    Object.assign(msg, { text, parts, updatedAt: Date.now(), swipes: [{ text, parts, expression: msg.expression, createdAt: Date.now() }], swipeIndex: 0 });
    Object.assign(msg.meta, { interrupted: undefined, error: undefined, errorDetail: undefined });
  }

  /** 删一条消息；正在生成的那条不删 */
  function deleteMessage(chatId: string, id: string) {
    if (streams[chatId]?.messageId === id) return;
    const msgs = messages.value[chatId];
    if (msgs) messages.value[chatId] = msgs.filter((m) => m.id !== id);
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
  /** 记进足迹的地点：在外面（不在家、也不在附近认得的地方）时不记 */
  function footprintId() {
    const id = yourPlace().id;
    return id === 'real:out' ? undefined : id;
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
      const youAt = how === 'bring' ? locationId : how === 'remote' ? footprintId() : undefined;
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
      Object.assign(part, { mode, title, summary, youAt: mode === 'remote' ? footprintId() : undefined });
    }
  }

  /**
   * 结束这件事（离开场景页时，或者场景自己做完时带上总结）。如果开始之后什么都没发生，就把开始那条也撤掉，她也回到原来的地方，不留痕迹。
   * 带她出门的，她总是回到自己的世界（回到出门前的地方）；连线的，她回到连线前的样子（有作息的之后照作息走）；去她那的，她留在原地。
   */
  function leaveScene(characterId: string, summary?: string) {
    const chat = chatOfCharacter(characterId);
    if (!chat?.togetherAt) return;
    // 不一起听了：歌停下，聊天里记一下听了哪几首
    if (chat.currentScene === 'music') {
      summary ??= musicSummary();
      stopMusic();
    }
    const character = useCharacterStore().byId(characterId);
    // 开始前她在哪、在做什么只记在内存里：上次没结束就关了 App 时不知道，当作哪儿都不在（有作息的会照作息放回去）
    const before = beforeVisit.get(characterId) ?? { locationId: null, status: '' };
    beforeVisit.delete(characterId);
    const how = chat.togetherMode ?? 'visit';
    const loc = getLocation(chat.togetherAt);
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    if (last && lastPart?.type === 'scene' && lastPart.event === 'enter' && last.parts.length === 1 && !summary) {
      messages.value[chat.id]?.pop();
      if (character) Object.assign(character, before);
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
      if (character && how === 'bring') Object.assign(character, { locationId: before.locationId, status: '刚从你那边回来' });
      else if (character && how === 'visit') character.status = '刚和你分开';
      else if (character) Object.assign(character, before);
    }
    chat.togetherAt = null;
    chat.togetherMode = null;
    chat.currentScene = null;
    // 活动进行中攒下的消息，结束以后再整理
    setTimeout(() => void maybeSummarize(chat.id), 0);
  }

  /**
   * 打开 App 时：场景只在场景页开着时才有，还记着场景的，是上次在场景页里直接关掉了 App（没走到"离开"），那件事算结束了。
   * 角色也读出来以后再调，她才能回到原来的样子
   */
  function endLeftoverScenes() {
    for (const c of chats.value) if (c.togetherAt) leaveScene(c.characterId);
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
    sceneReply,
    sceneJson,
    swipe,
    regenerate,
    editMessage,
    keepSpoken,
    deleteMessage,
    redraw,
    drawImage,
    recentLines,
    summarizing,
    summarizeNow,
    poke,
    postCard,
    enterScene,
    leaveScene,
    endLeftoverScenes,
    looking,
    lookingKeys,
    lookAt,
    sendPhotos,
    setTogetherMode,
    footprints,
  };
});
