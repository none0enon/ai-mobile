const formatters = new Map<string, Intl.DateTimeFormat>();
/** Calendar operations use the user's IANA zone, never the Worker's UTC clock. */
export function zonedParts(at: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const get = (name: string) => Number(parts.find((p) => p.type === name)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

export function zonedDateKey(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Wall time → instant. A repeated DST time uses its first occurrence; a gap moves forward. */
export function zonedInstant(date: string, minute: number, timeZone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const instant = wall + delta * 3_600_000;
    const p = zonedParts(instant, timeZone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant);
  }
  const candidates = [...offsets].map((offset) => wall - offset).sort((a, b) => a - b);
  const exact = candidates.find((instant) => {
    const p = zonedParts(instant, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wall;
  });
  return exact ?? candidates[candidates.length - 1]!;
}

/** For existing formatting/macro APIs that consume local Date getters, not arithmetic. */
export function wallDate(at: number, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
