/** Pure time helpers. All instants are UTC; wall-clock->UTC conversion lives in the availability module. */

export const MINUTE_MS = 60_000;

/** toIso formats a Date as an ISO-8601 UTC string. */
export function toIso(d: Date): string {
  return d.toISOString();
}

/** parseInstant parses an ISO instant, throwing on an invalid value. */
export function parseInstant(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid instant: ${value}`);
  }
  return d;
}

/** isValidInstant reports whether a string parses to a valid instant. */
export function isValidInstant(value: string): boolean {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

/** addMinutes returns a new Date shifted by the given number of minutes. */
export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE_MS);
}

/** minutesBetween returns the signed minutes from a to b. */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE_MS;
}

/** clockHhMm trims a Postgres `time` value ('HH:MM:SS[.sss]') to a local 'HH:MM'. */
export function clockHhMm(value: string): string {
  return value.slice(0, 5);
}

