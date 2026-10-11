/** Half-open interval arithmetic: [start, end). Pure and unit-tested. */

export interface Interval {
  start: Date;
  end: Date;
}

/** interval builds a half-open [start, end) interval from two dates. */
export function interval(start: Date, end: Date): Interval {
  return { start, end };
}

/** minutes returns the length of the interval in whole minutes. */
export function minutes(i: Interval): number {
  return (i.end.getTime() - i.start.getTime()) / 60_000;
}

/** overlaps reports whether the two half-open intervals share more than a boundary. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** union merges overlapping or touching intervals into sorted, disjoint intervals. */
export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** subtract removes `cuts` from `base`, returning the remaining pieces in order. */
export function subtract(base: Interval, cuts: Interval[]): Interval[] {
  let segments: Interval[] = [{ start: base.start, end: base.end }];
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const seg of segments) {
      if (!overlaps(seg, cut)) {
        next.push(seg);
        continue;
      }
      if (seg.start.getTime() < cut.start.getTime()) {
        next.push({ start: seg.start, end: cut.start });
      }
      if (cut.end.getTime() < seg.end.getTime()) {
        next.push({ start: cut.end, end: seg.end });
      }
    }
    segments = next;
  }
  return segments.filter((s) => s.end.getTime() > s.start.getTime());
}

/** subtractAll removes `cuts` from every base interval. */
export function subtractAll(bases: Interval[], cuts: Interval[]): Interval[] {
  return bases.flatMap((base) => subtract(base, cuts));
}

/** intersect computes the pairwise intersection of two interval lists, sorted by start. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = x.start.getTime() > y.start.getTime() ? x.start : y.start;
      const end = x.end.getTime() < y.end.getTime() ? x.end : y.end;
      if (end.getTime() > start.getTime()) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start.getTime() - q.start.getTime());
}
