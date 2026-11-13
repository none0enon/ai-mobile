import { buildHealthMessages, errorReport, errorText, samplerRequest, type HealthFill } from '@app/ai';
import {
  bmiOf,
  FIT_TIME_LABEL,
  MEAL_KEYS,
  MEAL_LABEL,
  parseHealthDay,
  parseHealthWeek,
  parseShopping,
  rhythmDate,
  shiftDate,
  weatherLine,
  weekdayOf,
  weekStartOf,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  type HealthDayPlan,
  type HealthSettings,
  type HealthTask,
  type HealthWeekPlan,
  type ExtraChore,
  type ISODate,
  type MealSpot,
  type Persona,
  type PrepTask,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { services } from '@/services';
import { distanceText } from '@/services/maps';
import type { FoodPlace, GroceryStore } from '@/services/types';
import { countryAt, onlineShopsText, placeMentioned, samePlaceName } from '@/utils/shopping';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useEnvironmentStore } from './environment';
import { useHomeStore } from './home';
import { useLibraryStore } from './library';
import { usePersonaStore } from './personas';
import { useRealWorldStore } from './realworld';
import { useWeatherStore } from './weather';

/**
 * 健康计划（设计文档 §9.13）：按你人设里的健康设置，「健康计划」用「健康」预设排这周和今天的健身计划、饮食计划；
 * "健身"里照着今天的计划一个动作一个动作地练，练完的记录也记在这里（按人设，和哪个角色一起练的都算）。
 * 存在本机（settings 表的 health 一项）：最近 6 周的周计划、30 天的日计划、90 条运动记录。
 * 不在后台自己排：你打开健康计划、在"健身"里选"按照计划"时才排（没排过的那一份）。
 * 接了 Google 地图（健康设置里没关"参考附近的店"）时，排之前先搜附近能吃饭的地方和超市（缓存一天）：
 * 外食只从这些真实的店里挑，要买的东西按这些超市和你那里能用的网店（美国：Amazon、Kroger、Walmart……）真能买到的写。
 * 发给模型的是店名、种类、距离、价位、评分、营业时间，不发地址和坐标。
 * 做饭时间是 0 的那顿可以带提前做好的便当：排今天时写出今天要提前做的事（prep），开了家务系统就发到今天的家务里
 * （"共同的家"能开始、打勾、拖），每件带没来得及做的备案；第二天排计划时看昨天那件做没做，没做就照备案。
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

/** 要提前做的事在家务里的 id：同名的同一件（重新排时做过的记录留着） */
function prepId(name: string): string {
  let h = 5381;
  for (const ch of name.trim()) h = ((h << 5) + h + ch.codePointAt(0)!) >>> 0;
  return `hp-${h.toString(36)}`;
}

/** 要提前做的事发到家务里时用的那一件 */
export function prepExtra(t: PrepTask): ExtraChore {
  return {
    id: prepId(t.name),
    name: t.name,
    kind: 'cooking',
    slot: t.when,
    minutes: t.minutes,
    source: 'health',
    ...(t.meal ? { meal: t.meal } : {}),
    ...(t.steps.length ? { steps: t.steps } : {}),
    ...(t.backup ? { backup: t.backup } : {}),
    ...(t.backupSpot ? { backupSpot: t.backupSpot } : {}),
  };
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
      // 以前存的"要买的东西"是一行一行的文字：读成现在的格式（名字、多少、在哪买、搜什么）
      if (Array.isArray(saved.weeks)) weeks.value = saved.weeks.filter((w) => w && Array.isArray(w.days)).map((w) => ({ ...w, shopping: parseShopping(w.shopping) }));
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
    const zero = h.bento === 'off' ? ' 0 分钟（这顿不做饭，外食）' : ' 0 分钟（这顿不做饭：外食，或者吃提前做好带去的）';
    const cook = MEAL_KEYS.map((k) => `${MEAL_LABEL[k]}${h.cookMinutes[k] ? ` ${h.cookMinutes[k]} 分钟` : zero}`).join('；');
    const bento = h.bento === 'off' ? '不带' : h.bento === 'cold' ? '能带，但带去了热不了（挑凉着也好吃的）' : '能带，带去了能用微波炉热';
    return [
      `家里常有的食材：${h.ingredients.join('、') || '没写'}`,
      `忌口 / 过敏：${h.avoid.trim() || '没有'}`,
      `每顿能花多久做饭：${cook}`,
      MEAL_KEYS.some((k) => !h.cookMinutes[k]) ? `带便当：${bento}` : '',
      `有的厨具：${h.tools.join('、') || '没写'}`,
    ]
      .filter(Boolean)
      .join('\n');
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
    // 昨天排的饭：昨晚顺手备了今天的便当，今天就吃那份
    const y = dayOf(personaId, shiftDate(date, -1));
    const yMeals = y
      ? (['breakfast', 'lunch', 'dinner', 'snack'] as const)
          .map((k) => {
            const m = y.meals[k];
            if (!m) return '';
            const how = m.bento ? '（吃提前做好的）' : !m.cook && m.place ? `（在${m.place}吃）` : '';
            return `${MEAL_LABEL[k]} ${m.name}${how}`;
          })
          .filter(Boolean)
      : [];
    // 昨天要提前做的（便当、隔夜燕麦）：家务里勾了没有；没开家务系统的不知道做没做
    const yd = shiftDate(date, -1);
    const home = useHomeStore();
    const published = home.extrasOf(personaId, yd).filter((x) => x.source === 'health');
    const yPrep = published.length
      ? published.map((x) => {
          const done = home.markOn(personaId, yd, `extra:${x.id}`)?.status === 'done';
          return `- ${x.name}${x.meal ? `（给${x.meal}）` : ''}：${done ? '做了' : `没做（在家务里没勾）${x.backup ? `，备案：${x.backup}` : ''}`}`;
        })
      : (y?.prep ?? []).map((t) => `- ${t.name}${t.meal ? `（给${t.meal}）` : ''}：不知道做没做（没开家务系统）${t.backup ? `，备案：${t.backup}` : ''}`);
    return [
      ls.length ? `最近 7 天的运动：\n${ls.map((l) => `- ${workoutLine(l)}`).join('\n')}` : '最近 7 天没有运动记录',
      cooked.length ? `最近自己做的饭：${cooked.join('；')}` : '',
      yMeals.length ? `昨天排的饭：${yMeals.join('；')}` : '',
      yPrep.length ? `昨天要提前做的：\n${yPrep.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // —— 附近能吃的、能买的（接了 Google 地图时） ——

  interface Nearby {
    /** 给「健康」的那一块（没有时是空的，这一块就不发） */
    text: string;
    food: FoodPlace[];
    stores: GroceryStore[];
    country?: string;
    /** 计划下面的一句：参考了附近哪些店，或者为什么没参考 */
    near: string;
  }

  function placeLine(p: FoodPlace, hours?: string): string {
    const serves = [p.breakfast ? '早饭' : '', p.lunch ? '午饭' : '', p.dinner ? '晚饭' : ''].filter(Boolean);
    const bits = [
      distanceText(p.distanceKm),
      p.price ? '$'.repeat(p.price) : '',
      p.rating ? `${p.rating.toFixed(1)} 分${p.ratings ? `（${p.ratings} 条评价）` : ''}` : '',
      // Google 给的是"星期一: 10:30–21:00"：去掉星期几
      hours ? `今天 ${hours.replace(/^[^:：]*[:：]\s*/, '')}` : '',
      serves.length ? `有${serves.join('、')}` : '',
      [p.takeout ? '能外带' : '', p.delivery ? '能外送' : '', p.vegetarian ? '有素食' : ''].filter(Boolean).join('、'),
      p.summary ? `"${p.summary}"` : '',
    ].filter(Boolean);
    return `${p.name}（${p.type}）· ${bits.join(' · ')}`;
  }

  function spotOf(p: { name: string; type?: string; distanceKm?: number; mapsUri?: string }): MealSpot {
    return { name: p.name, ...(p.type ? { type: p.type } : {}), ...(typeof p.distanceKm === 'number' ? { distanceKm: p.distanceKm } : {}), ...(p.mapsUri ? { mapsUri: p.mapsUri } : {}) };
  }

  /**
   * 排计划前搜附近：排今天时你出门了（打开 App 时定位到不在家）按你现在在的地方，不然按家。
   * 没接 Google 地图、健康设置里关了时什么都不做（这一块不发，外食照旧写怎么选）
   */
  async function nearbyFor(persona: Persona, task: HealthTask, date: ISODate): Promise<Nearby> {
    const none = (near = '', country?: string): Nearby => ({ text: '', food: [], stores: [], near, ...(country ? { country } : {}) });
    if (persona.health?.nearby === false) return none();
    const real = useRealWorldStore();
    if (!real.mapsReady) return none();
    const here = real.here;
    const useHere = !!here && (!real.homeGeo || (task === 'plan-day' && !real.atHome));
    const center = useHere ? here : real.homeGeo;
    if (!center) return none('附近的店没查：家的地址还没换成坐标（在"我的世界"里填家的地址，或者打开定位）');
    const label = useHere ? '你现在在的地方附近' : '家附近';
    const country = countryAt(useHere ? real.hereCountry : real.homeGeo?.countryCode, center);
    const at = { lat: center.lat, lng: center.lng };
    const [f, g] = await Promise.allSettled([services.maps.food(at), services.maps.groceries(at)]);
    const food = f.status === 'fulfilled' ? f.value.slice(0, 20) : [];
    const stores = g.status === 'fulfilled' ? g.value : [];
    const failed = [f, g].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    const why = failed ? errorText(failed.reason) : '';
    if (!food.length && !stores.length) return none(why ? `附近的店没查到：${why}` : `${label}没搜到能吃饭的地方和超市`, country);
    // Google 的营业时间从周一排起
    const hoursAt = (weekdayOf(date) + 6) % 7;
    const online = onlineShopsText(country, stores);
    const text = [
      `下面是 Google 地图上${label}真实的店。外食只从"能吃饭的地方"里挑；要买的东西写这些超市${online ? '和网店' : ''}里真能买到的商品和规格。`,
      food.length
        ? `能吃饭的地方（按距离）：\n${food.map((p) => `- ${placeLine(p, task === 'plan-day' ? p.hours?.[hoursAt] : undefined)}`).join('\n')}`
        : '能吃饭的地方：没搜到（外食照旧写在食堂、外卖、外面怎么选）',
      stores.length ? `附近的超市：\n${stores.map((x) => `- ${x.name}（${x.type}）· ${distanceText(x.distanceKm)}`).join('\n')}` : '',
      online ? `网购：${online}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const counts = [food.length ? `${food.length} 家能吃饭的地方` : '', stores.length ? `${stores.length} 家超市` : ''].filter(Boolean).join('、');
    return { text, food, stores, ...(country ? { country } : {}), near: `参考了${label} ${counts}${why ? `（有一项没查到：${why}）` : ''}` };
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
      const nearby = await nearbyFor(persona, 'plan-week', date);
      const r = await call(persona, 'plan-week', {
        ...fills,
        healthNearby: nearby.text,
        healthToday: todayText(date),
        healthRecent: recentText(persona.id, date),
        healthAsk: `这次要排：这一周（${weekStart} 周一 到 ${shiftDate(weekStart, 6)} 周日）每天练什么、练多久，三餐的方向，这周要买的东西。今天是${WEEKDAY_LABEL[weekdayOf(date)]}，今天以前的几天照样写（当作参考）。`,
      }, parseHealthWeek);
      if (!r.ok) {
        errors[persona.id] = { reason: r.reason, detail: r.detail, notConnected: r.notConnected };
        return r;
      }
      const plan: HealthWeekPlan = {
        ...r.value.value,
        personaId: persona.id,
        weekStart,
        ...(nearby.stores.length ? { stores: nearby.stores.map(spotOf) } : {}),
        ...(nearby.country ? { country: nearby.country } : {}),
        ...(nearby.near ? { near: nearby.near } : {}),
        model: r.value.model,
        at: Date.now(),
      };
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
      const nearby = await nearbyFor(persona, 'plan-day', date);
      const r = await call(persona, 'plan-day', {
        ...fills,
        healthNearby: nearby.text,
        healthToday: todayText(date),
        healthWeek: weekText(week, date),
        healthRecent: recentText(persona.id, date),
        healthAsk: `这次要排：今天（${date} ${WEEKDAY_LABEL[wd]}）的训练和三顿饭。这周的计划里今天是：${planned ? (planned.rest ? '休息' : `${planned.workout} ${planned.minutes} 分钟`) : '没写'}；设置里今天能练 ${minutes ? `${minutes} 分钟` : '0 分钟（不练）'}。`,
      }, parseHealthDay);
      if (!r.ok) {
        errors[persona.id] = { reason: r.reason, detail: r.detail, notConnected: r.notConnected };
        return r;
      }
      // 外食的那家对上附近搜到的店：带上种类、距离、地图链接（对不上的不带，界面上写明）；备案里提到的店也对上
      const value = r.value.value;
      for (const m of Object.values(value.meals)) {
        if (!m) continue;
        const hit = !m.cook && m.place ? nearby.food.find((p) => samePlaceName(p.name, m.place!)) : undefined;
        if (hit) m.spot = spotOf(hit);
        const alt = placeMentioned(m.backup, nearby.food);
        if (alt) m.backupSpot = spotOf(alt);
      }
      for (const t of value.prep ?? []) {
        const alt = placeMentioned(t.backup, nearby.food);
        if (alt) t.backupSpot = spotOf(alt);
      }
      const plan: HealthDayPlan = { ...value, personaId: persona.id, date, ...(nearby.near ? { near: nearby.near } : {}), model: r.value.model, at: Date.now() };
      days.value = [plan, ...days.value.filter((d) => !(d.personaId === persona.id && d.date === date))].slice(0, KEEP_DAYS * 2);
      delete errors[persona.id];
      syncPrep(persona);
      return { ok: true, value: plan };
    } finally {
      delete busy[persona.id];
    }
  }

  /**
   * 今天要提前做的发到家务里（开了家务系统时；重新排了就换成新的）。
   * 排完马上发一次；打开"共同的家"、健康计划时再对一次（排的时候家务系统还没开的，开了以后补上）
   */
  function syncPrep(persona: Persona) {
    if (!persona.housework?.enabled || !persona.health?.enabled) return;
    const date = today();
    const day = dayOf(persona.id, date);
    if (!day) return;
    const home = useHomeStore();
    const want = (day.prep ?? []).map(prepExtra);
    const have = home.extrasOf(persona.id, date).filter((x) => x.source === 'health');
    if (JSON.stringify(have) !== JSON.stringify(want)) home.setExtras(persona.id, date, want);
  }

  /** 一件要提前做的事在家务里怎么样了：没发（没开家务系统）/ 还没做 / 拖着 / 做完了 */
  function prepState(persona: Persona, t: PrepTask, date = today()): 'off' | 'todo' | 'doing' | 'later' | 'done' {
    if (!persona.housework?.enabled) return 'off';
    const m = useHomeStore().markOn(persona.id, date, `extra:${prepId(t.name)}`);
    return m?.status ?? 'todo';
  }

  function addLog(l: WorkoutLog) {
    logs.value = [clone(l), ...logs.value.filter((x) => x.id !== l.id)].slice(0, KEEP_LOGS);
  }
  function updateLog(id: string, patch: Partial<WorkoutLog>) {
    const l = logs.value.find((x) => x.id === id);
    if (l) Object.assign(l, patch);
  }

  return { weeks, days, logs, busy, errors, hydrate, today, weekOf, dayOf, logsOf, planWeek, planDay, syncPrep, prepState, addLog, updateLog };
});
