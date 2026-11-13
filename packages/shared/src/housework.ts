import { shiftDate } from './timezone.ts';
import type { ISODate } from './types/common.ts';
import type { ChoreDay, ChoreDef, ChoreEffect, ChoreKind, ChoreMark, ChoreWhen, HouseworkSettings } from './types/life.ts';

/**
 * 家务系统的算法部分（设计文档 §9.12）：今天要做哪几件、哪件过了时间、拖了几次、几天没做，
 * 以及发给模型的"家务"那几行。她怎么反应写在预设里（对话预设"家务：你怎么反应"、"共同的家"功能预设），这里只有数据。
 * 家务日和节律一样从凌晨 4 点算起：熬夜到一点刷牙，还算前一天的"睡前刷牙"。
 */

export const CHORE_WHEN: Record<ChoreWhen, { label: string; icon: string }> = {
  morning: { label: '早上', icon: 'i-lucide-sunrise' },
  noon: { label: '中午', icon: 'i-lucide-sun' },
  evening: { label: '晚上', icon: 'i-lucide-sunset' },
  bedtime: { label: '睡前', icon: 'i-lucide-moon' },
  any: { label: '随时', icon: 'i-lucide-clock' },
};
export const CHORE_WHEN_ORDER: ChoreWhen[] = ['morning', 'noon', 'evening', 'bedtime', 'any'];

export const CHORE_KINDS: Record<ChoreKind, { label: string; icon: string; effect: ChoreEffect }> = {
  hygiene: { label: '个人卫生', icon: 'i-lucide-shower-head', effect: 'disgust' },
  laundry: { label: '洗衣服', icon: 'i-lucide-washing-machine', effect: 'no-date' },
  cooking: { label: '做饭', icon: 'i-lucide-cooking-pot', effect: 'miss-food' },
  dishes: { label: '洗碗', icon: 'i-lucide-utensils', effect: 'nag' },
  cleaning: { label: '打扫', icon: 'i-lucide-brush-cleaning', effect: 'nag' },
  trash: { label: '倒垃圾', icon: 'i-lucide-trash-2', effect: 'nag' },
  tidy: { label: '收拾整理', icon: 'i-lucide-sofa', effect: 'nag' },
  other: { label: '其他', icon: 'i-lucide-sparkles', effect: 'nag' },
};

/** 设置页里的说明（发给模型的是 effectLine，她具体怎么做写在预设里） */
export const CHORE_EFFECTS: Record<ChoreEffect, { label: string; desc: string }> = {
  disgust: { label: '嫌弃', desc: '躲远一点、不让亲，催你快去' },
  'no-date': { label: '不跟你约会', desc: '约会、出门先拒绝：做完再说' },
  'miss-food': { label: '有点失落', desc: '说要是能吃到你亲手做的就好了' },
  nag: { label: '唠叨一句', desc: '轻轻提醒一下' },
  none: { label: '不在意', desc: '不提' },
  custom: { label: '自己写', desc: '写她会怎样' },
};

export const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 一周从周一排起 */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** "常用家务"：设置页一点就加 */
export const CHORE_TEMPLATES: Omit<ChoreDef, 'id' | 'addedAt'>[] = [
  { name: '刷牙', kind: 'hygiene', freq: 'daily', slots: ['morning', 'bedtime'], days: [], perWeek: 1, minutes: 3, effect: 'disgust', effectNote: '' },
  { name: '洗澡', kind: 'hygiene', freq: 'daily', slots: ['evening'], days: [], perWeek: 1, minutes: 15, effect: 'disgust', effectNote: '' },
  { name: '洗脸护肤', kind: 'hygiene', freq: 'daily', slots: ['morning', 'bedtime'], days: [], perWeek: 1, minutes: 5, effect: 'nag', effectNote: '' },
  { name: '做饭', kind: 'cooking', freq: 'daily', slots: ['evening'], days: [], perWeek: 1, minutes: 40, effect: 'miss-food', effectNote: '' },
  { name: '洗碗', kind: 'dishes', freq: 'daily', slots: ['evening'], days: [], perWeek: 1, minutes: 10, effect: 'nag', effectNote: '' },
  { name: '倒垃圾', kind: 'trash', freq: 'daily', slots: ['evening'], days: [], perWeek: 1, minutes: 3, effect: 'nag', effectNote: '' },
  { name: '洗衣服', kind: 'laundry', freq: 'weekly', slots: ['evening'], days: [3, 6], perWeek: 2, minutes: 20, effect: 'no-date', effectNote: '' },
  { name: '扫地拖地', kind: 'cleaning', freq: 'weekly', slots: ['any'], days: [], perWeek: 2, minutes: 20, effect: 'nag', effectNote: '' },
  { name: '换床单', kind: 'cleaning', freq: 'weekly', slots: ['any'], days: [0], perWeek: 1, minutes: 15, effect: 'nag', effectNote: '' },
  { name: '收拾房间', kind: 'tidy', freq: 'weekly', slots: ['any'], days: [], perWeek: 1, minutes: 30, effect: 'nag', effectNote: '' },
  { name: '浇花', kind: 'other', freq: 'weekly', slots: ['morning'], days: [1, 4], perWeek: 2, minutes: 5, effect: 'none', effectNote: '' },
];

export const DEFAULT_HOUSEWORK: HouseworkSettings = { enabled: false, chores: [] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** 读进来的家务（旧数据、导入的）补齐字段 */
export function normalizeChore(raw: unknown, fallbackId: string): ChoreDef | null {
  if (!isObj(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 30) : '';
  if (!name) return null;
  const kind = (typeof raw.kind === 'string' && raw.kind in CHORE_KINDS ? raw.kind : 'other') as ChoreKind;
  const freq = raw.freq === 'weekly' ? 'weekly' : 'daily';
  const slots = (Array.isArray(raw.slots) ? raw.slots : []).filter((s): s is ChoreWhen => typeof s === 'string' && s in CHORE_WHEN);
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const effect = (typeof raw.effect === 'string' && raw.effect in CHORE_EFFECTS ? raw.effect : CHORE_KINDS[kind].effect) as ChoreEffect;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name,
    kind,
    freq,
    slots: slots.length ? [...new Set(slots)].sort((a, b) => CHORE_WHEN_ORDER.indexOf(a) - CHORE_WHEN_ORDER.indexOf(b)) : ['any'],
    days,
    perWeek: intIn(raw.perWeek, 1, 7, Math.max(1, days.length)),
    minutes: intIn(raw.minutes, 1, 240, 15),
    effect,
    effectNote: typeof raw.effectNote === 'string' ? raw.effectNote.slice(0, 80) : '',
    addedAt: typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0,
  };
}

export function normalizeHousework(raw: unknown): HouseworkSettings {
  if (!isObj(raw)) return { ...DEFAULT_HOUSEWORK, chores: [] };
  const list = Array.isArray(raw.chores) ? raw.chores : [];
  const chores = list.map((c, i) => normalizeChore(c, `chore-${i + 1}`)).filter((c): c is ChoreDef => !!c);
  // id 撞了（手改过数据）：后面的换一个
  const seen = new Set<string>();
  for (const c of chores) {
    while (seen.has(c.id)) c.id = `${c.id}-x`;
    seen.add(c.id);
  }
  return { enabled: raw.enabled === true, chores };
}

// —— 日期 ——

/** 这一天是周几（0 周日） */
export function weekdayOf(date: ISODate): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
/** 这一天所在那周的周一 */
export function weekStartOf(date: ISODate): ISODate {
  return shiftDate(date, -((weekdayOf(date) + 6) % 7));
}
/** 两个日期差几天（b - a） */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** "周三、周六" / "每周 2 次" */
export function choreSchedule(c: Pick<ChoreDef, 'freq' | 'slots' | 'days' | 'perWeek'>): string {
  if (c.freq === 'daily') return c.slots.map((s) => CHORE_WHEN[s].label).join('、');
  if (c.days.length === 7) return '每天';
  if (c.days.length) return WEEKDAY_ORDER.filter((d) => c.days.includes(d)).map((d) => WEEKDAY_LABEL[d]).join('、');
  return `每周 ${c.perWeek} 次`;
}

// —— 一天里的时间 ——

/** 睡觉时间在中午以前（例如 00:30）算第二天凌晨 */
function sleepOf(sleepMin: number): number {
  return sleepMin < 720 ? sleepMin + 1440 : sleepMin;
}

/** 这一次最晚什么时候做完（从家务日 0 点算的分钟；过了半夜的大于 1440） */
export function slotDeadline(slot: ChoreWhen, sleepMin: number): number {
  const sleep = sleepOf(sleepMin);
  if (slot === 'morning') return 11 * 60;
  if (slot === 'noon') return 14 * 60;
  if (slot === 'evening') return Math.min(22 * 60, sleep);
  return sleep;
}

/** 这一次从什么时候开始算"该做了"（之前提了也是"还没到时候"） */
export function slotOpens(slot: ChoreWhen, sleepMin: number): number {
  if (slot === 'noon') return 10 * 60 + 30;
  if (slot === 'evening') return 17 * 60;
  if (slot === 'bedtime') return Math.max(20 * 60, sleepOf(sleepMin) - 180);
  return 4 * 60;
}

// —— 今天的清单 ——

export interface ChoreItem {
  /** 记录的 key：`${id}:${slot}`（每天的）/ `${id}:w`（每周的） */
  key: string;
  chore: ChoreDef;
  slot: ChoreWhen;
  /** "刷牙 · 早上" / "洗衣服" */
  label: string;
  /** "早上" / "周三、周六" / "这周还差 1 次" / "周三的，拖到了今天" */
  when: string;
  mark: ChoreMark;
  /** 过了该做的时间还没做 */
  overdue: boolean;
  /** 还没到该做的时候 */
  early: boolean;
  dueMin: number;
  /** 每周哪天都行的：这周做了几次、要几次 */
  week?: { done: number; need: number };
  /** 每周固定日子的：是哪天的没做，拖到了今天 */
  carriedFrom?: ISODate;
  /** 今天之前最近一次做完是哪天、是几天前 */
  lastDone: ISODate | null;
  sinceDone: number | null;
  /** 今天之前连着几天没做（每天的；从加上这件家务算起） */
  missedDays: number;
}

export interface ChoreDayInput {
  settings: HouseworkSettings;
  /** 今天（家务日） */
  date: ISODate;
  /** 现在是这个家务日 0 点后第几分钟（凌晨 4 点前算前一天，所以会大于 1440）；算过去的某一天时传 Infinity */
  nowMin: number;
  /** 你的睡觉时间（"环境与作息"，分钟） */
  sleepMin: number;
  /** 最近的记录（含今天） */
  history: Record<ISODate, ChoreDay | undefined>;
}

const EMPTY: ChoreMark = { status: 'todo' };

/** 这件家务是哪个家务日加上的（之前的日子不算"没做"）；凌晨 4 点前加的算前一天，同家务日 */
function addedDate(c: ChoreDef, today: ISODate): ISODate {
  if (!c.addedAt) return shiftDate(today, -60);
  const d = new Date(c.addedAt - 4 * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 这件家务在这一天有没有做完（任意一次） */
function doneOn(history: ChoreDayInput['history'], c: ChoreDef, date: ISODate): boolean {
  const marks = history[date]?.marks;
  if (!marks) return false;
  const prefix = `${c.id}:`;
  return Object.entries(marks).some(([k, m]) => k.startsWith(prefix) && m.status === 'done');
}

function lastDoneBefore(history: ChoreDayInput['history'], c: ChoreDef, date: ISODate): ISODate | null {
  let best: ISODate | null = null;
  for (const d of Object.keys(history)) if (d < date && (!best || d > best) && doneOn(history, c, d)) best = d;
  return best;
}

/** 今天要做的家务（还没开的系统返回空）。按什么时候该做排好 */
export function choreItems(input: ChoreDayInput): ChoreItem[] {
  const { settings, date, nowMin, sleepMin, history } = input;
  if (!settings.enabled) return [];
  const weekday = weekdayOf(date);
  const today = history[date]?.marks ?? {};
  const out: ChoreItem[] = [];
  for (const c of settings.chores) {
    const since = addedDate(c, date);
    if (since > date) continue;
    const lastDone = lastDoneBefore(history, c, date);
    const base = { chore: c, lastDone, sinceDone: lastDone ? daysBetween(lastDone, date) : null };
    if (c.freq === 'daily') {
      let missed = 0;
      for (let d = shiftDate(date, -1); d >= since && !doneOn(history, c, d) && missed < 60; d = shiftDate(d, -1)) missed += 1;
      for (const slot of c.slots) {
        const key = `${c.id}:${slot}`;
        const mark = today[key] ?? EMPTY;
        const dueMin = slotDeadline(slot, sleepMin);
        out.push({
          ...base,
          key,
          slot,
          label: c.slots.length > 1 ? `${c.name} · ${CHORE_WHEN[slot].label}` : c.name,
          when: CHORE_WHEN[slot].label,
          mark,
          overdue: mark.status !== 'done' && nowMin >= dueMin,
          early: mark.status === 'todo' && nowMin < slotOpens(slot, sleepMin),
          dueMin,
          missedDays: missed,
        });
      }
      continue;
    }
    const slot = c.slots[0] ?? 'any';
    const key = `${c.id}:w`;
    const mark = today[key] ?? EMPTY;
    const dueMin = slotDeadline(slot, sleepMin);
    if (c.days.length) {
      // 固定日子：今天就是那天，或者最近那天没做、一直拖到今天
      let due: ISODate | null = null;
      for (let i = 0; i < 7; i += 1) {
        const d = shiftDate(date, -i);
        if (d < since) break;
        if (c.days.includes(weekdayOf(d))) {
          due = d;
          break;
        }
      }
      if (!due) continue;
      // 拖到今天的：那天以后（不含今天）做过了就不再列
      let doneSince = false;
      for (let d = due; d < date; d = shiftDate(d, 1)) if (doneOn(history, c, d)) doneSince = true;
      if (due !== date && doneSince) continue;
      const carried = due !== date ? due : undefined;
      out.push({
        ...base,
        key,
        slot,
        label: c.name,
        when: carried ? `${WEEKDAY_LABEL[weekdayOf(carried)]}的，拖到了今天` : choreSchedule(c),
        mark,
        overdue: mark.status !== 'done' && (!!carried || nowMin >= dueMin),
        early: !carried && mark.status === 'todo' && nowMin < slotOpens(slot, sleepMin),
        dueMin,
        ...(carried ? { carriedFrom: carried } : {}),
        missedDays: 0,
      });
      continue;
    }
    // 哪天都行：这周还没做够就每天都列出来；今天做过的也留着（打了勾的）
    const start = weekStartOf(date);
    let done = 0;
    for (let d = start; d < date; d = shiftDate(d, 1)) if (doneOn(history, c, d)) done += 1;
    const doneToday = mark.status === 'done';
    if (done >= c.perWeek && !doneToday) continue;
    const left = 7 - ((weekday + 6) % 7);
    const need = c.perWeek;
    // 剩下的天数不够了：今天过了时间就算"过了时间"
    const urgent = need - done >= left;
    out.push({
      ...base,
      key,
      slot,
      label: c.name,
      when: doneToday ? `这周第 ${done + 1} 次` : `这周还差 ${need - done} 次`,
      mark,
      overdue: !doneToday && urgent && nowMin >= dueMin,
      early: false,
      dueMin,
      week: { done: done + (doneToday ? 1 : 0), need },
      missedDays: 0,
    });
  }
  return out.sort((a, b) => a.dueMin - b.dueMin || a.chore.name.localeCompare(b.chore.name));
}

/** 最近几天（不含今天）的完成情况：做完几件、没做几件、拖得最多的 */
export function choreRecent(input: Omit<ChoreDayInput, 'nowMin'>, days = 7): { done: number; missed: number; laterMost: { name: string; times: number } | null } {
  let done = 0;
  let missed = 0;
  const later = new Map<string, number>();
  for (let i = 1; i <= days; i += 1) {
    const date = shiftDate(input.date, -i);
    const items = choreItems({ ...input, date, nowMin: Number.POSITIVE_INFINITY });
    for (const it of items) {
      if (it.mark.status === 'done') done += 1;
      else if (!it.week) missed += 1;
      if (it.mark.later) later.set(it.chore.name, (later.get(it.chore.name) ?? 0) + it.mark.later);
    }
  }
  const top = [...later.entries()].sort((a, b) => b[1] - a[1])[0];
  return { done, missed, laterMost: top ? { name: top[0], times: top[1] } : null };
}

/** 没做的时候她会怎样（写进提示词的那几个字；具体怎么做在预设里） */
export function effectLine(c: Pick<ChoreDef, 'effect' | 'effectNote'>, userName: string): string {
  const note = c.effectNote.trim();
  switch (c.effect) {
    case 'disgust':
      return note ? `嫌弃（${note}）` : '嫌弃';
    case 'no-date':
      return `不跟${userName}约会、出门${note ? `（${note}）` : ''}`;
    case 'miss-food':
      return `有点失落，想吃${userName}亲手做的${note ? `（最想吃：${note}）` : ''}`;
    case 'nag':
      return note ? `唠叨一句（${note}）` : '唠叨一句';
    case 'custom':
      return note;
    default:
      return '';
  }
}

function clockOf(at: number | undefined, timeZone?: string): string {
  if (!at) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return '';
  }
}

/** 一件家务现在的情况："做完了（07:42）" / "还没做，已经 2 天没做了" / "拖了 2 次还没做" */
export function choreStateText(it: ChoreItem, timeZone?: string): string {
  const m = it.mark;
  if (m.status === 'done') {
    const at = clockOf(m.doneAt, timeZone);
    const spent = m.spentSec ? `，做了 ${Math.max(1, Math.round(m.spentSec / 60))} 分钟` : '';
    return `做完了${at ? `（${at}${spent}）` : spent ? `（${spent.slice(1)}）` : ''}${m.later ? `，之前拖了 ${m.later} 次` : ''}`;
  }
  const parts: string[] = [];
  if (m.status === 'doing') parts.push('正在做');
  else if (m.status === 'later') parts.push(`说了晚点做（拖了 ${m.later ?? 1} 次）`);
  else if (it.carriedFrom) parts.push(`${WEEKDAY_LABEL[weekdayOf(it.carriedFrom)]}该做的没做，拖到了今天`);
  else if (it.overdue) parts.push('过了时间还没做');
  else if (it.early) parts.push('还没到时候');
  else parts.push('还没做');
  if (it.missedDays === 1) parts.push('昨天也没做');
  else if (it.missedDays > 1) parts.push(`之前已经 ${it.missedDays} 天没做了`);
  if (it.chore.freq === 'weekly' && it.sinceDone !== null && !it.week) parts.push(it.sinceDone === 1 ? '上次做是昨天' : `上次做是 ${it.sinceDone} 天前`);
  return parts.join('，');
}

/**
 * 发给模型的"家务"几行（这一块的内容，程序按你在"共同的家"里勾的填）。
 * 没做、拖着的才写"没做时：…"（她怎么反应），还没到时候的不写，免得中午就催睡前刷牙。
 */
export function formatChoreBlock(opts: {
  userName: string;
  items: ChoreItem[];
  recent?: ReturnType<typeof choreRecent> | null;
  nowText: string;
  timeZone?: string;
}): string {
  const { userName, items } = opts;
  if (!items.length) return `【家务】${userName}今天没有要做的家务（截至 ${opts.nowText}）。`;
  const lines = items.map((it) => {
    const extra = it.chore.freq === 'weekly' ? `（${it.week ? `每周 ${it.week.need} 次，这周做了 ${it.week.done} 次` : choreSchedule(it.chore)}）` : '';
    const label = it.chore.freq === 'daily' ? it.label : `${it.label}${extra}`;
    const pending = it.mark.status !== 'done' && (it.overdue || it.mark.status === 'later' || it.missedDays > 0);
    const effect = pending ? effectLine(it.chore, userName) : '';
    return `- ${label}：${choreStateText(it, opts.timeZone)}${effect ? `｜没做时：${effect}` : ''}`;
  });
  const done = items.filter((it) => it.mark.status === 'done').length;
  const r = opts.recent;
  const recent = r && r.done + r.missed > 0 ? `最近 7 天：做完 ${r.done} 件，没做 ${r.missed} 件${r.laterMost ? `；拖得最多的是${r.laterMost.name}（${r.laterMost.times} 次）` : ''}。` : '';
  return [
    `【家务】${userName}今天的家务（截至 ${opts.nowText}，做完 ${done} / ${items.length}；是${userName}在"共同的家"里勾的，没勾的就是还没做）：`,
    ...lines,
    recent,
  ]
    .filter(Boolean)
    .join('\n');
}
