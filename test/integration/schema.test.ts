import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { SEED } from '../../src/db/seed-ids';

const url = process.env['DATABASE_URL'];
const maybe = url ? describe : describe.skip;

/**
 * Verifies the diary's structural guarantees against a real PostgreSQL 17.
 * Requires `DATABASE_URL` (compose db) and the seed loaded.
 */
maybe('appointment schema', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    // Idempotent across runs: clear any rows this test created previously.
    await pool.query("delete from appointment where idempotency_key like 'schema-test-%'");
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('is hash-partitioned by dealership_id into 4 partitions', async () => {
    const strat = await pool.query<{ partstrat: string }>(
      `select p.partstrat from pg_partitioned_table p
         join pg_class c on c.oid = p.partrelid
        where c.relname = 'appointment'`,
    );
    expect(strat.rows[0]?.partstrat).toBe('h');

    const parts = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_inherits where inhparent = 'appointment'::regclass`,
    );
    expect(parts.rows[0]?.n).toBe(4);
  });

  it('declares both exclusion constraints on the parent', async () => {
    const cons = await pool.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'appointment'::regclass and contype = 'x'
        order by conname`,
    );
    expect(cons.rows.map((r) => r.conname)).toEqual(['no_bay_overlap', 'no_tech_overlap']);
  });

  it('rejects an overlapping booking for the same bay with SQLSTATE 23P01', async () => {
    const insert = (idempotencyKey: string, offsetMin: number): string => `
      insert into appointment (dealership_id, customer_id, vehicle_id, service_type_id,
        service_bay_id, technician_id, start_at, end_at, status, idempotency_key, request_fingerprint)
      values ('${SEED.dealership}', '${SEED.customer}', '${SEED.vehicle}', '${SEED.serviceTypes.diagnostic}',
        '${SEED.bays.diagnostic1}', '${SEED.technicians.master}',
        '2030-01-07T09:00:00Z'::timestamptz + interval '${offsetMin} minutes',
        '2030-01-07T10:00:00Z'::timestamptz + interval '${offsetMin} minutes',
        'CONFIRMED', '${idempotencyKey}', 'fp')`;

    await pool.query(insert(`schema-test-${Date.now()}-a`, 0));
    await expect(pool.query(insert(`schema-test-${Date.now()}-b`, 30))).rejects.toMatchObject({
      code: '23P01',
    });
  });

  it('has a partial unique index on active idempotency keys only', async () => {
    const idx = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'appointment' and indexname = 'appointment_active_idempotency_uidx'`,
    );
    expect(idx.rows[0]?.indexdef).toMatch(/WHERE/);
    expect(idx.rows[0]?.indexdef).toMatch(/HELD/);
  });

  it('allows reusing an idempotency key after CANCELLED', async () => {
    const key = `schema-test-${Date.now()}-reuse`;
    const base = `insert into appointment (dealership_id, customer_id, vehicle_id, service_type_id,
        service_bay_id, technician_id, start_at, end_at, status, idempotency_key, request_fingerprint)
      values ('${SEED.dealership}', '${SEED.customer}', '${SEED.vehicle}', '${SEED.serviceTypes.diagnostic}',
        '${SEED.bays.diagnostic1}', '${SEED.technicians.master}',
        $1::timestamptz, $2::timestamptz, $3, '${key}', 'fp')`;
    await pool.query(base, ['2030-02-01T09:00:00Z', '2030-02-01T10:00:00Z', 'CANCELLED']);
    await expect(
      pool.query(base, ['2030-02-01T11:00:00Z', '2030-02-01T12:00:00Z', 'HELD']),
    ).resolves.toBeDefined();
  });

  it('rejects two active rows with the same idempotency key', async () => {
    const key = `schema-test-${Date.now()}-active-dup`;
    const insert = (status: string, start: string, end: string) =>
      pool.query(
        `insert into appointment (dealership_id, customer_id, vehicle_id, service_type_id,
           service_bay_id, technician_id, start_at, end_at, status, idempotency_key, request_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10,'fp')`,
        [
          SEED.dealership,
          SEED.customer,
          SEED.vehicle,
          SEED.serviceTypes.diagnostic,
          SEED.bays.diagnostic1,
          SEED.technicians.master,
          start,
          end,
          status,
          key,
        ],
      );
    await insert('HELD', '2030-02-02T09:00:00Z', '2030-02-02T10:00:00Z');
    await expect(insert('CONFIRMED', '2030-02-02T13:00:00Z', '2030-02-02T14:00:00Z')).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('enforces unique customer email when present', async () => {
    const email = `schema-uniq-${Date.now()}@example.com`;
    await pool.query(`insert into customer (name, email) values ('A', $1)`, [email]);
    await expect(
      pool.query(`insert into customer (name, email) values ('B', $1)`, [email]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
