import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgCustomerRepo } from '../../src/booking/booking.repo';

const url = process.env['DATABASE_URL'];
const maybe = url ? describe : describe.skip;

maybe('customer upsert', () => {
  let pool: Pool;
  let customers: PgCustomerRepo;

  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    customers = new PgCustomerRepo(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('returns one id when the same email is upserted concurrently', async () => {
    const email = `cust-race-${Date.now()}@example.com`;
    const [a, b] = await Promise.all([
      customers.upsert({ name: 'A', email }),
      customers.upsert({ name: 'B', email }),
    ]);
    expect(a.id).toBe(b.id);
    const count = await pool.query<{ n: number }>(
      'select count(*)::int as n from customer where email = $1',
      [email],
    );
    expect(count.rows[0]?.n).toBe(1);
  });
});
