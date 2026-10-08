import { describe, it, expect } from 'vitest';
import { canTransition, nextStates } from '../../src/booking/state-machine';

describe('appointment state machine', () => {
  it('HELD may transition to CONFIRMED or CANCELLED', () => {
    expect(nextStates('HELD')).toEqual(['CONFIRMED', 'CANCELLED']);
  });

  it('CONFIRMED may transition to COMPLETED, CANCELLED, or NO_SHOW', () => {
    expect(nextStates('CONFIRMED')).toEqual(['COMPLETED', 'CANCELLED', 'NO_SHOW']);
  });

  it('CANCELLED, COMPLETED, and NO_SHOW are terminal', () => {
    expect(nextStates('CANCELLED')).toEqual([]);
    expect(nextStates('COMPLETED')).toEqual([]);
    expect(nextStates('NO_SHOW')).toEqual([]);
  });

  it('refuses illegal transitions', () => {
    expect(canTransition('HELD', 'NO_SHOW')).toBe(false);
    expect(canTransition('HELD', 'COMPLETED')).toBe(false);
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false);
    expect(canTransition('HELD', 'CONFIRMED')).toBe(true);
  });
});
