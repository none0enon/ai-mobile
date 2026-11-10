const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 距今天相差几天（今天 0，昨天 -1） */
export function dayOffset(ts: number, now = Date.now()): number {
  return Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
}

/** 消息列表右上角的时间：今天显示 21:28，昨天显示"昨天"，一周内显示"周六"，更早显示 11/02 */
export function listTime(ts: number, now = Date.now()): string {
  const off = dayOffset(ts, now);
  if (off === 0) return hhmm(ts);
  if (off === -1) return '昨天';
  if (off > -7) return WEEKDAYS[new Date(ts).getDay()] ?? '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 聊天里的时间分隔条："今天 07:30" / "昨天 23:41" / "周六 20:10" */
export function dividerTime(ts: number, now = Date.now()): string {
  const off = dayOffset(ts, now);
  const day = off === 0 ? '今天' : off === -1 ? '昨天' : off > -7 ? (WEEKDAYS[new Date(ts).getDay()] ?? '') : `${new Date(ts).getMonth() + 1}月${new Date(ts).getDate()}日`;
  return `${day} ${hhmm(ts)}`;
}

export function weekday(ts: number): string {
  return WEEKDAYS[new Date(ts).getDay()] ?? '';
}

export function monthDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 01:02:03 或 02:03 */
export function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** 以今天为基准造一个时间点：at(-1, '23:41') = 昨天 23:41 */
export function at(dayOff: number, time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOff);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}
