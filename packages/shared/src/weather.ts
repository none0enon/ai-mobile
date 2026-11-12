import type { WeatherSnapshot } from './environment.ts';

/**
 * 天气（设计文档 §8）。两家：
 * - Open-Meteo：免 Key、全球都有。美国用的是 NOAA 的高分辨率模型（HRRR / GFS），你在美国看本地天气用它；
 *   美国的天气预警另外取美国国家气象局（api.weather.gov，也免 Key）。
 * - 和风天气：国内更准，要 Key 和你自己的 API Host（控制台 → 设置里看）。住在国内的角色用它。
 * 这里只放数据结构和"把各家返回的东西换成同一种样子"的函数，不发请求：前端和 Worker 都能用。
 */

export type WeatherProvider = 'open-meteo' | 'qweather';
/** 选哪家：auto = 国内（含港澳台）的地方用和风天气（填了 Key 和 API Host 时），其他地方用 Open-Meteo */
export type WeatherProviderChoice = 'auto' | WeatherProvider;

export const WEATHER_PROVIDER_LABEL: Record<WeatherProvider, string> = {
  'open-meteo': 'Open-Meteo',
  qweather: '和风天气',
};

/** 温度显示：摄氏 / 华氏（只影响界面；发给模型的是摄氏，选了华氏时括号里带一个华氏） */
export type TempUnit = 'c' | 'f';

export interface WeatherDay {
  maxC: number;
  minC: number;
  text: string;
  /** 降水概率 0–100 */
  rainChance?: number;
}

export interface WeatherReport {
  provider: WeatherProvider;
  /** 显示的地名（上海 / 旧金山） */
  place: string;
  /** 现在的天气：晴、小雨…… */
  text: string;
  /** lucide 图标类名 */
  icon: string;
  tempC: number;
  feelsC?: number;
  /** 相对湿度 0–100 */
  humidity?: number;
  isDay?: boolean;
  today?: WeatherDay;
  tomorrow?: WeatherDay;
  /** 接下来几个小时：例如"3 小时后可能下雨" */
  soon?: string;
  /** 预警，一句话（多条用"；"隔开） */
  alert?: string;
  /** 什么时候取的（毫秒） */
  fetchedAt: number;
  /** 这个地方的 IANA 时区 */
  timezone?: string;
}

/** 国内（和风天气覆盖得最好的地方）：中国大陆和港澳台 */
export function isChinaRegion(countryCode: string | null | undefined): boolean {
  return ['CN', 'HK', 'MO', 'TW'].includes((countryCode ?? '').toUpperCase());
}

/** 没有国家代码时按经纬度粗略判断在不在国内（只用来挑天气来源，不求精确） */
export function roughlyInChina(lat: number, lng: number): boolean {
  if (lat < 18 || lat > 53.6 || lng < 73.5 || lng > 135) return false;
  // 去掉明显在外面的几块：蒙古中北部、朝鲜半岛和日本、中南半岛
  if (lat > 44.5 && lng > 88 && lng < 116.5) return false;
  if (lng > 124.5 && lat < 40.5) return false;
  if (lat < 21.5 && lng < 106) return false;
  return true;
}

// —— 图标和文字 ——

const SUN = 'i-lucide-sun';
const MOON = 'i-lucide-moon';
const CLOUD_SUN = 'i-lucide-cloud-sun';
const CLOUD_MOON = 'i-lucide-cloud-moon';
const CLOUD = 'i-lucide-cloud';
const FOG = 'i-lucide-cloud-fog';
const DRIZZLE = 'i-lucide-cloud-drizzle';
const RAIN = 'i-lucide-cloud-rain';
const HEAVY_RAIN = 'i-lucide-cloud-rain-wind';
const SNOW = 'i-lucide-cloud-snow';
const THUNDER = 'i-lucide-cloud-lightning';
const HAIL = 'i-lucide-cloud-hail';
const HAZE = 'i-lucide-haze';
const HOT = 'i-lucide-thermometer-sun';
const COLD = 'i-lucide-thermometer-snowflake';

/** Open-Meteo 用的 WMO 天气代码 → 中文和图标（夜里晴、少云换成月亮） */
const WMO: Record<number, [string, string]> = {
  0: ['晴', SUN],
  1: ['晴间多云', SUN],
  2: ['多云', CLOUD_SUN],
  3: ['阴', CLOUD],
  45: ['雾', FOG],
  48: ['冻雾', FOG],
  51: ['毛毛雨', DRIZZLE],
  53: ['毛毛雨', DRIZZLE],
  55: ['毛毛雨', DRIZZLE],
  56: ['冻毛毛雨', DRIZZLE],
  57: ['冻毛毛雨', DRIZZLE],
  61: ['小雨', RAIN],
  63: ['中雨', RAIN],
  65: ['大雨', HEAVY_RAIN],
  66: ['冻雨', HAIL],
  67: ['冻雨', HAIL],
  71: ['小雪', SNOW],
  73: ['中雪', SNOW],
  75: ['大雪', SNOW],
  77: ['米雪', SNOW],
  80: ['阵雨', RAIN],
  81: ['阵雨', RAIN],
  82: ['强阵雨', HEAVY_RAIN],
  85: ['阵雪', SNOW],
  86: ['强阵雪', SNOW],
  95: ['雷阵雨', THUNDER],
  96: ['雷阵雨伴有冰雹', THUNDER],
  99: ['强雷阵雨伴有冰雹', THUNDER],
};

export function wmoText(code: number): string {
  return WMO[code]?.[0] ?? '未知';
}

/** 夜里把太阳换成月亮 */
export function nightIcon(icon: string, isDay: boolean): string {
  if (isDay) return icon;
  if (icon === SUN) return MOON;
  if (icon === CLOUD_SUN) return CLOUD_MOON;
  return icon;
}

export function wmoIcon(code: number, isDay = true): string {
  return nightIcon(WMO[code]?.[1] ?? CLOUD, isDay);
}

/** 按中文天气描述挑图标（和风天气的代码不认识时用） */
export function iconForText(text: string, isDay = true): string {
  if (/雷/.test(text)) return THUNDER;
  if (/冰雹|冻雨/.test(text)) return HAIL;
  if (/雪/.test(text)) return SNOW;
  if (/暴雨|大雨|强阵雨/.test(text)) return HEAVY_RAIN;
  if (/毛毛雨/.test(text)) return DRIZZLE;
  if (/雨/.test(text)) return RAIN;
  if (/雾/.test(text)) return FOG;
  if (/霾|沙|尘/.test(text)) return HAZE;
  if (/阴/.test(text)) return CLOUD;
  if (/云/.test(text)) return isDay ? CLOUD_SUN : CLOUD_MOON;
  if (/晴/.test(text)) return isDay ? SUN : MOON;
  if (/热/.test(text)) return HOT;
  if (/冷/.test(text)) return COLD;
  return CLOUD;
}

/** 和风天气的天气代码（100 晴、150 夜间晴、3xx 雨、4xx 雪、5xx 雾霾沙尘……）→ 图标；认不出来时按文字 */
export function qweatherIcon(code: string | number | undefined, text: string): string {
  const n = Number(code);
  if (!Number.isFinite(n)) return iconForText(text);
  if (n === 100) return SUN;
  if (n === 150) return MOON;
  if (n >= 101 && n <= 103) return CLOUD_SUN;
  if (n >= 151 && n <= 153) return CLOUD_MOON;
  if (n === 104) return CLOUD;
  if (n >= 302 && n <= 304) return THUNDER;
  if (n === 309) return DRIZZLE;
  if (n === 313) return HAIL;
  if ((n >= 307 && n <= 312) || (n >= 316 && n <= 318) || n === 301 || n === 351) return HEAVY_RAIN;
  if (n >= 300 && n < 400) return RAIN;
  if (n >= 400 && n < 500) return SNOW;
  if (n >= 500 && n <= 501) return FOG;
  if (n >= 502 && n < 600) return /雾/.test(text) ? FOG : HAZE;
  if (n === 900) return HOT;
  if (n === 901) return COLD;
  return iconForText(text);
}

/** 正在下雨（场景里画雨、约会时推荐室内用） */
export function isRainy(text: string | null | undefined): boolean {
  return !!text && /雨|雷/.test(text);
}

export function isSnowy(text: string | null | undefined): boolean {
  return !!text && /雪/.test(text);
}

// —— 数值 ——

function num(x: unknown): number | undefined {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function round(n: number): number {
  return Math.round(n);
}

export function cToF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/** 界面上的温度："12°C" 或 "54°F" */
export function formatTemp(c: number | null | undefined, unit: TempUnit = 'c'): string {
  if (c == null || !Number.isFinite(c)) return '—';
  return unit === 'f' ? `${cToF(c)}°F` : `${Math.round(c)}°C`;
}

// —— 一句话的"接下来" ——

/** 温度范围："8~15°C" / "46~59°F" */
export function formatRange(minC: number, maxC: number, unit: TempUnit = 'c'): string {
  const n = (c: number) => (unit === 'f' ? cToF(c) : Math.round(c));
  return `${n(minC)}~${formatTemp(maxC, unit)}`;
}

/** "今天 8~15°C，明天降温，最高 6°C / 明天有雨" */
export function outlookLine(r: Pick<WeatherReport, 'today' | 'tomorrow' | 'soon' | 'text'>, unit: TempUnit = 'c'): string {
  const t = (c: number) => formatTemp(c, unit);
  const parts: string[] = [];
  if (r.soon) parts.push(r.soon);
  if (r.today) parts.push(`今天 ${formatRange(r.today.minC, r.today.maxC, unit)}`);
  const tm = r.tomorrow;
  if (tm) {
    const wet = (s: string | undefined) => isRainy(s) || isSnowy(s);
    const todayMax = r.today?.maxC;
    if (wet(tm.text) && !wet(r.today?.text) && !wet(r.text)) parts.push(`明天有${isSnowy(tm.text) ? '雪' : '雨'}（${tm.text}）`);
    else if (todayMax != null && tm.maxC <= todayMax - 4) parts.push(`明天降温，最高 ${t(tm.maxC)}`);
    else if (todayMax != null && tm.maxC >= todayMax + 4) parts.push(`明天升温到 ${t(tm.maxC)}`);
    else parts.push(`明天${tm.text} ${formatRange(tm.minC, tm.maxC, unit)}`);
  }
  return parts.join('，');
}

/** 交给【当前环境】的那一份 */
export function weatherSnapshot(r: WeatherReport, unit: TempUnit = 'c'): WeatherSnapshot {
  return {
    city: r.place,
    text: r.text,
    tempC: round(r.tempC),
    ...(unit === 'f' ? { unit } : {}),
    outlook: outlookLine(r, 'c') || undefined,
    ...(r.alert ? { alert: r.alert } : {}),
  };
}

// —— Open-Meteo ——

/** Open-Meteo forecast 接口要的参数（current + 今明两天 + 接下来 12 小时） */
export const OPEN_METEO_QUERY = {
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  hourly: 'precipitation_probability,weather_code',
  forecast_days: '2',
  forecast_hours: '12',
  timezone: 'auto',
} as const;

interface OpenMeteoJson {
  timezone?: string;
  current?: Record<string, unknown>;
  daily?: Record<string, unknown[]>;
  hourly?: Record<string, unknown[]>;
  error?: boolean;
  reason?: string;
}

function dayAt(daily: Record<string, unknown[]> | undefined, i: number): WeatherDay | undefined {
  if (!daily) return undefined;
  const max = num(daily.temperature_2m_max?.[i]);
  const min = num(daily.temperature_2m_min?.[i]);
  const code = num(daily.weather_code?.[i]);
  if (max == null || min == null) return undefined;
  const chance = num(daily.precipitation_probability_max?.[i]);
  return { maxC: round(max), minC: round(min), text: code == null ? '' : wmoText(code), ...(chance != null ? { rainChance: chance } : {}) };
}

/** 接下来 12 小时里第一次降水概率 ≥ 60% 的是几小时后（现在没在下的时候） */
function soonFromHourly(hourly: Record<string, unknown[]> | undefined, nowCode: number): string | undefined {
  if (!hourly) return undefined;
  const wetNow = isRainy(wmoText(nowCode)) || isSnowy(wmoText(nowCode));
  if (wetNow) return undefined;
  const probs = hourly.precipitation_probability ?? [];
  const codes = hourly.weather_code ?? [];
  for (let i = 1; i < Math.min(probs.length, 12); i += 1) {
    const p = num(probs[i]);
    const code = num(codes[i]);
    if (p != null && p >= 60) {
      const what = code != null && isSnowy(wmoText(code)) ? '下雪' : '下雨';
      return `${i} 小时后可能${what}（${Math.round(p)}%）`;
    }
  }
  return undefined;
}

/** Open-Meteo forecast 的返回 → WeatherReport */
export function fromOpenMeteo(json: unknown, place: string, fetchedAt: number): WeatherReport {
  const j = (json ?? {}) as OpenMeteoJson;
  if (j.error) throw new Error(`Open-Meteo：${j.reason ?? '请求出错'}`);
  const c = j.current ?? {};
  const temp = num(c.temperature_2m);
  const code = num(c.weather_code);
  if (temp == null || code == null) throw new Error('Open-Meteo 返回里没有当前天气');
  const isDay = num(c.is_day) !== 0;
  const feels = num(c.apparent_temperature);
  const hum = num(c.relative_humidity_2m);
  const today = dayAt(j.daily, 0);
  const tomorrow = dayAt(j.daily, 1);
  const soon = soonFromHourly(j.hourly, code);
  return {
    provider: 'open-meteo',
    place,
    text: wmoText(code),
    icon: wmoIcon(code, isDay),
    tempC: temp,
    ...(feels != null ? { feelsC: feels } : {}),
    ...(hum != null ? { humidity: hum } : {}),
    isDay,
    ...(today ? { today } : {}),
    ...(tomorrow ? { tomorrow } : {}),
    ...(soon ? { soon } : {}),
    fetchedAt,
    ...(j.timezone ? { timezone: j.timezone } : {}),
  };
}

// —— 和风天气 ——

/** 和风天气的报错：v1 是 application/problem+json 的 {error: {status, title, detail}}，v7 和城市搜索是 {code: "401"} */
export function qweatherError(json: unknown, status: number): string | null {
  const j = (json ?? {}) as { error?: { title?: string; detail?: string; status?: number }; code?: string };
  if (j.error) return `和风天气 ${j.error.status ?? status}：${[j.error.title, j.error.detail].filter(Boolean).join(' · ')}`;
  if (typeof j.code === 'string' && j.code !== '200') {
    const hint: Record<string, string> = {
      '204': '这个地方没有数据',
      '400': '请求参数不对',
      '401': 'Key 不对（或者没在这个 API Host 下）',
      '402': '超过了访问次数或者余额不足',
      '403': '没有权限（检查 Key 的安全设置和 API Host）',
      '404': '查询的地点或数据不存在',
      '429': '请求太频繁',
    };
    return `和风天气 ${j.code}：${hint[j.code] ?? '请求失败'}`;
  }
  if (status >= 400) return `和风天气返回 ${status}`;
  return null;
}

interface QwValue {
  value?: number | string;
}
interface QwCurrentJson {
  condition?: { text?: string; code?: string | number };
  temperature?: QwValue;
  feelsLike?: QwValue;
  humidity?: number | string;
}
interface QwDailyJson {
  days?: {
    temperatureMax?: QwValue;
    temperatureMin?: QwValue;
    daytime?: { condition?: { text?: string; code?: string | number }; precipitation?: { probability?: number | string } };
    nighttime?: { condition?: { text?: string }; precipitation?: { probability?: number | string } };
  }[];
}
interface QwAlertJson {
  alerts?: { headline?: string; eventType?: { name?: string }; severity?: string; messageType?: { code?: string } }[];
}

function qwDay(d: NonNullable<QwDailyJson['days']>[number] | undefined): WeatherDay | undefined {
  if (!d) return undefined;
  const max = num(d.temperatureMax?.value);
  const min = num(d.temperatureMin?.value);
  if (max == null || min == null) return undefined;
  const probs = [num(d.daytime?.precipitation?.probability), num(d.nighttime?.precipitation?.probability)].filter((x): x is number => x != null);
  // v1 的降水概率是 0–1
  const chance = probs.length ? Math.round(Math.max(...probs) * (Math.max(...probs) <= 1 ? 100 : 1)) : undefined;
  const text = d.daytime?.condition?.text || d.nighttime?.condition?.text || '';
  return { maxC: round(max), minC: round(min), text, ...(chance != null ? { rainChance: chance } : {}) };
}

/** 预警：只要还在生效的（取消的不要），"大风蓝色预警；暴雨黄色预警" */
export function qweatherAlertLine(json: unknown): string | undefined {
  const j = (json ?? {}) as QwAlertJson;
  const list = (j.alerts ?? []).filter((a) => a.messageType?.code !== 'cancel');
  const names = [...new Set(list.map((a) => a.eventType?.name || a.headline || '').filter(Boolean))];
  return names.length ? names.slice(0, 3).join('；') : undefined;
}

/** 和风天气 v1（/weather/v1/current、/weather/v1/daily、/weatheralert/v1/current）→ WeatherReport */
export function fromQWeather(current: unknown, daily: unknown, alerts: unknown, place: string, fetchedAt: number, isDay = true): WeatherReport {
  const c = (current ?? {}) as QwCurrentJson;
  const temp = num(c.temperature?.value);
  const text = c.condition?.text ?? '';
  if (temp == null || !text) throw new Error('和风天气返回里没有当前天气');
  const feels = num(c.feelsLike?.value);
  const humRaw = num(c.humidity);
  const days = ((daily ?? {}) as QwDailyJson).days ?? [];
  const today = qwDay(days[0]);
  const tomorrow = qwDay(days[1]);
  const alert = qweatherAlertLine(alerts);
  return {
    provider: 'qweather',
    place,
    text,
    icon: nightIcon(qweatherIcon(c.condition?.code, text), isDay),
    tempC: temp,
    ...(feels != null ? { feelsC: feels } : {}),
    ...(humRaw != null ? { humidity: Math.round(humRaw <= 1 ? humRaw * 100 : humRaw) } : {}),
    isDay,
    ...(today ? { today } : {}),
    ...(tomorrow ? { tomorrow } : {}),
    ...(alert ? { alert } : {}),
    fetchedAt,
  };
}

interface QwV7Now {
  now?: { temp?: string; feelsLike?: string; text?: string; icon?: string; humidity?: string };
}
interface QwV7Daily {
  daily?: { tempMax?: string; tempMin?: string; textDay?: string; textNight?: string }[];
}

/** 和风天气 v7（/v7/weather/now + /v7/weather/3d，老接口，账号还没开 v1 时用）→ WeatherReport */
export function fromQWeatherV7(now: unknown, daily: unknown, place: string, fetchedAt: number): WeatherReport {
  const n = ((now ?? {}) as QwV7Now).now ?? {};
  const temp = num(n.temp);
  const text = n.text ?? '';
  if (temp == null || !text) throw new Error('和风天气返回里没有当前天气');
  const day = (d: NonNullable<QwV7Daily['daily']>[number] | undefined): WeatherDay | undefined => {
    const max = num(d?.tempMax);
    const min = num(d?.tempMin);
    return d && max != null && min != null ? { maxC: max, minC: min, text: d.textDay || d.textNight || '' } : undefined;
  };
  const list = ((daily ?? {}) as QwV7Daily).daily ?? [];
  const today = day(list[0]);
  const tomorrow = day(list[1]);
  const feels = num(n.feelsLike);
  const hum = num(n.humidity);
  const code = num(n.icon);
  return {
    provider: 'qweather',
    place,
    text,
    icon: qweatherIcon(n.icon, text),
    tempC: temp,
    ...(feels != null ? { feelsC: feels } : {}),
    ...(hum != null ? { humidity: hum } : {}),
    isDay: code == null || code < 150 || code >= 200,
    ...(today ? { today } : {}),
    ...(tomorrow ? { tomorrow } : {}),
    fetchedAt,
  };
}

// —— 美国国家气象局的预警（api.weather.gov，免 Key，只有美国） ——

const NWS_WORDS: [RegExp, string][] = [
  [/Excessive Heat|Extreme Heat/i, '极端高温'],
  [/Heat/i, '高温'],
  [/Winter Storm/i, '冬季风暴'],
  [/Winter Weather/i, '冬季天气'],
  [/Blizzard/i, '暴风雪'],
  [/Ice Storm/i, '冰暴'],
  [/Lake Effect Snow/i, '湖效应降雪'],
  [/Snow Squall/i, '雪飑'],
  [/Extreme Cold|Wind Chill|Cold Weather/i, '严寒'],
  [/Hard Freeze|Freeze/i, '冰冻'],
  [/Frost/i, '霜冻'],
  [/Flash Flood/i, '山洪'],
  [/Coastal Flood/i, '沿海洪水'],
  [/Flood/i, '洪水'],
  [/Tornado/i, '龙卷风'],
  [/Severe Thunderstorm/i, '强雷暴'],
  [/Hurricane/i, '飓风'],
  [/Tropical Storm/i, '热带风暴'],
  [/Storm Surge/i, '风暴潮'],
  [/Extreme Wind|High Wind/i, '大风'],
  [/Wind/i, '风'],
  [/Dense Fog/i, '大雾'],
  [/Dense Smoke|Smoke/i, '烟雾'],
  [/Red Flag|Fire Weather/i, '火险'],
  [/Air Quality/i, '空气质量'],
  [/Dust/i, '沙尘'],
  [/High Surf|Rip Current/i, '大浪 / 离岸流'],
  [/Beach Hazards/i, '海滩危险'],
  [/Special Weather/i, '特别天气'],
  [/Small Craft/i, '小型船只'],
  [/Gale/i, '大风（海上）'],
  [/Avalanche/i, '雪崩'],
  [/Tsunami/i, '海啸'],
];

/** "Winter Storm Warning" → "冬季风暴警告（Winter Storm Warning）" */
export function nwsEventText(event: string): string {
  const what = NWS_WORDS.find(([re]) => re.test(event))?.[1];
  const level = /Warning/i.test(event) ? '警告' : /Watch/i.test(event) ? '注意' : /Advisory/i.test(event) ? '提示' : /Statement/i.test(event) ? '通报' : '';
  return what ? `${what}${level}（${event}）` : event;
}

interface NwsJson {
  features?: { properties?: { event?: string; status?: string; messageType?: string; severity?: string } }[];
}

/** api.weather.gov/alerts/active?point=… 的返回 → 一句话（没有预警时为空） */
export function nwsAlertLine(json: unknown): string | undefined {
  const list = ((json ?? {}) as NwsJson).features ?? [];
  const events = [
    ...new Set(
      list
        .map((f) => f.properties)
        .filter((p) => p && p.status !== 'Test' && p.messageType !== 'Cancel' && p.event)
        .map((p) => nwsEventText(p!.event!)),
    ),
  ];
  return events.length ? events.slice(0, 2).join('；') + (events.length > 2 ? ` 等 ${events.length} 条` : '') : undefined;
}

/** 大概在美国境内（包括阿拉斯加、夏威夷），决定要不要去取美国气象局的预警 */
export function roughlyInUS(lat: number, lng: number): boolean {
  const lower48 = lat >= 24 && lat <= 49.5 && lng >= -125 && lng <= -66.5;
  const alaska = lat >= 51 && lat <= 72 && lng >= -170 && lng <= -129;
  const hawaii = lat >= 18.5 && lat <= 22.5 && lng >= -161 && lng <= -154.5;
  return lower48 || alaska || hawaii;
}
