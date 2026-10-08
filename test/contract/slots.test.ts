import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app';
import { BookingServiceImpl } from '../../src/booking/booking.service';
import type { AppointmentRepository } from '../../src/booking/booking.types';
import type { ServiceTypeDetail } from '../../src/catalog/catalog.types';
import type { AvailabilityContext } from '../../src/availability/availability.types';
import type { Dealership, ServiceBay, Technician } from '../../src/resources/resources.types';

const dealershipId = 'd1';
const nowIso = '2030-01-07T07:00:00.000Z';
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const oilChange: ServiceTypeDetail = {
  id: 's1', code: 'oil_change', name: 'Oil change', durationMin: 60, bufferMin: 30,
  requiredSkills: [], bayTypes: [{ bayTypeCode: 'express', kind: 'required' }],
};

const dealership: Dealership = {
  id: dealershipId, name: 'Demo', timezone: 'UTC',
  hours: WEEKDAYS.map((weekday) => ({ weekday, open: '08:00', close: '18:00' })),
};

const bays: ServiceBay[] = [
  { id: 'b1', dealershipId, name: 'Bay 1', bayTypeCode: 'express', active: true },
  { id: 'leak-bay', dealershipId: 'other', name: 'Foreign bay', bayTypeCode: 'express', active: true },
];
const technicians: Technician[] = [
  { id: 't1', dealershipId, name: 'T1', active: true, skills: [], shifts: WEEKDAYS.map((w) => ({ weekday: w, start: '08:00', end: '17:00' })) },
  { id: 'leak-tech', dealershipId: 'other', name: 'Foreign tech', active: true, skills: [], shifts: WEEKDAYS.map((w) => ({ weekday: w, start: '08:00', end: '17:00' })) },
];

// A busy window that (with the 30-min buffer) splits the day into two free blocks.
const busy = [
  { bayId: 'b1', technicianId: 't1', startAt: '2030-01-07T10:00:00.000Z', endAt: '2030-01-07T12:00:00.000Z' },
];

function makeApp(): ReturnType<typeof buildApp> {
  const appointments: AppointmentRepository = {
    busyIntervals: async () => busy,
    getById: async () => null,
    createWithReserve: async () => ({ outcome: 'conflict' }),
    updateStatus: async () => null,
    releaseExpiredHolds: async () => [],
  };
  const service = new BookingServiceImpl({
    catalog: { getServiceTypeDetail: async (code) => (code === 'oil_change' ? oilChange : null), listServiceTypes: async () => [oilChange] },
    vehicles: { getByVin: async (vin) => (vin === 'VIN1' ? { id: 'v1', vin, make: 'Honda', model: 'Civic', year: 2013 } : null) },
    dealerships: { getById: async (id) => (id === dealershipId ? dealership : null) },
    bays: { listByDealership: async () => bays },
    technicians: { listQualified: async () => technicians },
    customers: { upsert: async () => ({ id: 'c1' }) },
    appointments,
    clock: () => new Date(nowIso),
  });
  return buildApp({ booking: service });
}

const baseQuery = {
  dealership_id: dealershipId,
  service_type_code: 'oil_change',
  vin: 'VIN1',
  desired_at: '2030-01-07T09:00:00Z',
};

describe('GET /slots', () => {
  it('returns ranked slots, nearest to the desired time first', async () => {
    const res = await request(makeApp()).get('/slots').query(baseQuery);

    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);

    const starts = res.body.slots.map((s: { startAt: string }) => Date.parse(s.startAt));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // 10:00-12:00 busy + 30min buffer => free 08:00-10:00 and 12:30-17:00
    expect(res.body.slots[0].startAt).toBe('2030-01-07T08:00:00.000Z');
  });

  it('rejects a desired time in the past with 422', async () => {
    const res = await request(makeApp())
      .get('/slots')
      .query({ ...baseQuery, desired_at: '2020-01-01T00:00:00Z' });

    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown service type', async () => {
    const res = await request(makeApp())
      .get('/slots')
      .query({ ...baseQuery, service_type_code: 'nope' });

    expect(res.status).toBe(404);
  });

  it('never returns a bay or technician from another dealership', async () => {
    const res = await request(makeApp()).get('/slots').query(baseQuery);

    expect(res.status).toBe(200);
    for (const slot of res.body.slots as { dealershipId: string; bayId: string; technicianId: string }[]) {
      expect(slot.dealershipId).toBe(dealershipId);
      expect(slot.bayId).not.toBe('leak-bay');
      expect(slot.technicianId).not.toBe('leak-tech');
    }
  });
});

// Referenced so the fixture type stays honest if AvailabilityContext changes.
export type _BusyShape = AvailabilityContext['busy'];
