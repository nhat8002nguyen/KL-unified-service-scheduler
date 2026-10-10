import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { Express } from 'express';
import { buildApp } from '../../src/app';
import { PgAppointmentRepo, PgCustomerRepo } from '../../src/booking/booking.repo';
import { BookingServiceImpl } from '../../src/booking/booking.service';
import { PgCatalogRepo } from '../../src/catalog/catalog.repo';
import { SEED, SEED_VIN } from '../../src/db/seed-ids';
import { PgDiaryRepo } from '../../src/diary/diary.repo';
import { DiaryServiceImpl } from '../../src/diary/diary.service';
import { PgOutboxWriter } from '../../src/outbox/outbox.repo';
import { PgResourcesRepo } from '../../src/resources/resources.repo';

const url = process.env['DATABASE_URL'];
const maybe = url ? describe : describe.skip;

maybe('concurrent booking end to end', () => {
  let pool: Pool;
  let app: Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });

    const outbox = new PgOutboxWriter();
    const catalog = new PgCatalogRepo(pool);
    const resources = new PgResourcesRepo(pool);
    const appointments = new PgAppointmentRepo(pool, outbox);
    const customers = new PgCustomerRepo(pool);

    app = buildApp({
      catalog,
      resources: { vehicles: resources, dealerships: resources, bays: resources, technicians: resources },
      diary: new DiaryServiceImpl({ diary: new PgDiaryRepo(pool), dealerships: resources, bays: resources, technicians: resources }),
      booking: new BookingServiceImpl({
        catalog,
        vehicles: resources,
        dealerships: resources,
        bays: resources,
        technicians: resources,
        customers,
        appointments,
      }),
    });

    // idempotent across runs: clear rows this test created previously
    await pool.query("delete from appointment where idempotency_key like 'concurrency-%'");
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('two concurrent POSTs for the same slot produce exactly one 201 and one 409', async () => {
    const desiredAt = new Date(Date.now() + 3_600_000).toISOString();
    const slotsRes = await request(app).get('/slots').query({
      dealership_id: SEED.dealership,
      service_type_code: 'diagnostic',
      vin: SEED_VIN,
      desired_at: desiredAt,
      horizon_days: 7,
    });
    expect(slotsRes.status).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);

    const slot = slotsRes.body.slots[0];
    const body = {
      dealership_id: SEED.dealership,
      service_type_code: 'diagnostic',
      vin: SEED_VIN,
      customer: { name: 'Race Customer', email: 'race@example.com' },
      bay_id: slot.bayId,
      technician_id: slot.technicianId,
      start_at: slot.startAt,
      end_at: slot.endAt,
    };
    const stamp = Date.now();

    const [a, b] = await Promise.all([
      request(app).post('/appointments').send({ ...body, idempotency_key: `concurrency-${stamp}-a` }),
      request(app).post('/appointments').send({ ...body, idempotency_key: `concurrency-${stamp}-b` }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.error).toBe('slot_taken');
    expect(Array.isArray(conflict.body.next_available)).toBe(true);

    const count = await pool.query<{ n: number }>(
      `select count(*)::int as n from appointment
        where service_bay_id = $1 and technician_id = $2
          and tstzrange(start_at, end_at) && tstzrange($3::timestamptz, $4::timestamptz)`,
      [slot.bayId, slot.technicianId, slot.startAt, slot.endAt],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('GET /metrics exposes the booking counters and request histogram', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('appointments_total');
    expect(res.text).toContain('http_request_duration_seconds');
  });

  it('two concurrent POSTs with the SAME idempotency key both return that appointment', async () => {
    const desiredAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const slotsRes = await request(app).get('/slots').query({
      dealership_id: SEED.dealership,
      service_type_code: 'diagnostic',
      vin: SEED_VIN,
      desired_at: desiredAt,
      horizon_days: 7,
    });
    expect(slotsRes.status).toBe(200);
    const slot = slotsRes.body.slots[0];
    expect(slot).toBeDefined();

    const key = `concurrency-same-${Date.now()}`;
    const body = {
      dealership_id: SEED.dealership,
      service_type_code: 'diagnostic',
      vin: SEED_VIN,
      customer: { name: 'Retry Customer', email: 'retry@example.com' },
      bay_id: slot.bayId,
      technician_id: slot.technicianId,
      start_at: slot.startAt,
      end_at: slot.endAt,
      idempotency_key: key,
    };

    const [a, b] = await Promise.all([
      request(app).post('/appointments').send(body),
      request(app).post('/appointments').send(body),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.appointment.id).toBe(b.body.appointment.id);

    const count = await pool.query<{ n: number }>(
      'select count(*)::int as n from appointment where idempotency_key = $1',
      [key],
    );
    expect(count.rows[0]?.n).toBe(1);
  });
});
