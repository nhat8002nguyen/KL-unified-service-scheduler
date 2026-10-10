import { describe, it, expect } from 'vitest';
import { findSlots } from '../../src/availability/availability.engine';
import type { AvailabilityContext, SlotSearchInput } from '../../src/availability/availability.types';
import type { ServiceTypeDetail } from '../../src/catalog/catalog.types';
import type { Dealership, ServiceBay, Technician } from '../../src/resources/resources.types';

const DAY = '2030-01-07';
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const at = (hhmm: string): string => new Date(`${DAY}T${hhmm}:00Z`).toISOString();

const dealership: Dealership = {
  id: 'd1',
  name: 'Demo',
  timezone: 'UTC',
  hours: WEEKDAYS.map((weekday) => ({ weekday, open: '08:00', close: '18:00' })),
};

const bays: ServiceBay[] = [
  { id: 'b1', dealershipId: 'd1', name: 'Express', bayTypeCode: 'express', active: true },
  { id: 'b2', dealershipId: 'd1', name: 'Diagnostic', bayTypeCode: 'diagnostic', active: true },
];

const tech: Technician = {
  id: 't1',
  dealershipId: 'd1',
  name: 'T1',
  active: true,
  skills: [{ skillCode: 'diagnostics', proficiency: 5 }],
  shifts: WEEKDAYS.map((weekday) => ({ weekday, start: '08:00', end: '17:00' })),
};

const oilChange: ServiceTypeDetail = {
  id: 's1', code: 'oil_change', name: 'Oil change', durationMin: 60, bufferMin: 30,
  requiredSkills: [], bayTypes: [{ bayTypeCode: 'express', kind: 'required' }],
};
const majorRepair: ServiceTypeDetail = {
  id: 's4', code: 'major_repair', name: 'Major repair', durationMin: 240, bufferMin: 0,
  requiredSkills: [], bayTypes: [{ bayTypeCode: 'express', kind: 'required' }],
};

function input(serviceType: ServiceTypeDetail, desiredAt: string): SlotSearchInput {
  return { dealershipId: 'd1', serviceType, desiredAt, horizonDays: 0, limit: 10, now: at('07:00') };
}

const ctx = (busy: AvailabilityContext['busy'] = []): AvailabilityContext => ({
  dealership,
  bays,
  technicians: [tech],
  busy,
});

describe('availability engine', () => {
  it('does not offer a 240-minute job in a 120-minute gap', () => {
    const busy = [{ bayId: 'b1', technicianId: 't1', startAt: at('10:00'), endAt: at('18:00') }];

    expect(findSlots(input(majorRepair, at('08:00')), ctx(busy))).toEqual([]);

    const oil = findSlots(input(oilChange, at('08:00')), ctx(busy));
    expect(oil.length).toBeGreaterThan(0);
    expect(oil.every((s) => Date.parse(s.endAt) <= Date.parse(at('10:00')))).toBe(true);
    expect(oil.some((s) => s.startAt === at('08:00'))).toBe(true);
  });

  it('keeps the slot at the service duration (buffer is not added to the slot)', () => {
    const slots = findSlots(input(oilChange, at('08:00')), ctx());

    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]?.startAt).toBe(at('08:00'));
    expect(slots[0]?.endAt).toBe(at('09:00'));
  });

  it('does not offer a slot overlapping the technician busy window (single capacity across bays)', () => {
    const busy = [{ bayId: 'b2', technicianId: 't1', startAt: at('09:00'), endAt: at('10:00') }];

    const slots = findSlots(input(oilChange, at('08:00')), ctx(busy));

    expect(slots.length).toBeGreaterThan(0);
    const overlapsBusy = slots.some(
      (s) => Date.parse(s.startAt) < Date.parse(at('10:00')) && Date.parse(at('09:00')) < Date.parse(s.endAt),
    );
    expect(overlapsBusy).toBe(false);
  });

  it('keeps slots inside dealership hours and ranks nearest to the desired time first', () => {
    const busy = [{ bayId: 'b1', technicianId: 't1', startAt: at('09:00'), endAt: at('10:00') }];

    const slots = findSlots(
      { ...input(oilChange, at('10:30')), limit: 50 },
      ctx(busy),
    );

    // busy 09:00-10:00 + 30min buffer => free blocks 08:00-09:00 and 10:30-17:00
    expect(slots[0]?.startAt).toBe(at('10:30'));
    expect(slots.some((s) => s.startAt === at('08:00'))).toBe(true);
    for (const s of slots) {
      expect(Date.parse(s.startAt)).toBeGreaterThanOrEqual(Date.parse(at('08:00')));
      expect(Date.parse(s.endAt)).toBeLessThanOrEqual(Date.parse(at('17:00')));
    }
  });

  it('offers a same-day slot when the free block began before now', () => {
    // now is 10:00; the block is 08:00-17:00 and the customer wants 15:00.
    const slots = findSlots(
      { dealershipId: 'd1', serviceType: oilChange, desiredAt: at('15:00'), horizonDays: 0, limit: 10, now: at('10:00') },
      ctx(),
    );

    expect(slots.some((s) => s.startAt === at('15:00'))).toBe(true);
    for (const s of slots) {
      expect(Date.parse(s.startAt)).toBeGreaterThanOrEqual(Date.parse(at('10:00')));
    }
  });

  it('emits multiple stepped starts inside a long free block and ranks nearest first', () => {
    const slots = findSlots(
      { dealershipId: 'd1', serviceType: oilChange, desiredAt: at('12:00'), horizonDays: 0, limit: 5, now: at('07:00') },
      ctx(),
    );

    expect(slots.length).toBe(5);
    expect(slots[0]?.startAt).toBe(at('12:00'));
    const starts = slots.map((s) => s.startAt);
    expect(starts).toContain(at('11:45'));
    expect(starts).toContain(at('12:15'));
  });
});
