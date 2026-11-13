import {
  zonedDateKey,
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
import { useMemoryStore } from './memory';
import { DEMO_PROACTIVE, GENERIC_PROACTIVE } from '@/mock/proactive';
import { useEnvironmentStore } from './environment';
import { useHubStore } from './hub';
import { services } from '@/services';
import { assembleForChat, personaOf, storeRegex, toLLMMessages } from '@/services/prompt';

/** 自动排期、检测和生成由 Cloudflare 执行；本机仅展示计划和手动试一试。 */

export interface ProactiveLogEntry {
  status: 'fired' | 'skipped';
  at: number;
  reason?: string;
  messageId?: string;
}

export type PlannedTouchpoint = Touchpoint & { log?: ProactiveLogEntry; synced: boolean; previousSchedule?: boolean };

export type FireResult = { ok: true; message?: Message } | { ok: false; reason: string; error?: unknown };

/** 主动消息里能用的标签：表情、配图（允许自拍时）、分享歌曲 */
const TAGS = FREE_SCENE.allowedTags.filter((k) => k === 'expr' || k === 'cg' || k === 'music');

export const useProactiveStore = defineStore('proactive', () => {
  const rules = DEFAULT_PROACTIVE_RULES;
  /** 正在写主动消息的角色 */
  const writing = reactive<Record<string, boolean>>({});
  /** 每分钟走一次：计划页、"今天还会找你几次"跟着刷新 */
  const clock = ref(Date.now());

  /** 她记着的待跟进的事（到期那天会来问） */
  function followupsOf(characterId: string) {
    return useMemoryStore()
      .activeOf(characterId)
      .filter((m) => m.type === 'followup' && m.dueAt)
      .map((m) => ({ id: m.id, content: m.content, dueAt: m.dueAt as number }));
  }

  /** 这个角色某一天的计划，带上发没发的记录 */
  function planFor(characterId: string, day: Date = new Date(clock.value)): PlannedTouchpoint[] {
    const c = useCharacterStore().byId(characterId);
    if (!c) return [];
    const env = useEnvironmentStore().settings;
    const cloud = new Map(useHubStore().points.map((t) => [t.id, t]));
    return planTouchpoints({ character: c, rules, env, day, followups: followupsOf(c.id) }).map((t) => {
      const remote = cloud.get(t.id);
      if (!remote) return { ...t, synced: false };
      const reason = remote.lastError || remote.pushError || remote.skipReason;
      const status = ['fired', 'delivered', 'opened'].includes(remote.status) ? 'fired' : remote.status === 'skipped' ? 'skipped' : null;
      // 同步返回旧时区的未发送计划时，先展示当前设置的计划；已发送记录仍然保留。
      const matches = remote.dueAt === t.dueAt && remote.timezone === env.timezone;
      if (status !== 'fired' && !matches) return { ...t, synced: false };
      return { ...remote, synced: true, previousSchedule: !matches, ...(status ? { log: { status, at: remote.updatedAt, reason, messageId: remote.messageId } as ProactiveLogEntry } : {}) };
    });
  }

  /** 今天还会来找你几次（不给角色时是所有打开了主动消息的角色加起来） */
  function upcoming(characterId?: string): number {
    const now = clock.value;
    const chars = useCharacterStore();
    const list = characterId ? [chars.byId(characterId)].filter((c) => !!c) : chars.list;
    return list.filter((c) => c.proactive.enabled).reduce((n, c) => n + planFor(c.id).filter((t) => t.synced && t.status === 'planned' && !t.log && t.dueAt > now).length, 0);
  }

  function demoLine(c: Character, t: Pick<Touchpoint, 'id' | 'ruleId'>) {
    const table = DEMO_PROACTIVE[c.id];
    const lines = table?.[t.ruleId] ?? table?.['miss-you'] ?? [GENERIC_PROACTIVE];
    const line = lines[Math.floor(hashUnit(t.id) * lines.length)] ?? GENERIC_PROACTIVE;
    return { parts: [{ type: 'text', text: line.text }] as MessagePart[], expression: line.expr, meta: {} as Message['meta'] };
  }

  /**
   * 接通了"主动消息"的 API：按"主动消息"预设（或跟随她的对话预设）、角色卡、世界书、记忆和聊天记录，用她的口吻写。
   * 程序只告诉她现在几点、这一次要做什么；怎么写（长短、口吻）由预设里的块说
   */
  async function writeWithModel(c: Character, ch: Chat, t: Pick<Touchpoint, 'hint'>) {
    const chat = useChatStore();
    const persona = personaOf(ch);
    const now = new Date();
    const timeZone = useEnvironmentStore().settings.timezone;
    const macros = { char: c.name, user: persona.name, now, timeZone };
    const hint = substituteMacros(t.hint, macros);
    const time = substituteMacros('{{isodate}} {{time}}', macros);
    const quiet = `【主动消息】现在是 ${time}（${timeZone}），${persona.name}还没有来找你，由${c.name}先开口。这一次要做的事：${hint}。`;
    const prompt = assembleForChat(ch, c, chat.list(ch.id), { type: 'quiet', dryRun: true, quiet, agent: 'proactive', now });
    const r = await services.llm.chat({
      agent: 'proactive',
      messages: toLLMMessages(prompt),
      body: prompt.request,
      characterId: c.id,
      names: { user: persona.name, char: c.name },
    });
    // 预设里改存下来的消息的正则（作用在"她的回复"上的），同聊天里的回复
    const parsed = parseControlTags(storeRegex(ch, c, r.text, 'assistant', { preset: prompt.preset }), TAGS.filter((k) => k !== 'cg' || c.proactive.allowSelfies));
    const text = parsed.visible.trim();
    const parts: MessagePart[] = text ? [{ type: 'text', text }] : [];
    let expression: string | null = null;
    for (const { tag } of parsed.tags) {
      if (tag.kind === 'expr') expression = tag.value;
      if (tag.kind === 'cg') parts.push({ type: 'image', assetKey: null, caption: tag.value, generated: false });
      if (tag.kind === 'music') parts.push({ type: 'music', songId: '', title: tag.title, artist: tag.artist });
    }
    if (!parts.length) throw new AiError('empty', '模型回了一条空消息');
    chat.lastPrompt[ch.id] = { prompt, at: Date.now() };
    const meta: Message['meta'] = { model: r.model, agent: 'proactive', latencyMs: r.latencyMs, tokens: r.tokens, ...(r.fellBack ? { fellBack: true } : {}) };
    return { parts, expression, meta };
  }

  /** 手动「试一试」；自动任务只能由云端执行。 */
  async function fireManual(c: Character, t: Touchpoint): Promise<FireResult> {
    const chat = useChatStore();
    const ai = useAiStore();
    const app = useAppStore();
    const chars = useCharacterStore();
    const ch = chat.chatOfCharacter(c.id);
    if (!ch) return { ok: false, reason: `还没有和${c.name}的聊天` };
    if (writing[c.id]) return { ok: false, reason: `${c.name}正在写上一条` };
    const live = ai.isLive('proactive');
    writing[c.id] = true;
    try {
      const out = live ? await writeWithModel(c, ch, t) : demoLine(c, t);
      const viewing = app.viewingChatId === ch.id;
      const msg = chat.push(ch.id, 'assistant', out.parts, { proactive: true, read: viewing, expression: out.expression, meta: out.meta });
      if (out.expression) chars.setExpression(c.id, out.expression);
      for (const p of msg.parts) if (p.type === 'image') chat.redraw(ch.id, p);
      if (!viewing) app.showBanner({ characterId: c.id, title: c.name, text: msg.text || '[图片]', to: `/chat/${ch.id}`, icon: 'i-lucide-bell-ring' });
      return { ok: true, message: msg };
    } catch (e) {
      if (isAbortError(e)) return { ok: false, reason: '取消了' };
      const reason = `没写出来：${errorText(e)}`;
      return { ok: false, reason, error: e };
    } finally {
      delete writing[c.id];
    }
  }

  function tick() {
    clock.value = Date.now();
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
      date: zonedDateKey(now, useEnvironmentStore().settings.timezone),
      timezone: useEnvironmentStore().settings.timezone,
      dueAt: now,
      action: 'message',
      hint: PROACTIVE_HINTS['miss-you'] ?? '',
      status: 'planned',
    };
    return fireManual(c, t);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  /** 只刷新计划展示的时钟；不会触发模型或补发消息。 */
  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void tick();
    });
  }

  return { rules, writing, clock, planFor, upcoming, tick, simulate, start };
});
