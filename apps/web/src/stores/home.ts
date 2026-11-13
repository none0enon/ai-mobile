import {
  choreItems,
  choreRecent,
  DEFAULT_HOUSEWORK,
  normalizeExtra,
  rhythmDate,
  shiftDate,
  toMinutes,
  zonedDateKey,
  zonedParts,
  type ChoreDay,
  type ChoreItem,
  type ChoreMark,
  type ExtraChore,
  type ISODate,
  type Persona,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { useEnvironmentStore } from './environment';

/**
 * 共同的家：你每天的家务做了没有（设计文档 §9.12）。按人设分开记（家务系统挂在人设上），一天一份，存在本机（settings 表的 home:chores 一项），
 * 留最近 60 天：她知道你"已经三天没洗澡了"、这周洗了几次衣服、最常拖的是哪件。
 * 家务日和节律一样从凌晨 4 点算起（"环境与作息"里的时区）。
 * 你勾的是唯一的来源：没勾的就当还没做（提示词里也这么写），她不会知道你没在 App 里记的事。
 * 某一天还可以有临时的事（extra）：健康计划排今天时把要提前做的饭发过来（重新排就换成新的，做过的记录留着）。
 */

const KEEP_DAYS = 60;

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export const useHomeStore = defineStore('home', () => {
  /** `${人设 id}:${日期}` → 那天的记录 */
  const days = reactive<Record<string, ChoreDay>>({});
  /** 现在（每 5 分钟、回到 App、点了做完 / 晚点做时更新：过了时间没做的跟着变） */
  const now = ref(Date.now());
  const today = ref(rhythmDate(new Date(), useEnvironmentStore().settings.timezone));

  const saver = autoSave('settings', () => [{ key: 'home:chores', value: Object.values(days) }], () => days);

  async function hydrate() {
    const saved = await getOne<ChoreDay[]>('settings', 'home:chores');
    const oldest = shiftDate(today.value, -KEEP_DAYS);
    for (const d of Array.isArray(saved) ? saved : []) {
      if (!d || typeof d.personaId !== 'string' || typeof d.date !== 'string' || d.date < oldest || !d.marks || typeof d.marks !== 'object') continue;
      const extra = Array.isArray(d.extra) ? d.extra.map(normalizeExtra).filter((x): x is ExtraChore => !!x) : [];
      days[`${d.personaId}:${d.date}`] = { personaId: d.personaId, date: d.date, marks: d.marks, ...(extra.length ? { extra } : {}) };
    }
    saver.start();
  }

  function tick() {
    now.value = Date.now();
    today.value = rhythmDate(new Date(now.value), useEnvironmentStore().settings.timezone);
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  function start() {
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 5 * 60_000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
  }

  /** 现在是今天这个家务日 0 点后第几分钟（凌晨 4 点前还算前一天，所以会大于 1440） */
  function nowMin(): number {
    const tz = useEnvironmentStore().settings.timezone;
    const t = now.value;
    const p = zonedParts(t, tz);
    const min = p.hour * 60 + p.minute;
    return zonedDateKey(t, tz) === today.value ? min : min + 1440;
  }

  function sleepMin(): number {
    return toMinutes(useEnvironmentStore().settings.sleepTime) ?? 24 * 60;
  }

  /** 这个人设最近的记录：日期 → 那天 */
  function history(personaId: string): Record<ISODate, ChoreDay> {
    const out: Record<ISODate, ChoreDay> = {};
    for (const d of Object.values(days)) if (d.personaId === personaId) out[d.date] = d;
    return out;
  }

  /** 今天的清单（没开家务系统时是空的） */
  function itemsFor(persona: Persona): ChoreItem[] {
    void now.value;
    return choreItems({ settings: persona.housework ?? DEFAULT_HOUSEWORK, date: today.value, nowMin: nowMin(), sleepMin: sleepMin(), history: history(persona.id) });
  }

  /** 最近 7 天（不含今天）做完几件、没做几件、拖得最多的 */
  function recentFor(persona: Persona) {
    return choreRecent({ settings: persona.housework ?? DEFAULT_HOUSEWORK, date: today.value, sleepMin: sleepMin(), history: history(persona.id) });
  }

  /** 今天这件的记录（没有就建一个） */
  function markOf(personaId: string, key: string): ChoreMark {
    const k = `${personaId}:${today.value}`;
    const day = (days[k] ??= { personaId, date: today.value, marks: {} });
    return (day.marks[key] ??= { status: 'todo' });
  }

  /** 正在做的那件（同一时间只做一件） */
  function doingOf(persona: Persona): ChoreItem | null {
    return itemsFor(persona).find((it) => it.mark.status === 'doing') ?? null;
  }

  /** 开始做：别的正在做的那件放回去（算没做完） */
  function start_(persona: Persona, key: string) {
    tick();
    for (const it of itemsFor(persona)) {
      if (it.key !== key && it.mark.status === 'doing') Object.assign(markOf(persona.id, it.key), { status: 'todo', startedAt: undefined });
    }
    Object.assign(markOf(persona.id, key), { status: 'doing', startedAt: Date.now() });
  }

  /** 做完了：开始过的记下做了多久 */
  function finish(persona: Persona, key: string, note?: string): ChoreMark {
    tick();
    const m = markOf(persona.id, key);
    const t = Date.now();
    const spentSec = m.status === 'doing' && m.startedAt ? Math.max(1, Math.round((t - m.startedAt) / 1000)) : undefined;
    Object.assign(m, { status: 'done', doneAt: t, spentSec, startedAt: undefined, ...(note ? { note } : {}) });
    return clone(m);
  }

  /** 晚点再做（拖一次） */
  function postpone(persona: Persona, key: string): ChoreMark {
    tick();
    const m = markOf(persona.id, key);
    Object.assign(m, { status: 'later', later: (m.later ?? 0) + 1, laterAt: Date.now(), startedAt: undefined });
    return clone(m);
  }

  /**
   * 健康计划发来某一天要提前做的饭：换掉这一天之前从健康计划发来的（重新排了），同一件（同一个 id）做过的记录留着
   */
  function setExtras(personaId: string, date: ISODate, list: ExtraChore[]) {
    const k = `${personaId}:${date}`;
    const day = (days[k] ??= { personaId, date, marks: {} });
    const keep = (day.extra ?? []).filter((x) => x.source !== 'health');
    const next = [...keep, ...list.map((x) => clone(x))];
    if (next.length) day.extra = next;
    else delete day.extra;
  }

  /** 这一天临时的事 */
  function extrasOf(personaId: string, date: ISODate = today.value): ExtraChore[] {
    return days[`${personaId}:${date}`]?.extra ?? [];
  }

  /** 某一天某件事的记录（没有是 undefined） */
  function markOn(personaId: string, date: ISODate, key: string): ChoreMark | undefined {
    return days[`${personaId}:${date}`]?.marks[key];
  }

  /** 改回没做（勾错了） */
  function undo(persona: Persona, key: string) {
    const m = markOf(persona.id, key);
    Object.assign(m, { status: m.later ? 'later' : 'todo', doneAt: undefined, spentSec: undefined, startedAt: undefined });
  }

  return { days, today, now, hydrate, start, tick, nowMin, history, itemsFor, recentFor, doingOf, startChore: start_, finish, postpone, undo, setExtras, extrasOf, markOn };
});
