import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app';
import { BookingServiceImpl } from '../../src/booking/booking.service';
import type { Appointment, AppointmentRepository } from '../../src/booking/booking.types';
import type { ServiceTypeDetail } from '../../src/catalog/catalog.types';
import type { Dealership, ServiceBay, Technician } from '../../src/resources/resources.types';

const dealershipId = 'd1';
const nowIso = '2030-01-07T07:00:00.000Z';
const startAt = '2030-01-07T08:00:00.000Z';
const endAt = '2030-01-07T09:00:00.000Z';
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const oilChange: ServiceTypeDetail = {
  id: 's1', code: 'oil_change', name: 'Oil change', durationMin: 60, bufferMin: 30,
  requiredSkills: [], bayTypes: [{ bayTypeCode: 'express', kind: 'required' }],
};
const dealership: Dealership = {
  id: dealershipId, name: 'Demo', timezone: 'UTC',
  hours: WEEKDAYS.map((weekday) => ({ weekday, open: '08:00', close: '18:00' })),
};
const bays: ServiceBay[] = [{ id: 'b1', dealershipId, name: 'Bay 1', bayTypeCode: 'express', active: true }];
const technicians: Technician[] = [
  { id: 't1', dealershipId, name: 'T1', active: true, skills: [], shifts: WEEKDAYS.map((w) => ({ weekday: w, start: '08:00', end: '17:00' })) },
];

const created: Appointment = {
  id: 'a1', dealershipId, customerId: 'c1', vehicleId: 'v1', serviceTypeId: 's1',
  bayId: 'b1', technicianId: 't1', startAt, endAt, status: 'HELD',
  holdExpiresAt: '2030-01-07T07:10:00.000Z', cancelledReason: null,
  createdAt: nowIso, updatedAt: nowIso,
};

const body = {
  dealership_id: dealershipId,
  service_type_code: 'oil_change',
  vin: 'VIN1',
  customer: { name: 'Demo Customer', email: 'c@example.com' },
  bay_id: 'b1',
  technician_id: 't1',
  start_at: startAt,
  end_at: endAt,
  idempotency_key: 'key-1',
};

function repoStub(overrides: Partial<AppointmentRepository> = {}): AppointmentRepository {
  return {
    busyIntervals: async () => [],
    getById: async () => null,
    createWithReserve: async () => ({ outcome: 'created', appointment: created }),
    updateStatus: async () => null,
    releaseExpiredHolds: async () => [],
    ...overrides,
  };
}

function makeApp(repo: AppointmentRepository): ReturnType<typeof buildApp> {
  const service = new BookingServiceImpl({
    catalog: { getServiceTypeDetail: async (c) => (c === 'oil_change' ? oilChange : null), listServiceTypes: async () => [oilChange] },
    vehicles: { getByVin: async (v) => (v === 'VIN1' ? { id: 'v1', vin: v, make: 'Honda', model: 'Civic', year: 2013 } : null) },
    dealerships: { getById: async (id) => (id === dealershipId ? dealership : null) },
    bays: { listByDealership: async () => bays },
    technicians: { listQualified: async () => technicians },
    customers: { upsert: async () => ({ id: 'c1' }) },
    appointments: repo,
    clock: () => new Date(nowIso),
  });
  return buildApp({ booking: service });
}

describe('POST /appointments', () => {
  it('creates a HELD appointment with a hold expiry', async () => {
    const res = await request(makeApp(repoStub())).post('/appointments').send(body);

    expect(res.status).toBe(201);
    expect(res.body.appointment.status).toBe('HELD');
    // The hold TTL runs from now(), so it expires after creation (not after the start).
    expect(Date.parse(res.body.appointment.holdExpiresAt)).toBeGreaterThan(
      Date.parse(res.body.appointment.createdAt),
    );
  });

  it('returns 409 slot_taken with next_available when the repo reports a conflict', async () => {
    const repo = repoStub({ createWithReserve: async () => ({ outcome: 'conflict' }) });
    const res = await request(makeApp(repo)).post('/appointments').send(body);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slot_taken');
    expect(Array.isArray(res.body.next_available)).toBe(true);
  });

  it('returns the same appointment for a duplicate idempotency key', async () => {
    const repo = repoStub({ createWithReserve: async () => ({ outcome: 'duplicate', appointment: created }) });
    const res = await request(makeApp(repo)).post('/appointments').send(body);

    expect(res.status).toBe(201);
    expect(res.body.appointment.id).toBe('a1');
  });

  it('rejects a bay that is not at the dealership with 422 INVALID_SLOT', async () => {
    const res = await request(makeApp(repoStub())).post('/appointments').send({ ...body, bay_id: 'other' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_SLOT');
  });

  it('rejects a slot whose length differs from the service duration', async () => {
    const res = await request(makeApp(repoStub()))
      .post('/appointments')
      .send({ ...body, end_at: '2030-01-07T08:30:00.000Z' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_SLOT');
  });

  it('rejects a slot outside the technician shift with 422', async () => {
    const res = await request(makeApp(repoStub()))
      .post('/appointments')
      .send({ ...body, start_at: '2030-01-07T05:00:00.000Z', end_at: '2030-01-07T06:00:00.000Z' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_SLOT');
  });
});

describe('appointment lifecycle', () => {
  it('POST /appointments/:id/confirm moves HELD -> CONFIRMED', async () => {
    const confirmed: Appointment = { ...created, status: 'CONFIRMED' };
    let captured: { from: string[]; to: string } | undefined;
    const repo = repoStub({
      updateStatus: async (_id, from, to) => {
        captured = { from, to };
        return to === 'CONFIRMED' ? confirmed : null;
      },
    });

    const res = await request(makeApp(repo)).post('/appointments/a1/confirm').send();

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('CONFIRMED');
    // the service drives the state machine's legal pair
    expect(captured).toEqual({ from: ['HELD'], to: 'CONFIRMED' });
  });

  it('POST /appointments/:id/confirm returns 409 when the update is refused', async () => {
    const repo = repoStub({ updateStatus: async () => null });

    const res = await request(makeApp(repo)).post('/appointments/a1/confirm').send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_TRANSITION');
  });

  it('POST /appointments/:id/cancel sets CANCELLED with a customer reason', async () => {
    const cancelled: Appointment = { ...created, status: 'CANCELLED', cancelledReason: 'cancelled_by_customer' };
    let capturedFrom: string[] = [];
    let capturedReason: string | undefined;
    const repo = repoStub({
      updateStatus: async (_id, from, to, extra) => {
        capturedFrom = from;
        capturedReason = extra?.cancelledReason;
        return to === 'CANCELLED' ? cancelled : null;
      },
    });

    const res = await request(makeApp(repo)).post('/appointments/a1/cancel').send();

    expect(res.status).toBe(200);
    expect(capturedFrom).toEqual(['HELD', 'CONFIRMED']);
    expect(capturedReason).toBe('cancelled_by_customer');
  });

  it('GET /appointments/:id returns the appointment', async () => {
    const res = await request(makeApp(repoStub({ getById: async () => created }))).get('/appointments/a1');

    expect(res.status).toBe(200);
    expect(res.body.appointment.id).toBe('a1');
  });

  it('GET /appointments/:id returns 404 when missing', async () => {
    const res = await request(makeApp(repoStub({ getById: async () => null }))).get('/appointments/nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
