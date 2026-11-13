import type { ISODate } from './types/common.ts';
import type { ChoreWhen, FitTimeOfDay, HealthBento, HealthSettings, HealthSex, MealKey, MealSpot } from './types/life.ts';

/**
 * 健康系统（设计文档 §9.13）：你人设里的身体、目标、能练的方式和时间、食材、做饭时间和厨具，
 * 「健康计划」按「健康」预设排这周和今天的健身计划、饮食计划；"健身"里可以照着今天的计划一个动作一个动作地练。
 * 这里是协议（计划的 JSON 怎么读）和算法（消耗怎么估），提示词在预设文件 apps/web/src/presets/health.json 里。
 */

/** 健身方式：MET（估算消耗用）、是不是室外（记步数和距离）、走路跑步类才数步数 */
export interface FitMethod {
  name: string;
  icon: string;
  met: number;
  outdoor: boolean;
  steps: boolean;
}

export const FIT_METHODS: FitMethod[] = [
  { name: '跑步', icon: 'i-lucide-footprints', met: 9.8, outdoor: true, steps: true },
  { name: '快走', icon: 'i-lucide-footprints', met: 4.3, outdoor: true, steps: true },
  { name: '散步', icon: 'i-lucide-footprints', met: 3.0, outdoor: true, steps: true },
  { name: '骑行', icon: 'i-lucide-bike', met: 7.5, outdoor: true, steps: false },
  { name: '登山', icon: 'i-lucide-mountain', met: 6.5, outdoor: true, steps: true },
  { name: '爬楼梯', icon: 'i-lucide-trending-up', met: 8.0, outdoor: false, steps: true },
  { name: '跳绳', icon: 'i-lucide-activity', met: 11.0, outdoor: false, steps: false },
  { name: '徒手训练', icon: 'i-lucide-person-standing', met: 5.0, outdoor: false, steps: false },
  { name: '哑铃', icon: 'i-lucide-dumbbell', met: 5.0, outdoor: false, steps: false },
  { name: '健身房器械', icon: 'i-lucide-dumbbell', met: 5.5, outdoor: false, steps: false },
  { name: 'HIIT', icon: 'i-lucide-flame', met: 8.0, outdoor: false, steps: false },
  { name: '跳操', icon: 'i-lucide-music-2', met: 6.5, outdoor: false, steps: false },
  { name: '瑜伽', icon: 'i-lucide-flower-2', met: 2.5, outdoor: false, steps: false },
  { name: '普拉提', icon: 'i-lucide-flower-2', met: 3.0, outdoor: false, steps: false },
  { name: '拉伸', icon: 'i-lucide-stretch-horizontal', met: 2.3, outdoor: false, steps: false },
  { name: '游泳', icon: 'i-lucide-waves', met: 7.0, outdoor: false, steps: false },
  { name: '球类', icon: 'i-lucide-volleyball', met: 6.5, outdoor: false, steps: false },
  { name: '舞蹈', icon: 'i-lucide-music', met: 5.5, outdoor: false, steps: false },
];

/** 自己加的健身方式按名字猜（带"跑""走""骑"的算室外） */
export function fitMethod(name: string): FitMethod {
  const known = FIT_METHODS.find((m) => m.name === name);
  if (known) return known;
  const outdoor = /跑|走|骑|徒步|登山|爬山|户外|滑板|轮滑/.test(name);
  return { name, icon: outdoor ? 'i-lucide-footprints' : 'i-lucide-dumbbell', met: /跑/.test(name) ? 9 : outdoor ? 4.5 : 5, outdoor, steps: outdoor && !/骑|滑/.test(name) };
}

export const HEALTH_GOALS = ['减脂', '增肌', '塑形', '保持健康', '提升体能', '改善体态', '缓解久坐', '睡得更好'];
export const KITCHEN_TOOLS = ['燃气灶', '电磁炉', '炒锅', '平底锅', '汤锅', '电饭煲', '蒸锅', '微波炉', '烤箱', '空气炸锅', '电煮锅', '破壁机', '电水壶'];
export const COMMON_INGREDIENTS = ['鸡蛋', '鸡胸肉', '牛肉', '猪里脊', '虾', '豆腐', '牛奶', '酸奶', '燕麦', '米饭', '红薯', '土豆', '西兰花', '番茄', '黄瓜', '生菜', '胡萝卜', '香蕉', '苹果', '全麦面包', '面条'];
export const FIT_TIME_LABEL: Record<FitTimeOfDay, string> = { morning: '早上', noon: '中午', evening: '晚上', any: '都行' };
export const MEAL_LABEL: Record<MealKey | 'snack', string> = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭', snack: '加餐' };
export const MEAL_KEYS: MealKey[] = ['breakfast', 'lunch', 'dinner'];
export const BENTO_LABEL: Record<HealthBento, string> = { heat: '能带，也能热', cold: '能带，热不了', off: '不带' };

export const DEFAULT_HEALTH: HealthSettings = {
  enabled: false,
  heightCm: null,
  weightKg: null,
  targetWeightKg: null,
  age: null,
  sex: null,
  goal: '',
  methods: ['快走', '跑步', '徒手训练', '拉伸'],
  weekMinutes: [45, 30, 0, 30, 0, 30, 45],
  timeOfDay: 'evening',
  timeNote: '',
  ingredients: ['鸡蛋', '牛奶', '燕麦', '鸡胸肉', '番茄', '西兰花', '米饭'],
  avoid: '',
  cookMinutes: { breakfast: 10, lunch: 0, dinner: 30 },
  bento: 'heat',
  tools: ['燃气灶', '炒锅', '电饭煲', '微波炉'],
  nearby: true,
  note: '',
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 10) / 10 : null);
const intIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const strList = (v: unknown, max = 40): string[] =>
  [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 30)).filter(Boolean))].slice(0, max);
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function normalizeHealth(raw: unknown): HealthSettings {
  const d = DEFAULT_HEALTH;
  if (!isObj(raw)) return JSON.parse(JSON.stringify(d)) as HealthSettings;
  const week = Array.isArray(raw.weekMinutes) && raw.weekMinutes.length === 7 ? raw.weekMinutes.map((m) => intIn(m, 0, 300, 0)) : [...d.weekMinutes];
  const cook = isObj(raw.cookMinutes) ? raw.cookMinutes : {};
  const sex: HealthSex | null = raw.sex === 'male' || raw.sex === 'female' ? raw.sex : null;
  const tod = raw.timeOfDay === 'morning' || raw.timeOfDay === 'noon' || raw.timeOfDay === 'evening' ? raw.timeOfDay : 'any';
  return {
    enabled: raw.enabled === true,
    heightCm: numOrNull(raw.heightCm, 80, 250),
    weightKg: numOrNull(raw.weightKg, 20, 300),
    targetWeightKg: numOrNull(raw.targetWeightKg, 20, 300),
    age: numOrNull(raw.age, 8, 100),
    sex,
    goal: str(raw.goal),
    methods: Array.isArray(raw.methods) ? strList(raw.methods) : [...d.methods],
    weekMinutes: week,
    timeOfDay: tod,
    timeNote: str(raw.timeNote, 200),
    ingredients: Array.isArray(raw.ingredients) ? strList(raw.ingredients, 80) : [...d.ingredients],
    avoid: str(raw.avoid, 200),
    cookMinutes: { breakfast: intIn(cook.breakfast, 0, 180, 10), lunch: intIn(cook.lunch, 0, 180, 0), dinner: intIn(cook.dinner, 0, 180, 30) },
    bento: raw.bento === 'cold' || raw.bento === 'off' ? raw.bento : 'heat',
    tools: Array.isArray(raw.tools) ? strList(raw.tools) : [...d.tools],
    nearby: raw.nearby !== false,
    note: str(raw.note),
  };
}

/** BMI（身高体重都填了才有） */
export function bmiOf(h: Pick<HealthSettings, 'heightCm' | 'weightKg'>): number | null {
  if (!h.heightCm || !h.weightKg) return null;
  const m = h.heightCm / 100;
  return Math.round((h.weightKg / (m * m)) * 10) / 10;
}

// —— 消耗（燃脂）怎么估 ——

export interface KcalInput {
  /** 运动的 MET */
  met: number;
  minutes: number;
  weightKg: number | null;
  /** 平均心率：知道年龄、性别、体重时按心率算（Keytel 等，2005） */
  hrAvg?: number | null;
  age?: number | null;
  sex?: HealthSex | null;
}

/** 估算消耗（千卡）和怎么估的；没填体重时按 60 kg */
export function estimateKcal(input: KcalInput): { kcal: number; basis: string } {
  const minutes = Math.max(0, input.minutes);
  const w = input.weightKg ?? 60;
  const { hrAvg, age, sex } = input;
  if (hrAvg && hrAvg >= 80 && hrAvg <= 220 && age && sex && input.weightKg) {
    const perMin =
      sex === 'male' ? (-55.0969 + 0.6309 * hrAvg + 0.1988 * w + 0.2017 * age) / 4.184 : (-20.4022 + 0.4472 * hrAvg - 0.1263 * w + 0.074 * age) / 4.184;
    if (perMin > 0) return { kcal: Math.round(perMin * minutes), basis: '按心率、体重、年龄算' };
  }
  const kcal = Math.round(input.met * w * (minutes / 60));
  return { kcal, basis: input.weightKg ? '按运动强度和体重估' : '按运动强度估（没填体重，按 60 kg）' };
}

/** 跑步、走路按配速换 MET（越快越高），别的用固定值 */
export function metFor(method: FitMethod, kmPerHour?: number | null): number {
  if (!kmPerHour || kmPerHour <= 0 || !method.steps) return method.met;
  if (kmPerHour < 4) return 2.8;
  if (kmPerHour < 5.5) return 3.8;
  if (kmPerHour < 7) return 5;
  // 跑步：大约每小时 1 公里对应 1 MET
  return Math.min(16, Math.max(6, kmPerHour * 1.0));
}

/** 6'01" 这样的配速（秒 / 公里） */
export function paceText(secPerKm: number | null): string {
  if (!secPerKm || !Number.isFinite(secPerKm) || secPerKm <= 0) return `--'--"`;
  return `${Math.floor(secPerKm / 60)}'${String(Math.round(secPerKm % 60)).padStart(2, '0')}"`;
}

// —— 计划（「健康」预设按这个格式写，这里读回来）——

/** 计划里的一个动作（热身、拉伸也是这个格式） */
export interface FitMove {
  name: string;
  /** 几组（热身、拉伸是 1） */
  sets: number;
  /** 每组做多少："12 次"、"每边 10 次" */
  reps: string;
  /** 按时间做的（平板支撑 30 秒）：每组几秒；按次数做的是 0 */
  seconds: number;
  /** 组间休息几秒 */
  rest: number;
  /** 怎么做：一步一步，大白话（复杂的动作才有） */
  how: string[];
  /** 最要注意的一点 */
  tips: string;
  /** 做不动时的简单做法 */
  easier: string;
}

export interface PlanMeal {
  /** 吃什么；英文的店里的菜写成"中文（英文原名）" */
  name: string;
  /** 这顿现做（false = 外食，或者吃提前做好的） */
  cook: boolean;
  /** 吃提前做好带去的（便当、隔夜燕麦这类）：这顿不用现做 */
  bento?: boolean;
  /** 现做的：做多久；提前做的：做的时候花多久；外食是 0 */
  minutes: number;
  kcal: number | null;
  ingredients: string[];
  steps: string[];
  note: string;
  /** 带便当的那顿：哪顿做的、怎么装、怎么热 */
  prep?: string;
  /** 带便当的那顿：没做成、忘了带时的备案 */
  backup?: string;
  /** 备案里提到的附近的店 */
  backupSpot?: MealSpot;
  /** 外食时去哪家：「健康」从"附近能吃的"里挑的店名 */
  place?: string;
  /** 外食时点什么 */
  order?: string[];
  /** 这家店在地图上（对上了附近搜到的店才有） */
  spot?: MealSpot;
}

/**
 * 今天要提前做的一件事（给之后哪顿备的：泡隔夜燕麦、晚饭多做一份装饭盒）。
 * 开了家务系统时发到今天的家务里（"共同的家"能开始、打勾、拖），带着没来得及做的备案
 */
export interface PrepTask {
  name: string;
  /** 什么时候做 */
  when: ChoreWhen;
  minutes: number;
  /** 给哪顿备的（"明天午饭"） */
  meal: string;
  steps: string[];
  /** 没来得及做的备案：那顿改成什么 */
  backup: string;
  /** 备案里提到的附近的店 */
  backupSpot?: MealSpot;
}

/** 这周要买的一样东西 */
export interface ShoppingItem {
  /** 买什么：具体的商品（"去皮鸡胸肉"、"无糖希腊酸奶"） */
  name: string;
  /** 买多少：按店里卖的规格（"约 1.5 lb"、"32 oz 一盒"） */
  amount: string;
  /** 在哪买：附近超市的名字或者网店（Amazon、Kroger……）；没写是空的 */
  where: string;
  /** 在网店里搜什么（店里用的语言，美国的店写英文） */
  search: string;
  note: string;
}

export interface HealthDayPlan {
  personaId: string;
  date: ISODate;
  /** 今天休息（不练） */
  rest: boolean;
  workout: { title: string; minutes: number; intensity: string; warmup: FitMove[]; items: FitMove[]; cooldown: FitMove[] } | null;
  meals: Partial<Record<MealKey | 'snack', PlanMeal>>;
  /** 今天要提前做的（给之后的哪顿备） */
  prep?: PrepTask[];
  tips: string;
  /** 排的时候参考了附近哪些店（"参考了家附近 18 家能吃饭的地方、6 家超市"），或者为什么没参考 */
  near?: string;
  model: string;
  at: number;
}

export interface HealthWeekDay {
  /** 0 周日 … 6 周六 */
  weekday: number;
  workout: string;
  minutes: number;
  rest: boolean;
  meals: string;
}

export interface HealthWeekPlan {
  personaId: string;
  /** 这周的周一 */
  weekStart: ISODate;
  focus: string;
  days: HealthWeekDay[];
  shopping: ShoppingItem[];
  tips: string[];
  /** 排的时候附近的超市（要买的东西点开地图用） */
  stores?: MealSpot[];
  /** 在哪个国家（ISO 代码，挑网店用） */
  country?: string;
  /** 参考了附近哪些店，或者为什么没参考 */
  near?: string;
  model: string;
  at: number;
}

const WEEKDAY_NAMES: Record<string, number> = { 周日: 0, 周天: 0, 星期日: 0, 星期天: 0, 周一: 1, 星期一: 1, 周二: 2, 星期二: 2, 周三: 3, 星期三: 3, 周四: 4, 星期四: 4, 周五: 5, 星期五: 5, 周六: 6, 星期六: 6 };

function weekdayFrom(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v === 7 ? 0 : v >= 0 && v <= 6 ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t in WEEKDAY_NAMES) return WEEKDAY_NAMES[t] ?? null;
    const n = Number(t);
    if (Number.isInteger(n)) return weekdayFrom(n);
  }
  return null;
}

function lines(v: unknown, max = 12): string[] {
  if (typeof v === 'string') return v.split(/\n+/).map((x) => x.replace(/^\s*(\d+[.、)]|[-•·])\s*/, '').trim()).filter(Boolean).slice(0, max);
  return (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, max);
}

function moveFrom(v: unknown): FitMove | null {
  if (typeof v === 'string' && v.trim()) return { name: v.trim().slice(0, 40), sets: 1, reps: '', seconds: 0, rest: 0, how: [], tips: '', easier: '' };
  if (!isObj(v)) return null;
  const name = str(v.name, 40);
  if (!name) return null;
  const reps = typeof v.reps === 'number' ? `${v.reps} 次` : str(v.reps, 30) || str(v.amount, 30);
  return {
    name,
    sets: intIn(v.sets, 1, 10, 1),
    reps,
    seconds: intIn(v.seconds, 0, 3600, 0),
    rest: intIn(v.rest, 0, 600, 0),
    how: lines(v.how),
    tips: str(v.tips, 200),
    easier: str(v.easier, 200),
  };
}

function mealFrom(v: unknown): PlanMeal | null {
  if (typeof v === 'string' && v.trim()) return { name: v.trim().slice(0, 60), cook: false, minutes: 0, kcal: null, ingredients: [], steps: [], note: '' };
  if (!isObj(v)) return null;
  const name = str(v.name, 60);
  if (!name) return null;
  const kcal = typeof v.kcal === 'number' && Number.isFinite(v.kcal) && v.kcal > 0 ? Math.round(v.kcal) : null;
  const bento = v.bento === true;
  const place = bento ? '' : str(v.place ?? v.restaurant ?? v.store, 60);
  const order = lines(v.order, 8);
  // 提前做好的这顿不现做；写了店、没写现不现做：算外食
  const cook = bento ? false : v.cook === undefined ? !place : v.cook !== false;
  const out = !cook && !bento;
  const prep = str(v.prep, 200);
  const backup = str(v.backup, 200);
  return {
    name,
    cook,
    ...(bento ? { bento } : {}),
    minutes: out ? 0 : intIn(v.minutes, 0, 240, 0),
    kcal,
    ingredients: lines(v.ingredients, 20),
    steps: lines(v.steps, 15),
    note: str(v.note, 200),
    ...(bento && prep ? { prep } : {}),
    ...(bento && backup ? { backup } : {}),
    ...(out && place ? { place } : {}),
    ...(out && order.length ? { order } : {}),
  };
}

const WHEN_WORDS: Record<string, ChoreWhen> = { morning: 'morning', noon: 'noon', evening: 'evening', bedtime: 'bedtime', any: 'any', 早上: 'morning', 上午: 'morning', 中午: 'noon', 下午: 'noon', 晚上: 'evening', 傍晚: 'evening', 睡前: 'bedtime', 随时: 'any' };

/** 今天要提前做的事（最多 4 件）；没写什么时候做的算晚上，没写备案的也留着 */
export function parsePrepTasks(v: unknown): PrepTask[] {
  const out: PrepTask[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    if (!isObj(raw)) continue;
    const name = str(raw.name, 60);
    if (!name) continue;
    const when = WHEN_WORDS[str(raw.when, 10).toLowerCase()] ?? 'evening';
    out.push({ name, when, minutes: intIn(raw.minutes, 1, 240, 10), meal: str(raw.meal ?? raw.for, 30), steps: lines(raw.steps, 8), backup: str(raw.backup, 200) });
    if (out.length >= 4) break;
  }
  return out;
}

/** 要买的东西：「健康」写的对象（名字、多少、在哪买、搜什么），以前存的一行一样的文字也认 */
export function parseShopping(v: unknown, max = 40): ShoppingItem[] {
  const list: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? lines(v, max) : [];
  const out: ShoppingItem[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    let item: ShoppingItem | null = null;
    if (typeof x === 'string') {
      const t = x.trim().slice(0, 80);
      if (t) item = { name: t, amount: '', where: '', search: '', note: '' };
    } else if (isObj(x)) {
      const name = str(x.name ?? x.item, 60);
      if (name) item = { name, amount: str(x.amount ?? x.qty ?? x.quantity, 40), where: str(x.where ?? x.store, 40), search: str(x.search ?? x.query, 80), note: str(x.note, 120) };
    }
    if (!item) continue;
    const key = `${item.name}|${item.where}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** 读「健康」写回来的这周计划；不像样时返回 null */
export function parseHealthWeek(v: unknown): Omit<HealthWeekPlan, 'personaId' | 'weekStart' | 'model' | 'at'> | null {
  if (!isObj(v) || !Array.isArray(v.days)) return null;
  const byDay = new Map<number, HealthWeekDay>();
  v.days.forEach((raw, i) => {
    if (!isObj(raw)) return;
    // 没写星期几就按顺序当周一到周日
    const weekday = weekdayFrom(raw.weekday ?? raw.day) ?? [1, 2, 3, 4, 5, 6, 0][i];
    if (weekday === undefined || byDay.has(weekday)) return;
    const minutes = intIn(raw.minutes, 0, 300, 0);
    const workout = str(raw.workout, 80);
    byDay.set(weekday, { weekday, workout: workout || '休息', minutes, rest: raw.rest === true || !workout || minutes === 0, meals: str(raw.meals, 300) });
  });
  if (!byDay.size) return null;
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => byDay.get(d) ?? { weekday: d, workout: '休息', minutes: 0, rest: true, meals: '' });
  return { focus: str(v.focus, 200), days, shopping: parseShopping(v.shopping), tips: lines(v.tips, 8) };
}

/** 读「健康」写回来的今天的计划；不像样时返回 null */
export function parseHealthDay(v: unknown): Omit<HealthDayPlan, 'personaId' | 'date' | 'model' | 'at'> | null {
  if (!isObj(v)) return null;
  const meals: HealthDayPlan['meals'] = {};
  const rawMeals = isObj(v.meals) ? v.meals : {};
  for (const k of ['breakfast', 'lunch', 'dinner', 'snack'] as const) {
    const m = mealFrom(rawMeals[k]);
    if (m) meals[k] = m;
  }
  const w = isObj(v.workout) ? v.workout : null;
  const items = w ? (Array.isArray(w.items) ? w.items : []).map(moveFrom).filter((m): m is FitMove => !!m) : [];
  const workout = w && items.length
    ? {
        title: str(w.title, 60) || '今天的训练',
        minutes: intIn(w.minutes, 5, 300, 30),
        intensity: str(w.intensity, 20),
        warmup: (Array.isArray(w.warmup) ? w.warmup : []).map(moveFrom).filter((m): m is FitMove => !!m),
        items,
        cooldown: (Array.isArray(w.cooldown) ? w.cooldown : []).map(moveFrom).filter((m): m is FitMove => !!m),
      }
    : null;
  if (!workout && !Object.keys(meals).length) return null;
  const prep = parsePrepTasks(v.prep);
  return { rest: v.rest === true || !workout, workout, meals, ...(prep.length ? { prep } : {}), tips: str(v.tips, 300) };
}

/** "3 组 × 12 次" / "3 组 × 30 秒" / "1 分钟" */
export function moveAmount(m: Pick<FitMove, 'sets' | 'reps' | 'seconds'>): string {
  const per = m.seconds ? (m.seconds >= 60 && m.seconds % 60 === 0 ? `${m.seconds / 60} 分钟` : `${m.seconds} 秒`) : m.reps;
  if (m.sets > 1) return `${m.sets} 组 × ${per || '一组'}`;
  return per;
}
