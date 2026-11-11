import type { Character, ProactivePersonality } from './types/character.ts';
import type { HHMM, ISODate } from './types/common.ts';
import type { ProactiveRule, ProactiveTriggerId, Touchpoint } from './types/proactive.ts';
import type { EnvironmentSettings } from './types/settings.ts';

/**
 * 每个角色一天的主动消息计划（"先排期、再触发"）。
 * 按这个角色自己的设置排：开没开、性格（频率）、允许哪些触发器、勿扰时段、允许来电（没有条数上限）；
 * 再加上全局的触发规则（开关、时段、概率）和你的作息（起床、三餐、睡觉）。
 * 同一天、同一个角色排出来的总是同一份（时间的偏移和概率都按 日期 + 角色 + 规则 算），
 * 所以 App 每次打开重新排也对得上；以后 Worker 用同一个函数排，结果一样。
 * 天气变化、运动夸夸、学习打卡、纪念日由事件触发，不按时间排。
 */

export interface ProactivePlanInput {
  character: Pick<Character, 'id' | 'proactive'>;
  rules: ProactiveRule[];
  env: Pick<EnvironmentSettings, 'wakeTime' | 'sleepTime' | 'meals'>;
  /** 排哪一天（当天任意时刻） */
  day: Date;
  /** 这个角色记着的待跟进的事（到期时间在这一天的会排进去） */
  followups?: { id: string; content: string; dueAt: number }[];
}

/** 按时间排的触发器（其余由事件触发） */
export const TIMED_TRIGGERS: ProactiveTriggerId[] = ['wake-call', 'morning', 'breakfast', 'lunch', 'dinner', 'sedentary', 'miss-you', 'bedtime', 'followup'];

/** 性格决定频率：粘人的更常来，独立的只在重要时刻 */
const PERSONALITY_FACTOR: Record<ProactivePersonality, number> = { clingy: 1.2, balanced: 1, independent: 0.7 };
const PERSONALITY_LABEL: Record<ProactivePersonality, string> = { clingy: '粘人', balanced: '适中', independent: '独立' };

/** 这一次要她做什么（给写主动消息的模型看，计划页也显示这句）；{{user}} 是你的名字 */
export const PROACTIVE_HINTS: Partial<Record<ProactiveTriggerId, string>> = {
  'wake-call': '打电话叫{{user}}起床',
  morning: '跟{{user}}说早安，可以顺带提一句今天的天气',
  breakfast: '早饭时间：问问{{user}}吃早饭没有',
  lunch: '午饭时间：暗示{{user}}该吃饭了，别直接说',
  dinner: '晚饭时间："我有点饿了……你吃了吗？"这样的口吻',
  sedentary: '{{user}}可能坐了很久：拉{{user}}起来走走、喝口水',
  'miss-you': '有一阵没聊了：说想{{user}}了，或者分享身边的一件小事',
  bedtime: '过了睡觉时间：催{{user}}去睡觉',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-11"：本地日期 */
export function dateKey(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "07:30" → 450 */
export function minutesOf(t: HHMM): number {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** 一天里的第几分钟落在 [start, end) 里（可以跨过半夜，例如 23:00–02:00） */
export function inWindow(minute: number, start: HHMM, end: HHMM): boolean {
  const s = minutesOf(start);
  const e = minutesOf(end);
  const m = ((minute % 1440) + 1440) % 1440;
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** 字符串 → [0, 1) 的固定随机数（FNV-1a） */
export function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** 把时刻挪进规则的时段里（时段跨半夜时按离得近的一端） */
function clampToWindow(minute: number, rule: ProactiveRule | undefined): number {
  const w = rule?.window;
  if (!w || inWindow(minute, w.start, w.end)) return minute;
  const s = minutesOf(w.start);
  const e = minutesOf(w.end) - 1;
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));
  return dist(minute, s) <= dist(minute, e) ? s : e;
}

function hhmmOf(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

interface Draft {
  ruleId: ProactiveTriggerId;
  key: string;
  /** 从这一天 0 点算起的分钟（睡觉时间过了半夜时会超过 1440） */
  minute: number;
  action: Touchpoint['action'];
  hint: string;
}

export function planTouchpoints(input: ProactivePlanInput): Touchpoint[] {
  const { character: c, env } = input;
  const p = c.proactive;
  const date = dateKey(input.day);
  const dayStart = new Date(input.day);
  dayStart.setHours(0, 0, 0, 0);
  const base = dayStart.getTime();
  const rules = new Map(input.rules.map((r) => [r.id, r]));
  const allowed = new Set(p.triggers);
  const on = (id: ProactiveTriggerId) => allowed.has(id) && rules.get(id)?.enabled === true;
  const jitter = (id: string) => hashUnit(`${date}|${c.id}|${id}|t`);
  const meal = (slot: 'breakfast' | 'lunch' | 'dinner', from: number, span: number) => {
    const w = env.meals[slot];
    const s = minutesOf(w.start);
    const len = Math.max(30, (minutesOf(w.end) - s + 1440) % 1440);
    return Math.round(s + (from + span * jitter(slot)) * len);
  };

  const wake = minutesOf(env.wakeTime);
  const sleepAt = minutesOf(env.sleepTime);
  // 睡觉时间在中午以前（例如 00:30）算这一天的夜里，也就是第二天凌晨
  const sleep = sleepAt < 720 ? sleepAt + 1440 : sleepAt;
  const drafts: Draft[] = [];
  const add = (ruleId: ProactiveTriggerId, minute: number, action: Touchpoint['action'] = 'message', hint = PROACTIVE_HINTS[ruleId] ?? '', key: string = ruleId) => {
    // 时段只管一天里的钟点：跨到第二天凌晨的保留"第二天"
    const day = Math.floor(minute / 1440) * 1440;
    drafts.push({ ruleId, key, minute: day + clampToWindow(minute - day, rules.get(ruleId)), action, hint });
  };

  if (on('wake-call') && p.allowCalls) add('wake-call', wake, 'call');
  if (on('morning')) add('morning', wake + 8 + Math.round(17 * jitter('morning')));
  if (on('breakfast')) add('breakfast', meal('breakfast', 0.35, 0.3));
  if (on('lunch')) add('lunch', meal('lunch', 0.3, 0.3));
  if (on('dinner')) add('dinner', meal('dinner', 0.3, 0.3));
  if (on('sedentary')) add('sedentary', 14 * 60 + 30 + Math.round(120 * jitter('sedentary')));
  if (on('miss-you')) add('miss-you', 20 * 60 + 30 + Math.round(90 * jitter('miss-you')));
  if (on('bedtime')) add('bedtime', sleep + 10 + Math.round(10 * jitter('bedtime')), p.allowCalls ? 'call' : 'message', p.allowCalls ? '过了睡觉时间还没睡：打电话催{{user}}睡觉' : undefined);
  if (on('followup')) {
    for (const f of input.followups ?? []) {
      const minute = Math.round((f.dueAt - base) / 60_000);
      if (minute < 0 || minute >= 1440) continue;
      add('followup', minute, 'message', `{{user}}之前提过的事到时间了，问问结果：${f.content}`, `followup:${f.id}`);
    }
  }

  drafts.sort((a, b) => a.minute - b.minute);
  // 没有条数上限：来几次只看打开了哪些时段和性格（粘人的每个时段几乎都来，独立的随缘）
  const factor = PERSONALITY_FACTOR[p.personality] ?? 1;
  const reason = new Map<Draft, string>();
  const lucky: { d: Draft; miss: number }[] = [];
  for (const d of drafts) {
    if (inWindow(d.minute, p.quietHours.start, p.quietHours.end) && d.ruleId !== 'wake-call') {
      reason.set(d, `勿扰时段（${p.quietHours.start}–${p.quietHours.end}）`);
      continue;
    }
    const chance = Math.min(1, (rules.get(d.ruleId)?.probability ?? 1) * factor);
    const roll = hashUnit(`${date}|${c.id}|${d.key}|p`);
    if (roll >= chance) {
      reason.set(d, `按「${PERSONALITY_LABEL[p.personality] ?? '适中'}」的频率，这个时段今天不来`);
      lucky.push({ d, miss: roll - chance });
    }
  }
  // 打开了主动消息，一天里至少来一次：都被频率抽掉时，留下差得最少的那条
  if (!drafts.some((d) => !reason.has(d)) && lucky.length) {
    reason.delete(lucky.sort((a, b) => a.miss - b.miss)[0]!.d);
  }
  return drafts.map((d): Touchpoint => {
    const skipReason = reason.get(d);
    return {
      id: `${date}:${c.id}:${d.key}`,
      createdAt: base,
      updatedAt: base,
      characterId: c.id,
      ruleId: d.ruleId,
      date,
      dueAt: base + d.minute * 60_000,
      action: d.action,
      hint: d.hint,
      status: skipReason ? 'skipped' : 'planned',
      ...(skipReason ? { skipReason } : {}),
    };
  });
}

/** "07:42"：计划里的时刻（过了半夜的显示成"次日 00:40"） */
export function touchpointClock(t: Pick<Touchpoint, 'dueAt' | 'date'>): string {
  const d = new Date(t.dueAt);
  const label = hhmmOf(d.getHours() * 60 + d.getMinutes());
  return dateKey(d) === t.date ? label : `次日 ${label}`;
}
