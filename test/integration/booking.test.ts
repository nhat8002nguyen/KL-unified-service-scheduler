import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knexLib from 'knex';
import { Pool } from 'pg';
import { PgAppointmentRepo } from '../../src/booking/booking.repo';
import type { ReserveInput } from '../../src/booking/booking.types';
import { knexConfig } from '../../src/db/knexconfig';
import { SEED } from '../../src/db/seed-ids';
import { seed } from '../../src/db/seeds/001_demo';
import { PgOutboxWriter } from '../../src/outbox/outbox.repo';

const url = process.env['DATABASE_URL'];
const maybe = url ? describe : describe.skip;

const DAY = { y: 2031, m: 0, d: 6 };
const at = (hour: number, minute = 0): string => new Date(Date.UTC(DAY.y, DAY.m, DAY.d, hour, minute)).toISOString();

maybe('appointment reserve (PostgreSQL 17)', () => {
  let pool: Pool;
  let repo: PgAppointmentRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    repo = new PgAppointmentRepo(pool, new PgOutboxWriter());
    await pool.query("delete from appointment where idempotency_key like 'reserve-%'");
  });
  afterAll(async () => {
    await pool?.end();
  });

  function reserve(
    key: string,
    hour: number,
    bayId: string = SEED.bays.diagnostic1,
  ): ReserveInput {
    return {
      dealershipId: SEED.dealership,
      serviceTypeId: SEED.serviceTypes.diagnostic,
      vehicleId: SEED.vehicle,
      customerId: SEED.customer,
      bayId,
      technicianId: SEED.technicians.master,
      startAt: at(hour),
      endAt: at(hour + 1),
      idempotencyKey: key,
      holdMinutes: 10,
    };
  }

  it('creates a HELD appointment and writes an AppointmentHeld event in the same transaction', async () => {
    const res = await repo.createWithReserve(reserve(`reserve-${Date.now()}-a`, 9));

    expect(res.outcome).toBe('created');
    if (res.outcome !== 'created') return;
    expect(res.appointment.status).toBe('HELD');
    expect(res.appointment.holdExpiresAt).not.toBeNull();

    const events = await pool.query<{ event_type: string }>(
      'select event_type from outbox where aggregate_id = $1 order by id',
      [res.appointment.id],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(['AppointmentHeld']);
  });

  it('returns the same appointment for a repeated idempotency key (no second row)', async () => {
    const key = `reserve-${Date.now()}-dup`;
    const first = await repo.createWithReserve(reserve(key, 11));
    const second = await repo.createWithReserve(reserve(key, 11));

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('duplicate');
    if (first.outcome !== 'created' || second.outcome !== 'duplicate') return;
    expect(second.appointment.id).toBe(first.appointment.id);

    const count = await pool.query<{ n: number }>(
      'select count(*)::int as n from appointment where idempotency_key = $1',
      [key],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('returns a conflict for an overlapping booking on the same bay', async () => {
    const stamp = Date.now();
    const first = await repo.createWithReserve(reserve(`reserve-${stamp}-bay1`, 13));
    expect(first.outcome).toBe('created');

    const overlap = await repo.createWithReserve({
      ...reserve(`reserve-${stamp}-bay2`, 13),
      startAt: at(13, 30),
      endAt: at(14, 30),
    });
    expect(overlap.outcome).toBe('conflict');
  });

  it('returns a conflict for an overlapping booking on the same technician in a DIFFERENT bay', async () => {
    const stamp = Date.now();
    const first = await repo.createWithReserve(reserve(`reserve-${stamp}-tech1`, 15));
    expect(first.outcome).toBe('created');

    const overlap = await repo.createWithReserve(
      reserve(`reserve-${stamp}-tech2`, 15, SEED.bays.diagnostic2),
    );
    expect(overlap.outcome).toBe('conflict');
  });

  it('updateStatus applies only when the current status is in the allowed from-set', async () => {
    const stamp = Date.now();
    const created = await repo.createWithReserve(reserve(`reserve-${stamp}-life`, 17));
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;
    const id = created.appointment.id;

    // row is HELD; an update guarded on CONFIRMED must not apply
    expect(await repo.updateStatus(id, ['CONFIRMED'], 'CANCELLED')).toBeNull();

    expect((await repo.updateStatus(id, ['HELD'], 'CONFIRMED'))?.status).toBe('CONFIRMED');
    // now CONFIRMED; a HELD-guarded update must not apply again
    expect(await repo.updateStatus(id, ['HELD'], 'CONFIRMED')).toBeNull();
    expect((await repo.updateStatus(id, ['CONFIRMED'], 'NO_SHOW'))?.status).toBe('NO_SHOW');
  });

  it('releaseExpiredHolds cancels only expired HELD appointments', async () => {
    const stamp = Date.now();
    const created = await repo.createWithReserve(reserve(`reserve-${stamp}-reap`, 18));
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    await pool.query(
      "update appointment set hold_expires_at = now() - interval '1 minute' where id = $1",
      [created.appointment.id],
    );
    const released = await repo.releaseExpiredHolds(new Date().toISOString());

    expect(released).toContain(created.appointment.id);
    const after = await repo.getById(created.appointment.id);
    expect(after?.status).toBe('CANCELLED');
    expect(after?.cancelledReason).toBe('hold_expired');
  });

  it('a cancelled appointment frees its interval for rebooking (exclusion ignores non-active rows)', async () => {
    const stamp = Date.now();
    const first = await repo.createWithReserve(reserve(`reserve-${stamp}-free1`, 20));
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') return;

    await repo.updateStatus(first.appointment.id, ['HELD'], 'CANCELLED', { cancelledReason: 'test' });

    const again = await repo.createWithReserve(reserve(`reserve-${stamp}-free2`, 20));
    expect(again.outcome).toBe('created');
  });

  it('re-running the seed does not delete existing appointments', async () => {
    const stamp = Date.now();
    const created = await repo.createWithReserve(reserve(`reserve-${stamp}-keep`, 21));
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    const db = knexLib(knexConfig());
    try {
      await seed(db);
    } finally {
      await db.destroy();
    }

    expect(await repo.getById(created.appointment.id)).not.toBeNull();
  });
});
