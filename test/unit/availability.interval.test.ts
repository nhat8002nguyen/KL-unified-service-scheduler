import { describe, it, expect } from 'vitest';
import { subtract, subtractAll, union, intersect, overlaps, minutes } from '../../src/availability/interval';

const at = (h: number, m = 0): Date => new Date(Date.UTC(2030, 0, 7, h, m));
const r = (a: number, b: number) => ({ start: at(a), end: at(b) });

describe('interval algebra', () => {
  it('subtract removes overlapping and contained cuts', () => {
    expect(subtract(r(8, 18), [r(9, 10), r(11, 12)])).toEqual([r(8, 9), r(10, 11), r(12, 18)]);
  });

  it('subtract yields no interval when a cut covers the whole base', () => {
    expect(subtract(r(8, 18), [r(7, 19)])).toEqual([]);
  });

  it('subtract ignores cuts that do not overlap, and treats touching as non-overlapping', () => {
    expect(subtract(r(8, 10), [r(10, 12)])).toEqual([r(8, 10)]);
    expect(subtract(r(8, 10), [r(6, 8)])).toEqual([r(8, 10)]);
  });

  it('union merges overlapping and touching intervals', () => {
    expect(union([r(8, 10), r(9, 12), r(13, 14)])).toEqual([r(8, 12), r(13, 14)]);
  });

  it('intersect returns pairwise overlaps in order', () => {
    expect(intersect([r(8, 12)], [r(9, 10), r(11, 13)])).toEqual([r(9, 10), r(11, 12)]);
  });

  it('reports overlap and duration', () => {
    expect(overlaps(r(8, 9), r(9, 10))).toBe(false);
    expect(overlaps(r(8, 10), r(9, 11))).toBe(true);
    expect(minutes(r(8, 9))).toBe(60);
  });

  it('subtractAll subtracts the same cuts from every base', () => {
    expect(subtractAll([r(8, 10), r(12, 14)], [r(9, 13)])).toEqual([r(8, 9), r(13, 14)]);
  });
});
