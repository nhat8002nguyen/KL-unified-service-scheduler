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
        service_bay_id, technician_id, start_at, end_at, status, idempotency_key)
      values ('${SEED.dealership}', '${SEED.customer}', '${SEED.vehicle}', '${SEED.serviceTypes.diagnostic}',
        '${SEED.bays.diagnostic1}', '${SEED.technicians.master}',
        '2030-01-07T09:00:00Z'::timestamptz + interval '${offsetMin} minutes',
        '2030-01-07T10:00:00Z'::timestamptz + interval '${offsetMin} minutes',
        'CONFIRMED', '${idempotencyKey}')`;

    await pool.query(insert(`schema-test-${Date.now()}-a`, 0));
    await expect(pool.query(insert(`schema-test-${Date.now()}-b`, 30))).rejects.toMatchObject({
      code: '23P01',
    });
  });
});
