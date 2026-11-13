import type { TimeOfDay } from './scenes.ts';
import { calendarParts } from './timezone.ts';

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  dawn: '清晨',
  morning: '上午',
  noon: '中午',
  afternoon: '下午',
  dusk: '傍晚',
  night: '夜里',
  late: '深夜',
};

export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 19) return 'dusk';
  if (hour >= 19 && hour < 23) return 'night';
  return 'late';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 二十四节气的近似日期（每年前后差一天）。骨架阶段够用；
 * M3 换成 lunar-javascript 精确计算，并加入农历和法定节假日表。
 */
const SOLAR_TERMS: [number, number, string][] = [
  [1, 5, '小寒'], [1, 20, '大寒'], [2, 4, '立春'], [2, 19, '雨水'], [3, 5, '惊蛰'], [3, 20, '春分'],
  [4, 5, '清明'], [4, 20, '谷雨'], [5, 5, '立夏'], [5, 21, '小满'], [6, 5, '芒种'], [6, 21, '夏至'],
  [7, 7, '小暑'], [7, 22, '大暑'], [8, 7, '立秋'], [8, 23, '处暑'], [9, 7, '白露'], [9, 23, '秋分'],
  [10, 8, '寒露'], [10, 23, '霜降'], [11, 7, '立冬'], [11, 22, '小雪'], [12, 7, '大雪'], [12, 21, '冬至'],
];

/** 返回"立冬"（当天）或"立冬后第 2 天"（7 天内），更远则返回 null */
export function solarTermNote(date: Date, timeZone?: string): string | null {
  const p = calendarParts(date.getTime(), timeZone);
  const day = Date.UTC(p.year, p.month - 1, p.day);
  let best: { name: string; diff: number } | null = null;
  for (const year of [p.year - 1, p.year]) {
    for (const [m, d, name] of SOLAR_TERMS) {
      const diff = Math.round((day - Date.UTC(year, m - 1, d)) / 86_400_000);
      if (diff >= 0 && (!best || diff < best.diff)) best = { name, diff };
    }
  }
  if (!best || best.diff > 7) return null;
  return best.diff === 0 ? `今天${best.name}` : `${best.name}后第 ${best.diff} 天`;
}

export interface WeatherSnapshot {
  city: string;
  text: string;
  tempC: number;
  /** 你用华氏时，温度后面括号里带一个华氏（她说的时候两种都能用） */
  unit?: 'c' | 'f';
  /** 例如"明天降到 6°C" */
  outlook?: string;
  alert?: string;
}

export interface EnvironmentInput {
  now: Date;
  timeZone?: string;
  /** 你那边的天气 */
  weather?: WeatherSnapshot | null;
  /** 她那边的天气：她住在别的城市时（例如国内的角色用中国的天气）；和你在同一个地方时不给 */
  herWeather?: (WeatherSnapshot & { name: string }) | null;
  /** 今日活动的一句话描述，例如"你今天走了 8,432 步，午饭吃了拉面，晚饭还没记录" */
  todayLine?: string;
  sinceLastChatMin?: number | null;
  sceneName?: string | null;
  /** 她在哪 / 你们一起在哪，例如"你们一起在图书馆" */
  place?: string | null;
  /** 她今天穿什么（节律），例如"苏晚今天穿米色针织开衫配白衬衫" */
  outfit?: string | null;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function formatDuration(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** "上海 小雨 12°C，今天 9~13°C，明天降温（暴雨黄色预警）"；用华氏的人温度后面带一个华氏 */
export function weatherLine(w: WeatherSnapshot): string {
  const f = w.unit === 'f' ? `（${Math.round((w.tempC * 9) / 5 + 32)}°F）` : '';
  let line = `${w.city} ${w.text} ${w.tempC}°C${f}`;
  if (w.outlook) line += `，${w.outlook}`;
  if (w.alert) line += `（${w.alert}）`;
  return line;
}

/**
 * 拼出注入提示词的【当前环境】块。客户端每轮对话前调用，Worker 写主动消息时也用同一个函数。
 */
export function formatEnvironmentBlock(input: EnvironmentInput): string {
  const d = calendarParts(input.now.getTime(), input.timeZone);
  const parts: string[] = [];
  parts.push(
    `${d.year}-${pad(d.month)}-${pad(d.day)} ${WEEKDAYS[d.weekday]} ${pad(d.hour)}:${pad(d.minute)}（${TIME_OF_DAY_LABEL[timeOfDay(d.hour)]}）`,
  );
  const term = solarTermNote(input.now, input.timeZone);
  if (term) parts.push(term);
  const her = input.herWeather;
  if (input.weather && her) {
    parts.push(`你那边：${weatherLine(input.weather)}`);
    parts.push(`${her.name}那边：${weatherLine(her)}`);
  } else if (input.weather) {
    parts.push(weatherLine(input.weather));
  } else if (her) {
    parts.push(`${her.name}那边：${weatherLine(her)}`);
  }
  if (input.todayLine) parts.push(input.todayLine);
  if (input.sinceLastChatMin != null) parts.push(`距上次聊天 ${formatDuration(input.sinceLastChatMin)}`);
  if (input.place) parts.push(input.place);
  if (input.outfit) parts.push(input.outfit);
  if (input.sceneName) parts.push(`当前场景：${input.sceneName}`);
  return `【当前环境】${parts.join(' · ')}`;
}
