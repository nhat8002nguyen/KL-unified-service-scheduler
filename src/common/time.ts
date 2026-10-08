/** Pure time helpers. All instants are UTC; wall-clock->UTC conversion lives in the availability module. */

export const MINUTE_MS = 60_000;

export function toIso(d: Date): string {
  return d.toISOString();
}

export function parseInstant(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid instant: ${value}`);
  }
  return d;
}

export function isValidInstant(value: string): boolean {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE_MS);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE_MS;
}

/** Trim a Postgres `time` value ('HH:MM:SS[.sss]') to a local 'HH:MM'. */
export function clockHhMm(value: string): string {
  return value.slice(0, 5);
}

