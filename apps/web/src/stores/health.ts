import { buildHealthMessages, errorReport, errorText, samplerRequest, type HealthFill } from '@app/ai';
import {
  bmiOf,
  FIT_TIME_LABEL,
  MEAL_KEYS,
  MEAL_LABEL,
  parseHealthDay,
  parseHealthWeek,
  rhythmDate,
  shiftDate,
  weatherLine,
  weekdayOf,
  weekStartOf,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  type HealthDayPlan,
  type HealthSettings,
  type HealthWeekPlan,
  type ISODate,
  type Persona,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useEnvironmentStore } from './environment';
import { useHomeStore } from './home';
import { useLibraryStore } from './library';
import { usePersonaStore } from './personas';
import { useWeatherStore } from './weather';

/**
 * 健康计划（设计文档 §9.13）：按你人设里的健康设置，「健康计划」用「健康」预设排这周和今天的健身计划、饮食计划；
 * "健身"里照着今天的计划一个动作一个动作地练，练完的记录也记在这里（按人设，和哪个角色一起练的都算）。
 * 存在本机（settings 表的 health 一项）：最近 6 周的周计划、30 天的日计划、90 条运动记录。
 * 不在后台自己排：你打开健康计划、在"健身"里选"按照计划"时才排（没排过的那一份）。
 */

export type HealthResult<T> = { ok: true; value: T } | { ok: false; reason: string; detail?: string; notConnected?: boolean };

/** 一次运动的记录（"健身"结束时记） */
export interface WorkoutLog {
  id: string;
  personaId: string;
  characterId: string | null;
  /** 家务日（凌晨 4 点算起） */
  date: ISODate;
  startedAt: number;
  durationSec: number;
  mode: 'plan' | 'free';
  /** 随便动动的方式（跑步、跳绳……），照计划练的是计划的标题 */
  sport: string;
  plan?: { title: string; done: number; total: number };
  outdoor: boolean;
  distanceKm?: number;
  steps?: number;
  hrAvg?: number;
  hrMax?: number;
  kcal?: number;
  source: 'auto' | 'manual' | 'estimate';
}

interface Saved {
  weeks?: HealthWeekPlan[];
  days?: HealthDayPlan[];
  logs?: WorkoutLog[];
}

const KEEP_WEEKS = 6;
const KEEP_DAYS = 30;
const KEEP_LOGS = 90;

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** "11-12 跑步 25 分钟 · 3.1 公里 · 平均心率 142 · 约 260 千卡" */
export function workoutLine(l: WorkoutLog, withDate = true): string {
  const parts = [
    `${l.mode === 'plan' && l.plan ? `照计划练「${l.plan.title}」（做完 ${l.plan.done}/${l.plan.total} 个动作）` : l.sport} ${Math.max(1, Math.round(l.durationSec / 60))} 分钟`,
    l.distanceKm ? `${l.distanceKm.toFixed(2)} 公里` : '',
    l.steps ? `${l.steps} 步` : '',
    l.hrAvg ? `平均心率 ${l.hrAvg}${l.hrMax ? `，最高 ${l.hrMax}` : ''}` : '',
    l.kcal ? `约 ${l.kcal} 千卡` : '',
  ].filter(Boolean);
  return `${withDate ? `${l.date.slice(5)} ` : ''}${parts.join(' · ')}`;
}

export const useHealthStore = defineStore('health', () => {
  const weeks = ref<HealthWeekPlan[]>([]);
  const days = ref<HealthDayPlan[]>([]);
  const logs = ref<WorkoutLog[]>([]);
  /** 正在排（按人设） */
  const busy = reactive<Record<string, 'week' | 'day' | undefined>>({});
  /** 最近一次排失败的原因（只在内存里） */
  const errors = reactive<Record<string, { reason: string; detail?: string; notConnected?: boolean } | undefined>>({});

  const saver = autoSave('settings', () => [{ key: 'health', value: { weeks: weeks.value, days: days.value, logs: logs.value } }], () => [weeks.value, days.value, logs.value]);

  async function hydrate() {
    const saved = await getOne<Saved>('settings', 'health');
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.weeks)) weeks.value = saved.weeks.filter((w) => w && Array.isArray(w.days));
      if (Array.isArray(saved.days)) days.value = saved.days.filter((d) => d && d.meals && typeof d.date === 'string');
      if (Array.isArray(saved.logs)) logs.value = saved.logs.filter((l) => l && typeof l.durationSec === 'number');
    }
    saver.start();
  }

  function today(): ISODate {
    return useHomeStore().today || rhythmDate(new Date(), useEnvironmentStore().settings.timezone);
  }

  function weekOf(personaId: string, weekStart = weekStartOf(today())): HealthWeekPlan | undefined {
    return weeks.value.find((w) => w.personaId === personaId && w.weekStart === weekStart);
  }
  function dayOf(personaId: string, date = today()): HealthDayPlan | undefined {
    return days.value.find((d) => d.personaId === personaId && d.date === date);
  }
  function logsOf(personaId: string, sinceDate?: ISODate): WorkoutLog[] {
    return logs.value.filter((l) => l.personaId === personaId && (!sinceDate || l.date >= sinceDate)).sort((a, b) => b.startedAt - a.startedAt);
  }

  // —— 拼「健康」要的输入 ——

  function profileText(name: string, h: HealthSettings): string {
    const body = [h.heightCm ? `身高 ${h.heightCm} cm` : '', h.weightKg ? `体重 ${h.weightKg} kg` : '', bmiOf(h) ? `BMI ${bmiOf(h)}` : '', h.targetWeightKg ? `目标体重 ${h.targetWeightKg} kg` : '', h.age ? `${h.age} 岁` : '', h.sex ? (h.sex === 'male' ? '男' : '女') : '']
      .filter(Boolean)
      .join('，');
    return [`${name}：${body || '身高体重没填'}`, `目标：${h.goal.trim() || '没写（按保持健康、慢慢变好来排）'}`, h.note.trim() ? `身体情况：${h.note.trim()}` : ''].filter(Boolean).join('\n');
  }
  function timeText(h: HealthSettings): string {
    const week = WEEKDAY_ORDER.map((d) => `${WEEKDAY_LABEL[d]} ${h.weekMinutes[d] ? `${h.weekMinutes[d]} 分钟` : '不练'}`).join('、');
    return [`能接受的健身方式：${h.methods.join('、') || '没写（按在家就能做的来）'}`, `一周里每天能练多久：${week}`, `一般在${FIT_TIME_LABEL[h.timeOfDay]}练${h.timeOfDay === 'any' ? '（什么时候都行）' : ''}`, h.timeNote.trim() ? `补充：${h.timeNote.trim()}` : ''].filter(Boolean).join('\n');
  }
  function kitchenText(h: HealthSettings): string {
    const cook = MEAL_KEYS.map((k) => `${MEAL_LABEL[k]}${h.cookMinutes[k] ? ` ${h.cookMinutes[k]} 分钟` : '不自己做（食堂、外卖或在外面吃）'}`).join('；');
    return [`家里常有的食材：${h.ingredients.join('、') || '没写'}`, `忌口 / 过敏：${h.avoid.trim() || '没有'}`, `每顿能花多久做饭：${cook}`, `有的厨具：${h.tools.join('、') || '没写'}`].join('\n');
  }
  function todayText(date: ISODate): string {
    const wd = weekdayOf(date);
    const w = useWeatherStore().envInput(null).weather;
    return `今天：${date} ${WEEKDAY_LABEL[wd]}（${wd === 0 || wd === 6 ? '周末' : '工作日'}）${w ? ` · 天气：${weatherLine(w)}` : ''}`;
  }
  function weekText(plan: HealthWeekPlan | undefined, date: ISODate): string {
    if (!plan) return '';
    const wd = weekdayOf(date);
    const rows = plan.days.map((d) => `- ${WEEKDAY_LABEL[d.weekday]}：${d.rest ? '休息' : `${d.workout} ${d.minutes} 分钟`}${d.meals ? `；吃：${d.meals}` : ''}${d.weekday === wd ? '  ← 今天' : ''}`);
    return [`这周的计划（${plan.weekStart} 开始）${plan.focus ? `：${plan.focus}` : ''}`, ...rows].join('\n');
  }
  function recentText(personaId: string, date: ISODate): string {
    const since = shiftDate(date, -7);
    const ls = logsOf(personaId, since).filter((l) => l.date < date || l.date === date);
    const persona = usePersonaStore().byId(personaId);
    const cooked: string[] = [];
    if (persona) {
      const home = useHomeStore();
      for (const d of Object.values(home.history(personaId))) {
        if (d.date < since) continue;
        for (const [k, m] of Object.entries(d.marks)) {
          const chore = persona.housework?.chores.find((c) => k.startsWith(`${c.id}:`));
          if (chore?.kind === 'cooking' && m.status === 'done') cooked.push(`${d.date.slice(5)}${m.note ? ` ${m.note}` : ' 做了饭'}`);
        }
      }
    }
    return [ls.length ? `最近 7 天的运动：\n${ls.map((l) => `- ${workoutLine(l)}`).join('\n')}` : '最近 7 天没有运动记录', cooked.length ? `最近自己做的饭：${cooked.join('；')}` : ''].filter(Boolean).join('\n');
  }

  /** 调「健康计划」：按「健康」预设拼提示词，读回 JSON */
  async function call<T>(persona: Persona, task: 'plan-week' | 'plan-day', fills: Partial<Record<HealthFill, string>>, parse: (v: unknown) => T | null): Promise<HealthResult<{ value: T; model: string }>> {
    const ai = useAiStore();
    const status = ai.status('health');
    if (!status.live) return { ok: false, reason: `「健康计划」还没接通：${status.reason}`, notConnected: true };
    const preset = useLibraryStore().presetForUse('health');
    if (!preset) return { ok: false, reason: '没有健康预设：去"我的 → 预设 → 健康"导入或恢复一个' };
    try {
      const character = useCharacterStore().byId(useAppStore().activeCharacterId);
      const messages = buildHealthMessages({ task, userName: persona.name, characterName: character?.name, fills }, preset);
      const { value, result } = await ai.system.json('health', { messages, ...samplerRequest(preset.sampler) }, parse);
      return { ok: true, value: { value, model: result.model } };
    } catch (e) {
      return { ok: false, reason: errorText(e), detail: errorReport(e) };
    }
  }

  function base(persona: Persona): Partial<Record<HealthFill, string>> | null {
    const h = persona.health;
    if (!h?.enabled) return null;
    return { healthProfile: profileText(persona.name, h), healthTime: timeText(h), healthKitchen: kitchenText(h) };
  }

  /** 排这周（force：排过了也重新排） */
  async function planWeek(persona: Persona, opts: { force?: boolean } = {}): Promise<HealthResult<HealthWeekPlan>> {
    const date = today();
    const weekStart = weekStartOf(date);
    const have = weekOf(persona.id, weekStart);
    if (have && !opts.force) return { ok: true, value: have };
    const fills = base(persona);
    if (!fills) return { ok: false, reason: '健康系统还没打开：在"我的人设 → 健康"里打开' };
    if (busy[persona.id]) return { ok: false, reason: '正在排' };
    busy[persona.id] = 'week';
    try {
      const r = await call(persona, 'plan-week', {
        ...fills,
        healthToday: todayText(date),
        healthRecent: recentText(persona.id, date),
        healthAsk: `这次要排：这一周（${weekStart} 周一 到 ${shiftDate(weekStart, 6)} 周日）每天练什么、练多久，三餐的方向，这周要买的东西。今天是${WEEKDAY_LABEL[weekdayOf(date)]}，今天以前的几天照样写（当作参考）。`,
      }, parseHealthWeek);
      if (!r.ok) {
        errors[persona.id] = { reason: r.reason, detail: r.detail, notConnected: r.notConnected };
        return r;
      }
      const plan: HealthWeekPlan = { ...r.value.value, personaId: persona.id, weekStart, model: r.value.model, at: Date.now() };
      weeks.value = [plan, ...weeks.value.filter((w) => !(w.personaId === persona.id && w.weekStart === weekStart))].slice(0, KEEP_WEEKS * 4);
      delete errors[persona.id];
      return { ok: true, value: plan };
    } finally {
      delete busy[persona.id];
    }
  }

  /** 排今天：这周还没排就先排这周（today 照这周的计划来） */
  async function planDay(persona: Persona, opts: { force?: boolean } = {}): Promise<HealthResult<HealthDayPlan>> {
    const date = today();
    const have = dayOf(persona.id, date);
    if (have && !opts.force) return { ok: true, value: have };
    const fills = base(persona);
    if (!fills) return { ok: false, reason: '健康系统还没打开：在"我的人设 → 健康"里打开' };
    let week = weekOf(persona.id);
    if (!week) {
      const w = await planWeek(persona);
      if (!w.ok) return w;
      week = w.value;
    }
    if (busy[persona.id]) return { ok: false, reason: '正在排' };
    busy[persona.id] = 'day';
    try {
      const wd = weekdayOf(date);
      const planned = week.days.find((d) => d.weekday === wd);
      const minutes = persona.health?.weekMinutes[wd] ?? 0;
      const r = await call(persona, 'plan-day', {
        ...fills,
        healthToday: todayText(date),
        healthWeek: weekText(week, date),
        healthRecent: recentText(persona.id, date),
        healthAsk: `这次要排：今天（${date} ${WEEKDAY_LABEL[wd]}）的训练和三顿饭。这周的计划里今天是：${planned ? (planned.rest ? '休息' : `${planned.workout} ${planned.minutes} 分钟`) : '没写'}；设置里今天能练 ${minutes ? `${minutes} 分钟` : '0 分钟（不练）'}。`,
      }, parseHealthDay);
      if (!r.ok) {
        errors[persona.id] = { reason: r.reason, detail: r.detail, notConnected: r.notConnected };
        return r;
      }
      const plan: HealthDayPlan = { ...r.value.value, personaId: persona.id, date, model: r.value.model, at: Date.now() };
      days.value = [plan, ...days.value.filter((d) => !(d.personaId === persona.id && d.date === date))].slice(0, KEEP_DAYS * 2);
      delete errors[persona.id];
      return { ok: true, value: plan };
    } finally {
      delete busy[persona.id];
    }
  }

  function addLog(l: WorkoutLog) {
    logs.value = [clone(l), ...logs.value.filter((x) => x.id !== l.id)].slice(0, KEEP_LOGS);
  }
  function updateLog(id: string, patch: Partial<WorkoutLog>) {
    const l = logs.value.find((x) => x.id === id);
    if (l) Object.assign(l, patch);
  }

  return { weeks, days, logs, busy, errors, hydrate, today, weekOf, dayOf, logsOf, planWeek, planDay, addLog, updateLog };
});
