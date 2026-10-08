/** Timezone math: dealership-local wall clock <-> UTC. All instants stay UTC. */

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** wallClockAt returns the wall-clock date and time of an instant in a zone. */
export function wallClockAt(at: Date, timeZone: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
  };
}

/** localDateOf returns the local calendar date of an instant in a zone. */
export function localDateOf(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const w = wallClockAt(at, timeZone);
  return { year: w.year, month: w.month, day: w.day };
}

/** localWeekday returns the local calendar weekday (0=Sunday) of an instant in a zone. */
export function localWeekday(at: Date, timeZone: string): number {
  const d = localDateOf(at, timeZone);
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** localMinuteOfDay returns minutes since local midnight (e.g. 08:30 -> 510). */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const w = wallClockAt(at, timeZone);
  return w.hour * 60 + w.minute;
}

/** sameLocalDay reports whether two instants fall on the same local calendar day. */
export function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const x = localDateOf(a, timeZone);
  const y = localDateOf(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** zoneOffsetMinutes returns the offset in minutes of a zone from UTC at an instant. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const w = wallClockAt(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const instantMinute = Math.floor(at.getTime() / 60_000) * 60_000;
  return (asUtc - instantMinute) / 60_000;
}

/** zonedWallClockUtc converts a local wall clock ('HH:MM') on a local date to a UTC instant (DST-safe). */
export function zonedWallClockUtc(
  year: number,
  month: number,
  day: number,
  hhmm: string,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hhMmToMinutes(hhmm) / 60, hhMmToMinutes(hhmm) % 60);
  let utc = guess - zoneOffsetMinutes(timeZone, new Date(guess)) * 60_000;
  utc = guess - zoneOffsetMinutes(timeZone, new Date(utc)) * 60_000;
  return new Date(utc);
}

/** hhMmToMinutes converts 'HH:MM' to minutes since midnight. */
export function hhMmToMinutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}
