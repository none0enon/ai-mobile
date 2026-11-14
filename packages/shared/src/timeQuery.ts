import { calendarParts, daysBetweenDates, shiftDate, zonedDateKey, zonedInstant } from './timezone.ts';

/**
 * 取记忆时从一句话里认出来的线索（全在本机算，不联网）：
 * - 时间说法："昨天、上周、上个月、去年、3 月 14 日"按发生时间筛选；"第一次 / 上次"按先后取；
 * - 今天是什么日子：节日（含农历）、生日、纪念日、相识整百天 / 整年；
 * - 上下文提到的状态：生病、出差、考试……
 * 日期都按用户选的时区算。
 */

export interface TimeQuery {
  /** 按发生时间筛选的范围（毫秒，含 from 不含 to）；没说时间为 null */
  range: { from: number; to: number } | null;
  /** "第一次 / 最早"取最早的，"上次 / 最后一次"取最近的 */
  order: 'earliest' | 'latest' | null;
  /** 认出来的说法（"查看提示词"里显示） */
  phrase: string | null;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "12"、"十二"、"二十三"、"两" → 数字；认不出返回 null */
export function cnNumber(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!t || !/^[零〇一二两三四五六七八九十]+$/.test(t)) return null;
  if (!t.includes('十')) return t.length === 1 ? (CN_DIGIT[t] ?? null) : null;
  const [tens, ones] = t.split('十') as [string, string];
  const a = tens ? CN_DIGIT[tens] : 1;
  const b = ones ? CN_DIGIT[ones] : 0;
  return a === undefined || b === undefined ? null : a * 10 + b;
}

const NUM = '(\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})';
const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function days(date: string, n: number, tz: string) {
  return { from: zonedInstant(date, 0, tz), to: zonedInstant(shiftDate(date, n), 0, tz) };
}

function month(year: number, m: number, tz: string) {
  const y2 = m === 12 ? year + 1 : year;
  const m2 = m === 12 ? 1 : m + 1;
  return { from: zonedInstant(`${year}-${String(m).padStart(2, '0')}-01`, 0, tz), to: zonedInstant(`${y2}-${String(m2).padStart(2, '0')}-01`, 0, tz) };
}

export function parseTimeQuery(text: string, now: number, timeZone: string): TimeQuery {
  const s = text.replace(/\s+/g, '');
  const today = zonedDateKey(now, timeZone);
  const { year, month: mon, weekday } = calendarParts(now, timeZone);
  /** 这周一 */
  const monday = shiftDate(today, -((weekday + 6) % 7));
  let range: TimeQuery['range'] = null;
  let phrase: string | null = null;
  const hit = (re: RegExp) => {
    const m = s.match(re);
    if (m && !phrase) phrase = m[0];
    return m;
  };

  let m: RegExpMatchArray | null;
  if (hit(/大前天/)) range = days(shiftDate(today, -3), 1, timeZone);
  else if (hit(/前天/)) range = days(shiftDate(today, -2), 1, timeZone);
  else if (hit(/昨天|昨晚|昨日|昨儿|昨夜/)) range = days(shiftDate(today, -1), 1, timeZone);
  else if (hit(/今天|今晚|今早|今儿|今日/)) range = days(today, 1, timeZone);
  else if ((m = hit(new RegExp(`${NUM}天(以|之)?前`)))) {
    const n = cnNumber(m[1] as string);
    if (n !== null) range = days(shiftDate(today, -n), 1, timeZone);
  } else if ((m = hit(new RegExp(`${NUM}个?(星期|周|礼拜)(以|之)?前`)))) {
    const n = cnNumber(m[1] as string);
    if (n !== null) range = days(shiftDate(monday, -7 * n), 7, timeZone);
  } else if ((m = hit(/上上个?(星期|周|礼拜)/))) range = days(shiftDate(monday, -14), 7, timeZone);
  else if ((m = hit(/上个?(星期|周|礼拜)([一二三四五六日天])?/))) {
    const d = m[2] ? WEEKDAY[m[2]] : undefined;
    range = d ? days(shiftDate(monday, -7 + d - 1), 1, timeZone) : days(shiftDate(monday, -7), 7, timeZone);
  } else if (hit(/(这|本)个?(星期|周|礼拜)/)) range = days(monday, 7, timeZone);
  else if ((m = hit(new RegExp(`${NUM}个月(以|之)?前`)))) {
    const n = cnNumber(m[1] as string);
    if (n !== null) {
      const t = year * 12 + (mon - 1) - n;
      range = month(Math.floor(t / 12), (t % 12) + 1, timeZone);
    }
  } else if (hit(/上上个?月/)) {
    const t = year * 12 + (mon - 1) - 2;
    range = month(Math.floor(t / 12), (t % 12) + 1, timeZone);
  } else if (hit(/上个?月/)) {
    const t = year * 12 + (mon - 1) - 1;
    range = month(Math.floor(t / 12), (t % 12) + 1, timeZone);
  } else if (hit(/(这|本)个?月/)) range = month(year, mon, timeZone);
  else if (hit(/前年/)) range = { from: zonedInstant(`${year - 2}-01-01`, 0, timeZone), to: zonedInstant(`${year - 1}-01-01`, 0, timeZone) };
  else if (hit(/去年/)) range = { from: zonedInstant(`${year - 1}-01-01`, 0, timeZone), to: zonedInstant(`${year}-01-01`, 0, timeZone) };
  else if (hit(/今年/)) range = { from: zonedInstant(`${year}-01-01`, 0, timeZone), to: zonedInstant(`${year + 1}-01-01`, 0, timeZone) };
  else if ((m = hit(new RegExp(`${NUM}月${NUM}(日|号)`)))) {
    const mm = cnNumber(m[1] as string);
    const dd = cnNumber(m[2] as string);
    if (mm && dd && mm <= 12 && dd <= 31) {
      let y = year;
      const date = (yy: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      // 说的日子在今天之后，指的是去年那天
      if (date(y) > today) y -= 1;
      range = days(date(y), 1, timeZone);
    }
  } else if ((m = hit(new RegExp(`${NUM}月份?(的时候|那会|那时)?`))) && !/个月/.test(m[0])) {
    const mm = cnNumber(m[1] as string);
    if (mm && mm <= 12) range = month(mm > mon ? year - 1 : year, mm, timeZone);
  }

  let order: TimeQuery['order'] = null;
  if ((m = s.match(/第一次|头一次|头一回|初次|最早|最开始|一开始|刚认识/))) {
    order = 'earliest';
    phrase ??= m[0];
  } else if ((m = s.match(/上一次|上次|上回|最后一次|最近一次/))) {
    order = 'latest';
    phrase ??= m[0];
  }
  return { range, order, phrase };
}

const SOLAR_FESTIVALS: Record<string, string> = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '06-01': '儿童节',
  '10-01': '国庆',
  '10-31': '万圣节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
  '12-31': '跨年',
};

const LUNAR_FESTIVALS: Record<string, string> = {
  '1-1': '春节',
  '1-15': '元宵',
  '5-5': '端午',
  '7-7': '七夕',
  '8-15': '中秋',
  '9-9': '重阳',
};

let lunarFormat: Map<string, Intl.DateTimeFormat> | null = null;

/** 农历的月、日；运行环境不支持农历时返回 null */
function lunarMonthDay(at: number, timeZone: string): { month: number; day: number } | null {
  try {
    lunarFormat ??= new Map();
    let f = lunarFormat.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone, month: 'numeric', day: 'numeric' });
      lunarFormat.set(timeZone, f);
    }
    const parts = f.formatToParts(at);
    const month = parseInt(parts.find((p) => p.type === 'month')?.value ?? '', 10);
    const day = parseInt(parts.find((p) => p.type === 'day')?.value ?? '', 10);
    return Number.isFinite(month) && Number.isFinite(day) ? { month, day } : null;
  } catch {
    return null;
  }
}

/** "3 月 14 日"、"03-14"、"3/14" → "03-14"；认不出返回 null */
export function monthDayKey(text: string): string | null {
  const s = text.replace(/\s+/g, '');
  const m = s.match(new RegExp(`${NUM}月${NUM}(日|号)?`)) ?? s.match(/(\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const mm = cnNumber(m[1] as string);
  const dd = cnNumber(m[2] as string);
  if (!mm || !dd || mm > 12 || dd > 31) return null;
  return `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export interface SpecialDayInput {
  now: number;
  timeZone: string;
  /** 角色关系里的纪念日（日期写成"3 月 14 日"之类的才认得出） */
  anniversaries?: { label: string; date: string }[];
  /** 相识的时间：整百天、整年也算纪念日 */
  metAt?: number;
}

/** 今天是什么日子：节日（含农历）、生日、纪念日。返回的是标签，和故事片段的 special 标签比对 */
export function todaySpecials(input: SpecialDayInput): string[] {
  const { now, timeZone } = input;
  const out = new Set<string>();
  const today = zonedDateKey(now, timeZone);
  const md = today.slice(5);
  if (SOLAR_FESTIVALS[md]) out.add(SOLAR_FESTIVALS[md] as string);
  const lunar = lunarMonthDay(now, timeZone);
  if (lunar) {
    const name = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`];
    if (name) out.add(name);
    // 除夕：明天是正月初一
    const next = lunarMonthDay(now + 86_400_000, timeZone);
    if (next && next.month === 1 && next.day === 1) out.add('除夕');
  }
  for (const a of input.anniversaries ?? []) {
    if (monthDayKey(a.date) === md) {
      out.add(/生日/.test(a.label) ? '生日' : '纪念日');
      out.add(a.label);
    }
  }
  if (input.metAt) {
    const met = zonedDateKey(input.metAt, timeZone);
    const daysKnown = daysBetweenDates(met, today);
    if (daysKnown > 0 && (daysKnown % 100 === 0 || (met.slice(5) === md && met !== today))) out.add('纪念日');
  }
  return [...out];
}

/** 状态标签和认它的说法 */
const STATE_CUES: [string, RegExp][] = [
  ['生病', /生病|感冒|发烧|发热|咳嗽|头疼|头痛|胃疼|肚子疼|不舒服|难受死|医院|吃药|打针|过敏/],
  ['出差', /出差|旅行|旅游|出远门|机场|高铁站|火车站|酒店|行李/],
  ['考试', /考试|期末|期中|考研|答辩|面试|模考|复习/],
  ['加班', /加班|熬夜|通宵|赶工|ddl|deadline|截止/i],
  ['失眠', /失眠|睡不着|没睡好/],
  ['难过', /难过|伤心|想哭|哭了|委屈|崩溃|心情不好|低落/],
  ['生理期', /生理期|例假|姨妈|痛经/],
];

/** 上下文提到的状态（生病、出差、考试……），和故事片段的 special 标签比对 */
export function detectStates(text: string): string[] {
  return STATE_CUES.filter(([, re]) => re.test(text)).map(([label]) => label);
}
