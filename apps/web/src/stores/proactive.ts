import {
  dateKey,
  DEFAULT_PROACTIVE_RULES,
  FREE_SCENE,
  hashUnit,
  parseControlTags,
  planTouchpoints,
  PROACTIVE_HINTS,
  substituteMacros,
  type Character,
  type Chat,
  type Message,
  type MessagePart,
  type Touchpoint,
} from '@app/shared';
import { AiError, errorText, isAbortError } from '@app/ai';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { autoSave, getOne, write } from '@/db/idb';
import { memories } from '@/mock/memories';
import { DEMO_PROACTIVE, GENERIC_PROACTIVE } from '@/mock/proactive';
import { envSettings } from '@/mock/settings';
import { services } from '@/services';
import { assembleForChat, personaOf, toLLMMessages } from '@/services/prompt';
import { hhmm } from '@/utils/time';

/**
 * 主动消息（设计文档 §3.2 的"先排期、再触发"，现在先在本机跑）：
 * - 每个打开了主动消息的角色，按自己的设置排今天的计划（packages/shared/src/proactive.ts）；
 * - App 开着时每分钟看一次，到点的发出去：接通了"主动消息"的 API 就由模型按她的预设和聊天记录用她的口吻写，
 *   没接通时演示角色用各自的演示台词，导入的角色跳过（没有能代替她说话的台词）；
 * - 你 20 分钟内刚和她聊过、她正在回你时不打扰；App 关着时到点的，3 小时内打开会补上最近的一条，更早的算错过
 *   （Worker 接上以后由它准点发）。没有条数上限。
 * 每条计划发没发、为什么没发记在本机，主动消息页里能看到。
 */

export interface ProactiveLogEntry {
  status: 'fired' | 'skipped';
  at: number;
  reason?: string;
  messageId?: string;
  model?: string;
  /** 因为"主动消息"还没接通 API 才没发：之后接通了（还在补发时限里）就补发 */
  retry?: boolean;
}

export type PlannedTouchpoint = Touchpoint & { log?: ProactiveLogEntry };

export type FireResult = { ok: true; message?: Message } | { ok: false; reason: string; error?: unknown };

/** 打开 App 时，多久以内到点的还补发（每个角色补最近的一条）；更早的算错过 */
const CATCH_UP_MS = 3 * 60 * 60_000;
/** 你这么久以内刚和她说过话，就不打扰 */
const RECENT_CHAT_MS = 20 * 60_000;
/** 主动消息里能用的标签：表情、配图（允许自拍时）、分享歌曲 */
const TAGS = FREE_SCENE.allowedTags.filter((k) => k === 'expr' || k === 'cg' || k === 'music');

export const useProactiveStore = defineStore('proactive', () => {
  const rules = DEFAULT_PROACTIVE_RULES;
  const log = reactive<Record<string, ProactiveLogEntry>>({});
  /** 正在写主动消息的角色 */
  const writing = reactive<Record<string, boolean>>({});
  /** 每分钟走一次：计划页、"今天还会找你几次"跟着刷新 */
  const clock = ref(Date.now());

  /** 演示角色的聊天每次打开重新生成，它们的发送记录也不存（不然记录说发了、聊天里却没有） */
  function persistedLog(): Record<string, ProactiveLogEntry> {
    const chars = useCharacterStore();
    const keep = new Set([0, 1, 2].map((d) => dateKey(new Date(Date.now() - d * 86_400_000))));
    const out: Record<string, ProactiveLogEntry> = {};
    for (const [id, e] of Object.entries(log)) {
      const [date, characterId] = id.split(':');
      if (date && keep.has(date) && characterId && !chars.isDemo(characterId)) out[id] = { ...e };
    }
    return out;
  }

  const saver = autoSave('settings', () => [{ key: 'proactiveLog', value: persistedLog() }], () => ({ ...log }));

  async function hydrate() {
    const [savedLog, migrated] = await Promise.all([getOne<Record<string, ProactiveLogEntry>>('settings', 'proactiveLog'), getOne<boolean>('settings', 'proactiveImportedOn')]);
    if (savedLog && typeof savedLog === 'object') {
      for (const [id, e] of Object.entries(savedLog)) if (e && (e.status === 'fired' || e.status === 'skipped')) log[id] = e;
    }
    if (!migrated) {
      // 以前导入的角色默认关着主动消息，那时 App 里也没有真的发主动消息的逻辑：打开一次，之后按你在主动消息页里的设置来
      const chars = useCharacterStore();
      for (const c of chars.list) if (!chars.isDemo(c.id) && !c.proactive.enabled) c.proactive.enabled = true;
      await write('settings', [{ key: 'proactiveImportedOn', value: true }]);
    }
    saver.start();
  }

  function note(id: string, status: ProactiveLogEntry['status'], reason?: string, extra: Partial<ProactiveLogEntry> = {}) {
    if (id.startsWith('sim:')) return;
    log[id] = { status, at: Date.now(), ...(reason ? { reason } : {}), ...extra };
  }

  /** 她记着的待跟进的事（到期那天会来问） */
  function followupsOf(characterId: string) {
    return memories
      .filter((m) => m.characterId === characterId && m.type === 'followup' && m.status === 'active' && m.dueAt)
      .map((m) => ({ id: m.id, content: m.content, dueAt: m.dueAt as number }));
  }

  /** 这个角色某一天的计划，带上发没发的记录 */
  function planFor(characterId: string, day: Date = new Date(clock.value)): PlannedTouchpoint[] {
    const c = useCharacterStore().byId(characterId);
    if (!c) return [];
    return planTouchpoints({ character: c, rules, env: envSettings, day, followups: followupsOf(c.id) }).map((t) => (log[t.id] ? { ...t, log: log[t.id] } : t));
  }

  /** 今天还会来找你几次（不给角色时是所有打开了主动消息的角色加起来） */
  function upcoming(characterId?: string): number {
    const now = clock.value;
    const chars = useCharacterStore();
    const list = characterId ? [chars.byId(characterId)].filter((c) => !!c) : chars.list;
    return list.filter((c) => c.proactive.enabled).reduce((n, c) => n + planFor(c.id).filter((t) => t.status === 'planned' && !t.log && t.dueAt > now).length, 0);
  }

  function demoLine(c: Character, t: Pick<Touchpoint, 'id' | 'ruleId'>) {
    const table = DEMO_PROACTIVE[c.id];
    const lines = table?.[t.ruleId] ?? table?.['miss-you'] ?? [GENERIC_PROACTIVE];
    const line = lines[Math.floor(hashUnit(t.id) * lines.length)] ?? GENERIC_PROACTIVE;
    return { parts: [{ type: 'text', text: line.text }] as MessagePart[], expression: line.expr, meta: {} as Message['meta'] };
  }

  /** 接通了"主动消息"的 API：按她的预设、角色卡、世界书、记忆和聊天记录，用她的口吻写 */
  async function writeWithModel(c: Character, ch: Chat, t: Pick<Touchpoint, 'hint'>) {
    const chat = useChatStore();
    const persona = personaOf(ch);
    const task = substituteMacros(t.hint, { char: c.name, user: persona.name });
    const quiet = `【主动消息】现在是 ${hhmm(Date.now())}，${persona.name}还没有来找你。这一次要做的事：${task}。\n以${c.name}的身份主动给${persona.name}发消息：像发微信一样，一到两句，口语，可以用表情标签；不要提到这条说明。`;
    const prompt = assembleForChat(ch, c, chat.list(ch.id), { type: 'quiet', dryRun: true, quiet, agent: 'proactive' });
    const r = await services.llm.chat({
      agent: 'proactive',
      messages: toLLMMessages(prompt),
      body: prompt.request,
      characterId: c.id,
      names: { user: persona.name, char: c.name },
    });
    const parsed = parseControlTags(r.text, TAGS.filter((k) => k !== 'cg' || c.proactive.allowSelfies));
    const text = parsed.visible.trim();
    const parts: MessagePart[] = text ? [{ type: 'text', text }] : [];
    let expression: string | null = null;
    for (const { tag } of parsed.tags) {
      if (tag.kind === 'expr') expression = tag.value;
      if (tag.kind === 'cg') parts.push({ type: 'image', assetKey: null, caption: tag.value, generated: false });
      if (tag.kind === 'music') parts.push({ type: 'music', songId: 's1', title: tag.title, artist: tag.artist });
    }
    if (!parts.length) throw new AiError('empty', '模型回了一条空消息');
    const meta: Message['meta'] = { model: r.model, agent: 'proactive', latencyMs: r.latencyMs, tokens: r.tokens, ...(r.fellBack ? { fellBack: true } : {}) };
    return { parts, expression, meta };
  }

  /**
   * 发一条计划。force：手动模拟（不看"刚聊过"、导入的角色没接 API 时用占位台词）
   */
  async function fire(c: Character, t: Touchpoint, opts: { force?: boolean } = {}): Promise<FireResult> {
    const chat = useChatStore();
    const ai = useAiStore();
    const app = useAppStore();
    const chars = useCharacterStore();
    const skip = (reason: string): FireResult => {
      note(t.id, 'skipped', reason);
      return { ok: false, reason };
    };
    const ch = chat.chatOfCharacter(c.id);
    if (!ch) return skip(`还没有和${c.name}的聊天`);
    if (writing[c.id]) return { ok: false, reason: `${c.name}正在写上一条` };
    if (!opts.force) {
      // 她正在回你：下一分钟再看（不记录）
      if (chat.streams[ch.id]) return { ok: false, reason: `${c.name}正在回你` };
      const lastUser = [...chat.list(ch.id)].reverse().find((m) => m.role === 'user');
      if (lastUser && Date.now() - lastUser.createdAt < RECENT_CHAT_MS) return skip(`你 20 分钟内刚和${c.name}聊过`);
    }
    if (t.action === 'call') {
      if (!c.proactive.allowCalls && !opts.force) return skip('没有允许主动来电');
      app.showBanner({ characterId: c.id, title: `${c.name} 邀请你语音通话`, text: '点这里接听', to: `/call/${c.id}?incoming=1`, icon: 'i-lucide-phone-incoming' }, 15_000);
      note(t.id, 'fired', '来电');
      return { ok: true };
    }
    const live = ai.isLive('proactive');
    if (!live && !chars.isDemo(c.id) && !opts.force) {
      const reason = '「主动消息」还没接通 API（导入的角色没有演示台词）；3 小时内接通会补发';
      note(t.id, 'skipped', reason, { retry: true });
      return { ok: false, reason };
    }
    writing[c.id] = true;
    try {
      const out = live ? await writeWithModel(c, ch, t) : demoLine(c, t);
      const viewing = app.viewingChatId === ch.id;
      const msg = chat.push(ch.id, 'assistant', out.parts, { proactive: true, read: viewing, expression: out.expression, meta: out.meta });
      if (out.expression) chars.setExpression(c.id, out.expression);
      for (const p of msg.parts) if (p.type === 'image') chat.redraw(ch.id, p);
      if (!viewing) app.showBanner({ characterId: c.id, title: c.name, text: msg.text || '[图片]', to: `/chat/${ch.id}`, icon: 'i-lucide-bell-ring' });
      note(t.id, 'fired', live ? undefined : '演示台词', { messageId: msg.id, ...(out.meta.model ? { model: out.meta.model } : {}) });
      return { ok: true, message: msg };
    } catch (e) {
      if (isAbortError(e)) return { ok: false, reason: '取消了' };
      const reason = `没写出来：${errorText(e)}`;
      note(t.id, 'skipped', `${reason}（完整报错在 API 设置 → 主动消息）`);
      return { ok: false, reason, error: e };
    } finally {
      delete writing[c.id];
    }
  }

  /** 一个角色到点的计划：计划里就不发的记下原因，太久以前的算错过，剩下的只发最近的一条 */
  async function runFor(c: Character) {
    const now = Date.now();
    const live = useAiStore().isLive('proactive');
    const open = (t: PlannedTouchpoint) => !t.log || (t.log.retry === true && live);
    const due = [...planFor(c.id, new Date(now - 86_400_000)), ...planFor(c.id, new Date(now))].filter((t) => t.dueAt <= now && open(t)).sort((a, b) => a.dueAt - b.dueAt);
    const fresh: PlannedTouchpoint[] = [];
    for (const t of due) {
      if (t.status === 'skipped') note(t.id, 'skipped', t.skipReason);
      else if (now - t.dueAt > CATCH_UP_MS) note(t.id, 'skipped', t.log?.retry ? '「主动消息」那时还没接通 API（导入的角色没有演示台词）' : '那时 App 没开着，错过了');
      else fresh.push(t);
    }
    const latest = fresh.pop();
    for (const t of fresh) note(t.id, 'skipped', '和后面那条一起到点，只发了最近的');
    if (latest) await fire(c, latest);
  }

  let ticking = false;
  async function tick() {
    clock.value = Date.now();
    if (ticking) return;
    ticking = true;
    try {
      for (const c of [...useCharacterStore().list]) if (c.proactive.enabled) await runFor(c);
    } finally {
      ticking = false;
    }
  }

  /** "我的 → 试一试 → 模拟一条主动消息"：马上让她发一条（"想你了"） */
  function simulate(characterId: string): Promise<FireResult> {
    const c = useCharacterStore().byId(characterId);
    if (!c) return Promise.resolve({ ok: false, reason: '找不到这个角色' });
    const now = Date.now();
    const t: Touchpoint = {
      id: `sim:${c.id}:${now}`,
      createdAt: now,
      updatedAt: now,
      characterId: c.id,
      ruleId: 'miss-you',
      date: dateKey(new Date(now)),
      dueAt: now,
      action: 'message',
      hint: PROACTIVE_HINTS['miss-you'] ?? '',
      status: 'planned',
    };
    return fire(c, t, { force: true });
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  /** 读完本机数据、界面挂好以后开始：先看一次，之后每分钟、切回前台时再看 */
  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void tick();
    });
  }

  return { rules, log, writing, clock, hydrate, planFor, upcoming, tick, simulate, start };
});
