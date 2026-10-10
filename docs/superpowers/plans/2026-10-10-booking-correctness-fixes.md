# Booking Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Critical and Important booking correctness gaps found in PR review so advisory search and authoritative reserve stay aligned, idempotency is safe across cancel/expiry, and lifecycle HTTP contracts match the design.

**Architecture:** Keep the existing check-twice design. Schema changes unlock correct idempotency (partial unique on active rows + request fingerprint). Reserve path eagerly frees expired holds and enforces the same buffer semantics as `findSlots`. Slot search enumerates stepped starts inside each free block. Lifecycle endpoints distinguish missing vs illegal transition and expose `COMPLETED` / `NO_SHOW`.

**Tech Stack:** Node 24 + TypeScript, Express 5, PostgreSQL 17, `pg` + Knex migrations, Zod, Vitest + Supertest (existing project).

**Spec:** PR review findings from `feat/unified-service-scheduler` vs `main`; design rules in `SYSTEM_DESIGN.md` (buffer between jobs, full lifecycle, idempotency); original constraints in `docs/superpowers/plans/2026-10-08-unified-service-scheduler.md`.

## Global Constraints

- Node **>=24** (`package.json` engines / `Dockerfile` `node:24-alpine`); PostgreSQL **17+**.
- All times stored/returned as **UTC ISO-8601**.
- Booking authority: **DB exclusion constraints** remain the hard no-overlap net for exact `[start, end)`; app clash checks may be stricter (buffer) but must never be looser than the DB.
- Buffer sits **between jobs**, not inside the returned slot length (slot length = `durationMin` only).
- Partitioned-table rule: any UNIQUE / PRIMARY KEY on `appointment` must include `dealership_id`.
- Hold TTL remains config-driven (default 10 minutes); reaper stays as a background safety net, not the only release path.
- Prefer TDD: failing test → minimal fix → pass → commit per task.
- Do not expand scope into auth, rate limits, gateway, or outbox transport.

## Issues Covered

| Severity | Issue | Task |
|---|---|---|
| Critical | Idempotency key survives cancel/expiry; returns cancelled row as success | 1, 2 |
| Important | Buffer advisory-only on reserve | 4 |
| Important | One start per free block under-represents slots | 5 |
| Important | Expired `HELD` still occupies capacity until reaper | 3 |
| Important | Idempotency has no request fingerprint | 1, 2 |
| Important | Missing id → 409; no COMPLETED/NO_SHOW APIs | 6 |
| Important | Customer upsert race (no unique email) | 1, 7 |
| Important | Missing tests for the failure modes above | folded into each task |

## File Structure

```
src/db/migrations/004_booking_correctness.ts   # NEW: partial active idempotency, fingerprint, customer.email unique
src/booking/idempotency.ts                     # NEW: fingerprint helper
src/booking/booking.types.ts                   # ReserveInput + ReserveResult + BookingService surface
src/booking/booking.repo.ts                    # createWithReserve, busyIntervals, customer upsert, confirm clear hold
src/booking/booking.service.ts                 # bufferMin pass-through, lifecycle 404, complete/noShow
src/booking/booking.router.ts                  # mismatch 422, complete/no-show routes, duplicate → 200
src/availability/availability.engine.ts        # stepped starts per free block
README.md                                      # document new endpoints + idempotency rules
test/integration/schema.test.ts                # assert partial unique + fingerprint column
test/integration/booking.test.ts               # cancel/reuse key, fingerprint, buffer, expired hold
test/unit/availability.engine.test.ts          # stepped starts + existing cases updated
test/unit/idempotency.test.ts                  # NEW: fingerprint stability
test/contract/appointments.test.ts             # 404 vs 409, mismatch, complete/no-show, duplicate 200
```

---

### Task 1: Schema migration for idempotency, fingerprint, and customer email

**Files:**
- Create: `src/db/migrations/004_booking_correctness.ts`
- Modify: `test/integration/schema.test.ts`
- Test: `test/integration/schema.test.ts` (requires `DATABASE_URL`)

**Interfaces:**
- Consumes: existing `appointment` / `customer` tables from `001`–`003`
- Produces: column `appointment.request_fingerprint text not null`; partial unique index `appointment_active_idempotency_uidx` on `(dealership_id, idempotency_key) WHERE status IN ('HELD','CONFIRMED')`; unique index `customer_email_uidx` on `customer(email)` where email is not null; **drops** the permanent `unique (dealership_id, idempotency_key)`

- [ ] **Step 1: Write the failing schema tests**

Append to `test/integration/schema.test.ts`:

```typescript
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
        SEED.dealership, SEED.customer, SEED.vehicle, SEED.serviceTypes.diagnostic,
        SEED.bays.diagnostic1, SEED.technicians.master, start, end, status, key,
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
```

Also update the existing overlap insert helper in the same file so every raw `INSERT` includes `request_fingerprint` (e.g. `'fp'`), or the column will reject NOT NULL inserts after migration.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- test/integration/schema.test.ts`
Expected: FAIL — index / column / unique email missing (or INSERT fails once you add fingerprint to helpers before migration exists — write migration next immediately).

- [ ] **Step 3: Write the migration**

Create `src/db/migrations/004_booking_correctness.ts`:

```typescript
import type { Knex } from 'knex';

/** up adds request fingerprints, active-only idempotency uniqueness, and unique customer emails. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table appointment
      add column if not exists request_fingerprint text not null default ''
  `);

  // Drop the permanent unique constraint (auto-named by Postgres from 003).
  await knex.raw(`
    alter table appointment
      drop constraint if exists appointment_dealership_id_idempotency_key_key
  `);

  await knex.raw(`
    create unique index if not exists appointment_active_idempotency_uidx
      on appointment (dealership_id, idempotency_key)
      where status in ('HELD', 'CONFIRMED')
  `);

  // Multiple NULLs remain allowed; only non-null emails must be unique.
  await knex.raw(`
    create unique index if not exists customer_email_uidx
      on customer (email)
      where email is not null
  `);
}

/** down restores the permanent idempotency unique constraint and drops the new indexes/column. */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists customer_email_uidx');
  await knex.raw('drop index if exists appointment_active_idempotency_uidx');
  await knex.raw(`
    alter table appointment
      add constraint appointment_dealership_id_idempotency_key_key
      unique (dealership_id, idempotency_key)
  `);
  await knex.raw('alter table appointment drop column if exists request_fingerprint');
}
```

If `drop constraint` fails because the auto-name differs, discover it with:

```sql
select conname from pg_constraint
 where conrelid = 'appointment'::regclass and contype = 'u';
```

and use that name in the migration.

- [ ] **Step 4: Apply migration and re-run schema tests**

Run:

```bash
npm run db:migrate
npm run test:integration -- test/integration/schema.test.ts
```

Expected: PASS (with `DATABASE_URL` set to the compose Postgres).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/004_booking_correctness.ts test/integration/schema.test.ts
git commit -m "$(cat <<'EOF'
feat: partial active idempotency index, fingerprint column, unique customer email

EOF
)"
```

---

### Task 2: Idempotency reuse after cancel + request fingerprint

**Files:**
- Create: `src/booking/idempotency.ts`
- Create: `test/unit/idempotency.test.ts`
- Modify: `src/booking/booking.types.ts`
- Modify: `src/booking/booking.repo.ts` (`createWithReserve`, `AppointmentRow`)
- Modify: `src/booking/booking.service.ts` (`createAppointment`)
- Modify: `src/booking/booking.router.ts` (status codes)
- Modify: `test/integration/booking.test.ts`
- Modify: `test/contract/appointments.test.ts`

**Interfaces:**
- Consumes: `appointment.request_fingerprint`, `appointment_active_idempotency_uidx` from Task 1
- Produces:
  - `fingerprintReserveRequest(input: Pick<ReserveInput, 'dealershipId' | 'serviceTypeId' | 'vehicleId' | 'bayId' | 'technicianId' | 'startAt' | 'endAt'>): string`
  - `ReserveInput.requestFingerprint: string`
  - `ReserveResult` includes `{ outcome: 'idempotency_mismatch' }`
  - `CreateAppointmentResult` includes `{ outcome: 'idempotency_mismatch' }`
  - HTTP: exact replay of an **active** key → **200**; mismatch → **422** `IDEMPOTENCY_MISMATCH`; cancel then same key → new **201**

- [ ] **Step 1: Write the failing unit test for the fingerprint helper**

Create `test/unit/idempotency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fingerprintReserveRequest } from '../../src/booking/idempotency';

describe('fingerprintReserveRequest', () => {
  const base = {
    dealershipId: 'd1',
    serviceTypeId: 's1',
    vehicleId: 'v1',
    bayId: 'b1',
    technicianId: 't1',
    startAt: '2030-01-07T08:00:00.000Z',
    endAt: '2030-01-07T09:00:00.000Z',
  };

  it('is stable for the same booking fields', () => {
    expect(fingerprintReserveRequest(base)).toBe(fingerprintReserveRequest({ ...base }));
  });

  it('changes when the slot identity changes', () => {
    expect(fingerprintReserveRequest(base)).not.toBe(
      fingerprintReserveRequest({ ...base, bayId: 'b2' }),
    );
  });
});
```

- [ ] **Step 2: Run unit test to verify it fails**

Run: `npm run test:unit -- test/unit/idempotency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fingerprint helper**

Create `src/booking/idempotency.ts`:

```typescript
import { createHash } from 'node:crypto';

export interface ReserveFingerprintInput {
  dealershipId: string;
  serviceTypeId: string;
  vehicleId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
}

/** fingerprintReserveRequest hashes the booking-identity fields for idempotency mismatch detection. */
export function fingerprintReserveRequest(input: ReserveFingerprintInput): string {
  const canonical = [
    input.dealershipId,
    input.serviceTypeId,
    input.vehicleId,
    input.bayId,
    input.technicianId,
    input.startAt,
    input.endAt,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
```

- [ ] **Step 4: Extend types**

In `src/booking/booking.types.ts`:

```typescript
export interface ReserveInput {
  dealershipId: string;
  serviceTypeId: string;
  vehicleId: string;
  customerId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
  idempotencyKey: string;
  requestFingerprint: string;
  holdMinutes: number;
  /** Service buffer minutes; Task 2 may pass 0, Task 4 wires the real catalog value into clash checks. */
  bufferMin: number;
}

export type ReserveResult =
  | { outcome: 'created'; appointment: Appointment }
  | { outcome: 'duplicate'; appointment: Appointment }
  | { outcome: 'idempotency_mismatch' }
  | { outcome: 'conflict' };

export type CreateAppointmentResult =
  | { outcome: 'created'; appointment: Appointment }
  | { outcome: 'duplicate'; appointment: Appointment }
  | { outcome: 'idempotency_mismatch' }
  | { outcome: 'conflict'; nextAvailable: Slot[] }
  | { outcome: 'invalid_slot'; reason: string };
```

In Task 2, pass `bufferMin: 0` from the service and test helpers so clash behavior stays unchanged until Task 4.

- [ ] **Step 5: Write failing integration tests for cancel-reuse and fingerprint mismatch**

Append to `test/integration/booking.test.ts` (update `reserve()` helper to pass `requestFingerprint: fingerprintReserveRequest({...})` and any new required fields):

```typescript
import { fingerprintReserveRequest } from '../../src/booking/idempotency';

// inside reserve():
requestFingerprint: fingerprintReserveRequest({
  dealershipId: SEED.dealership,
  serviceTypeId: SEED.serviceTypes.diagnostic,
  vehicleId: SEED.vehicle,
  bayId,
  technicianId: SEED.technicians.master,
  startAt: at(hour),
  endAt: at(hour + 1),
}),
bufferMin: 0, // Task 4 will exercise non-zero buffers

it('allows reusing an idempotency key after cancel', async () => {
  const key = `reserve-${Date.now()}-reuse-key`;
  const first = await repo.createWithReserve(reserve(key, 9));
  expect(first.outcome).toBe('created');
  if (first.outcome !== 'created') return;

  await repo.updateStatus(first.appointment.id, ['HELD'], 'CANCELLED', { cancelledReason: 'test' });

  const again = await repo.createWithReserve(reserve(key, 10));
  expect(again.outcome).toBe('created');
  if (again.outcome !== 'created') return;
  expect(again.appointment.id).not.toBe(first.appointment.id);
  expect(again.appointment.status).toBe('HELD');
});

it('rejects the same idempotency key when the slot fingerprint differs', async () => {
  const key = `reserve-${Date.now()}-fp-mismatch`;
  const first = await repo.createWithReserve(reserve(key, 12));
  expect(first.outcome).toBe('created');

  const mismatch = await repo.createWithReserve({
    ...reserve(key, 12),
    bayId: SEED.bays.diagnostic2,
    requestFingerprint: fingerprintReserveRequest({
      dealershipId: SEED.dealership,
      serviceTypeId: SEED.serviceTypes.diagnostic,
      vehicleId: SEED.vehicle,
      bayId: SEED.bays.diagnostic2,
      technicianId: SEED.technicians.master,
      startAt: at(12),
      endAt: at(13),
    }),
  });
  expect(mismatch.outcome).toBe('idempotency_mismatch');
});
```

- [ ] **Step 6: Run integration tests to verify they fail**

Run: `npm run test:integration -- test/integration/booking.test.ts`
Expected: FAIL — cancel-reuse returns `duplicate`; mismatch returns `duplicate`.

- [ ] **Step 7: Rewrite `createWithReserve` idempotency path**

In `src/booking/booking.repo.ts`:

1. Add `request_fingerprint` to `AppointmentRow` (string).
2. Replace both idempotency SELECTs with **active-only** lookup:

```sql
select * from appointment
 where dealership_id = $1
   and idempotency_key = $2
   and status in ('HELD', 'CONFIRMED')
 limit 1
```

3. When an active row exists:
   - if `row.request_fingerprint === input.requestFingerprint` → `{ outcome: 'duplicate', appointment }`
   - else → `{ outcome: 'idempotency_mismatch' }` (ROLLBACK)

4. Change INSERT to persist fingerprint and use the partial unique index:

```sql
insert into appointment
  (dealership_id, customer_id, vehicle_id, service_type_id, service_bay_id, technician_id,
   start_at, end_at, status, hold_expires_at, idempotency_key, request_fingerprint)
values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,'HELD',
        now() + make_interval(mins => $9::int), $10, $11)
on conflict (dealership_id, idempotency_key) where (status in ('HELD','CONFIRMED'))
do nothing
returning *
```

5. On `DO NOTHING` (rowCount 0), re-select the active row and apply the same fingerprint compare (duplicate vs mismatch).

- [ ] **Step 8: Wire service + router**

In `booking.service.ts` `createAppointment`, before `createWithReserve`:

```typescript
const requestFingerprint = fingerprintReserveRequest({
  dealershipId: input.dealershipId,
  serviceTypeId: serviceType.id,
  vehicleId: vehicle.id,
  bayId: bay.id,
  technicianId: technician.id,
  startAt: start.toISOString(),
  endAt: end.toISOString(),
});
```

Pass `requestFingerprint` into `createWithReserve`. Map:

```typescript
if (result.outcome === 'idempotency_mismatch') {
  return { outcome: 'idempotency_mismatch' };
}
```

In `booking.router.ts`:

```typescript
case 'created':
  res.status(201).json({ appointment: result.appointment });
  return;
case 'duplicate':
  res.status(200).json({ appointment: result.appointment });
  return;
case 'idempotency_mismatch':
  res.status(422).json({
    error: 'IDEMPOTENCY_MISMATCH',
    message: 'idempotency_key was reused with a different booking payload',
  });
  return;
```

Add `'IDEMPOTENCY_MISMATCH'` to `ErrorCode` in `src/common/errors.ts` only if you throw `AppError` for it; JSON body above is enough if handled in the switch.

Update contract test that expected duplicate → 201 to expect **200**, and add a contract case for mismatch.

- [ ] **Step 9: Run tests**

```bash
npm run test:unit -- test/unit/idempotency.test.ts
npm run test:integration -- test/integration/booking.test.ts
npm run test:contract -- test/contract/appointments.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/booking/idempotency.ts src/booking/booking.types.ts src/booking/booking.repo.ts \
  src/booking/booking.service.ts src/booking/booking.router.ts src/common/errors.ts \
  test/unit/idempotency.test.ts test/integration/booking.test.ts test/contract/appointments.test.ts
git commit -m "$(cat <<'EOF'
fix: reuse idempotency keys after cancel and reject fingerprint mismatches

EOF
)"
```

---

### Task 3: Expired holds must not occupy capacity

**Files:**
- Modify: `src/booking/booking.repo.ts` (`busyIntervals`, `createWithReserve`)
- Modify: `test/integration/booking.test.ts`

**Interfaces:**
- Consumes: `releaseExpiredHolds` already on the repo
- Produces: `busyIntervals` excludes `HELD` rows with `hold_expires_at < now()`; `createWithReserve` cancels overlapping expired holds **inside the same transaction after resource locks** before clash/insert (exclusion constraints still see `HELD` until status changes)

Why release inside the TX: PostgreSQL exclusion constraints cannot express “expired hold is free”. Ignoring expiry only in SELECT would still fail the INSERT with `23P01`.

- [ ] **Step 1: Write the failing integration tests**

```typescript
it('busyIntervals ignores expired HELD appointments', async () => {
  const key = `reserve-${Date.now()}-busy-exp`;
  const created = await repo.createWithReserve(reserve(key, 14));
  expect(created.outcome).toBe('created');
  if (created.outcome !== 'created') return;

  await pool.query(
    "update appointment set hold_expires_at = now() - interval '1 minute' where id = $1",
    [created.appointment.id],
  );

  const busy = await repo.busyIntervals(SEED.dealership, at(13), at(16));
  expect(busy.find((b) => b.startAt === at(14))).toBeUndefined();
});

it('createWithReserve succeeds over an expired hold without waiting for the reaper', async () => {
  const stamp = Date.now();
  const first = await repo.createWithReserve(reserve(`reserve-${stamp}-exp1`, 16));
  expect(first.outcome).toBe('created');
  if (first.outcome !== 'created') return;

  await pool.query(
    "update appointment set hold_expires_at = now() - interval '1 minute' where id = $1",
    [first.appointment.id],
  );

  const second = await repo.createWithReserve(reserve(`reserve-${stamp}-exp2`, 16));
  expect(second.outcome).toBe('created');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm run test:integration -- test/integration/booking.test.ts`
Expected: FAIL — expired hold still listed as busy / second reserve conflicts.

- [ ] **Step 3: Implement**

Update `busyIntervals` WHERE clause:

```sql
where dealership_id = $1
  and (
    status = 'CONFIRMED'
    or (status = 'HELD' and (hold_expires_at is null or hold_expires_at >= now()))
  )
  and tstzrange(start_at, end_at) && tstzrange($2::timestamptz, $3::timestamptz)
```

In `createWithReserve`, after acquiring bay/tech `FOR UPDATE` locks and before clash check:

```sql
update appointment
   set status = 'CANCELLED',
       cancelled_reason = 'hold_expired',
       updated_at = now()
 where dealership_id = $1
   and status = 'HELD'
   and hold_expires_at < now()
   and (service_bay_id = $2 or technician_id = $3)
   and tstzrange(start_at, end_at) && tstzrange($4::timestamptz, $5::timestamptz)
 returning id
```

For each returned id, append `AppointmentCancelled` to the outbox (same pattern as `releaseExpiredHolds`). Keep the periodic reaper unchanged as a global sweeper for non-overlapping expiries.

Also tighten the clash SELECT to ignore expired holds (same predicate as `busyIntervals`) so the app check matches search even if the UPDATE touched zero rows.

- [ ] **Step 4: Run tests**

Run: `npm run test:integration -- test/integration/booking.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/booking/booking.repo.ts test/integration/booking.test.ts
git commit -m "$(cat <<'EOF'
fix: free expired holds on read and during reserve

EOF
)"
```

---

### Task 4: Enforce service buffer on the authoritative reserve path

**Files:**
- Modify: `src/booking/booking.types.ts` (`ReserveInput.bufferMin`)
- Modify: `src/booking/booking.repo.ts` (clash SQL)
- Modify: `src/booking/booking.service.ts` (pass `serviceType.bufferMin`)
- Modify: `test/integration/booking.test.ts`

**Interfaces:**
- Consumes: catalog `bufferMin` already loaded in `createAppointment`
- Produces: clash when an active busy interval **extended by `bufferMin` at the end** overlaps the requested `[start, end)` — matching `extendBuffer` in `availability.engine.ts`

Semantics (must match search):

```
busy_for_clash = [existing.start, existing.end + bufferMin)
requested      = [start, end)
conflict if ranges overlap
```

Exclusion constraints stay exact-interval (hard floor). Buffer remains an app-level workshop rule enforced inside the TX.

- [ ] **Step 1: Write the failing integration test**

Use a service duration of 60 minutes in the helper (diagnostic seed is 120 — pick times carefully). Easiest path: book two 60-minute windows using the diagnostic seed duration (`end = start + 120`) **or** insert via repo with the seed service type id and 120-minute windows.

Diagnostic is 120 min with buffer 30 in seed. Example:

```typescript
it('rejects a booking that violates the service buffer after an existing appointment', async () => {
  const stamp = Date.now();
  // first job 09:00-11:00 (120 min)
  const first = await repo.createWithReserve({
    ...reserve(`reserve-${stamp}-buf1`, 9),
    startAt: at(9),
    endAt: at(11),
    requestFingerprint: fingerprintReserveRequest({
      dealershipId: SEED.dealership,
      serviceTypeId: SEED.serviceTypes.diagnostic,
      vehicleId: SEED.vehicle,
      bayId: SEED.bays.diagnostic1,
      technicianId: SEED.technicians.master,
      startAt: at(9),
      endAt: at(11),
    }),
    bufferMin: 30,
  });
  expect(first.outcome).toBe('created');

  // second job wants 11:00-13:00 — exact adjacency, inside the 30 min buffer after first
  const second = await repo.createWithReserve({
    ...reserve(`reserve-${stamp}-buf2`, 11),
    startAt: at(11),
    endAt: at(13),
    bayId: SEED.bays.diagnostic1,
    requestFingerprint: fingerprintReserveRequest({
      dealershipId: SEED.dealership,
      serviceTypeId: SEED.serviceTypes.diagnostic,
      vehicleId: SEED.vehicle,
      bayId: SEED.bays.diagnostic1,
      technicianId: SEED.technicians.master,
      startAt: at(11),
      endAt: at(13),
    }),
    bufferMin: 30,
  });
  expect(second.outcome).toBe('conflict');
});

it('allows a booking that starts after the prior job plus buffer', async () => {
  const stamp = Date.now();
  const first = await repo.createWithReserve({
    ...reserve(`reserve-${stamp}-bufok1`, 9),
    startAt: at(9),
    endAt: at(11),
    requestFingerprint: fingerprintReserveRequest({
      dealershipId: SEED.dealership,
      serviceTypeId: SEED.serviceTypes.diagnostic,
      vehicleId: SEED.vehicle,
      bayId: SEED.bays.diagnostic2,
      technicianId: SEED.technicians.master,
      startAt: at(9),
      endAt: at(11),
    }),
    bufferMin: 30,
  });
  expect(first.outcome).toBe('created');

  // 11:30-13:30 clears the 30 min buffer after 11:00
  const second = await repo.createWithReserve({
    ...reserve(`reserve-${stamp}-bufok2`, 11),
    startAt: at(11, 30),
    endAt: at(13, 30),
    bayId: SEED.bays.diagnostic2,
    requestFingerprint: fingerprintReserveRequest({
      dealershipId: SEED.dealership,
      serviceTypeId: SEED.serviceTypes.diagnostic,
      vehicleId: SEED.vehicle,
      bayId: SEED.bays.diagnostic2,
      technicianId: SEED.technicians.master,
      startAt: at(11, 30),
      endAt: at(13, 30),
    }),
    bufferMin: 30,
  });
  expect(second.outcome).toBe('created');
});
```

Use distinct bays/hours so these tests do not collide with other cases in the file. Prefer unique hour bands (e.g. 2031-01-07 already used — pick unused hours or a new day constant).

- [ ] **Step 2: Run to verify fail**

Run: `npm run test:integration -- test/integration/booking.test.ts`
Expected: FAIL — adjacent booking currently succeeds (`created`).

- [ ] **Step 3: Implement clash with buffer**

Ensure `ReserveInput` has `bufferMin: number`.

Clash query (active, non-expired, buffer-extended busy):

```sql
select 1 from appointment
 where dealership_id = $1
   and (
     status = 'CONFIRMED'
     or (status = 'HELD' and (hold_expires_at is null or hold_expires_at >= now()))
   )
   and (service_bay_id = $2 or technician_id = $3)
   and tstzrange(start_at, end_at + make_interval(mins => $6::int))
       && tstzrange($4::timestamptz, $5::timestamptz)
 limit 1
```

Bind `$6 = input.bufferMin`.

In `booking.service.ts`, pass `bufferMin: serviceType.bufferMin`.

Do **not** change exclusion constraints to include buffer (would break exact adjacency semantics for zero-buffer services and complicate multi-service buffers).

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run test:integration -- test/integration/booking.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/booking/booking.types.ts src/booking/booking.repo.ts \
  src/booking/booking.service.ts test/integration/booking.test.ts
git commit -m "$(cat <<'EOF'
fix: enforce service buffer on transactional reserve

EOF
)"
```

---

### Task 5: Enumerate stepped starts inside each free block

**Files:**
- Modify: `src/availability/availability.engine.ts`
- Modify: `test/unit/availability.engine.test.ts`

**Interfaces:**
- Consumes: existing `findSlots(input, ctx)`
- Produces: for each free block, emit candidates at `earliest`, then every `SLOT_STEP_MIN` (15) until `latestStart`, still duration-long, then sort by score and `slice(0, limit)`

- [ ] **Step 1: Write / update failing unit tests**

Replace brittle `toHaveLength(1)` expectations that assumed one start per block. Add:

```typescript
it('emits multiple stepped starts inside a long free block and ranks nearest first', () => {
  const slots = findSlots(
    { dealershipId: 'd1', serviceType: oilChange, desiredAt: at('12:00'), horizonDays: 0, limit: 5, now: at('07:00') },
    ctx(),
  );

  expect(slots.length).toBe(5);
  expect(slots[0]?.startAt).toBe(at('12:00'));
  // stepped candidates near the desired time fill the remainder of the limit
  const starts = slots.map((s) => s.startAt);
  expect(starts).toContain(at('11:45'));
  expect(starts).toContain(at('12:15'));
});
```

Update existing tests:

- `'does not offer a 240-minute job…'` — oil change in 08:00–10:00 gap may return multiple starts; assert `every` slot fits and includes `08:00`, not `toHaveLength(1)`.
- `'keeps the slot at the service duration…'` — assert first slot length 60, not unique count.
- `'keeps slots inside dealership hours…'` — keep nearest-first (`10:30` then earlier morning option); do not require exact array equality of only two elements unless `limit` is raised carefully.
- `'offers a same-day slot…'` — assert a slot at `15:00` exists and all starts `>= now`, not `toHaveLength(1)`.

- [ ] **Step 2: Run to verify fail**

Run: `npm run test:unit -- test/unit/availability.engine.test.ts`
Expected: FAIL — only one start per block today.

- [ ] **Step 3: Implement stepping**

In `availability.engine.ts`:

```typescript
const SLOT_STEP_MIN = 15;
```

Replace the single-candidate push inside `for (const free of intersect(...))` with:

```typescript
const earliest = Math.max(free.start.getTime(), nowMs);
const latestStart = free.end.getTime() - duration * 60_000;
if (latestStart < earliest) continue;

const stepMs = SLOT_STEP_MIN * 60_000;
// Align the first step to a wall-clock step grid in UTC minutes, but always include desired when it fits.
const startTimes = new Set<number>();
if (desired.getTime() >= earliest && desired.getTime() <= latestStart) {
  startTimes.add(desired.getTime());
}
const aligned = Math.ceil(earliest / stepMs) * stepMs;
for (let t = aligned; t <= latestStart; t += stepMs) {
  startTimes.add(t);
}
// Guarantee the earliest usable instant is considered even if unaligned.
startTimes.add(earliest);

for (const startMs of startTimes) {
  if (startMs < earliest || startMs > latestStart) continue;
  const isPreferred = preferred.has(bay.bayTypeCode);
  const score =
    Math.abs(startMs - desired.getTime()) / 60_000 +
    (isPreferred ? 0 : PREFERRED_BAY_PENALTY);
  slots.push({
    dealershipId,
    bayId: bay.id,
    technicianId: tech.id,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + duration * 60_000).toISOString(),
    preferredBay: isPreferred,
    score,
  });
}
```

Update the file-level JSDoc: emit stepped candidates per free block, not one.

- [ ] **Step 4: Run unit tests**

Run: `npm run test:unit -- test/unit/availability.engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/availability/availability.engine.ts test/unit/availability.engine.test.ts
git commit -m "$(cat <<'EOF'
feat: enumerate stepped slot starts within each free block

EOF
)"
```

---

### Task 6: Lifecycle HTTP contracts — 404, complete, no-show

**Files:**
- Modify: `src/booking/booking.types.ts` (`BookingService.complete`, `BookingService.noShow`)
- Modify: `src/booking/booking.service.ts`
- Modify: `src/booking/booking.repo.ts` (`updateStatus` clears `hold_expires_at` on confirm)
- Modify: `src/booking/booking.router.ts`
- Modify: `test/contract/appointments.test.ts`
- Modify: `README.md` (API table)

**Interfaces:**
- Consumes: existing `updateStatus`, `getById`, `ALLOWED_TRANSITIONS`
- Produces:
  - `confirm` / `cancel` / `complete` / `noShow`: missing id → `AppError(404, 'NOT_FOUND', …)`; wrong state → `AppError(409, 'INVALID_TRANSITION', …)`
  - Routes: `POST /appointments/:id/complete`, `POST /appointments/:id/no-show`
  - Confirm sets `hold_expires_at = null`

- [ ] **Step 1: Write failing contract tests**

```typescript
it('POST /appointments/:id/confirm returns 404 when the appointment is missing', async () => {
  const repo = repoStub({
    getById: async () => null,
    updateStatus: async () => null,
  });
  const res = await request(makeApp(repo)).post('/appointments/missing/confirm').send();
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('NOT_FOUND');
});

it('POST /appointments/:id/confirm returns 409 when present but not HELD', async () => {
  const confirmed: Appointment = { ...created, status: 'CONFIRMED' };
  const repo = repoStub({
    getById: async () => confirmed,
    updateStatus: async () => null,
  });
  const res = await request(makeApp(repo)).post('/appointments/a1/confirm').send();
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('INVALID_TRANSITION');
});

it('POST /appointments/:id/complete moves CONFIRMED -> COMPLETED', async () => {
  const confirmed: Appointment = { ...created, status: 'CONFIRMED' };
  const completed: Appointment = { ...created, status: 'COMPLETED' };
  const repo = repoStub({
    getById: async () => confirmed,
    updateStatus: async (_id, from, to) => (to === 'COMPLETED' && from.includes('CONFIRMED') ? completed : null),
  });
  const res = await request(makeApp(repo)).post('/appointments/a1/complete').send();
  expect(res.status).toBe(200);
  expect(res.body.appointment.status).toBe('COMPLETED');
});

it('POST /appointments/:id/no-show moves CONFIRMED -> NO_SHOW', async () => {
  const confirmed: Appointment = { ...created, status: 'CONFIRMED' };
  const noShow: Appointment = { ...created, status: 'NO_SHOW' };
  const repo = repoStub({
    getById: async () => confirmed,
    updateStatus: async (_id, from, to) => (to === 'NO_SHOW' ? noShow : null),
  });
  const res = await request(makeApp(repo)).post('/appointments/a1/no-show').send();
  expect(res.status).toBe(200);
  expect(res.body.appointment.status).toBe('NO_SHOW');
});
```

Update the existing “confirm returns 409 when update refused” test so the stub’s `getById` returns the held appointment (otherwise it must become 404 after the service change).

- [ ] **Step 2: Run to verify fail**

Run: `npm run test:contract -- test/contract/appointments.test.ts`
Expected: FAIL — missing → 409 today; complete/no-show routes 404 from Express.

- [ ] **Step 3: Implement service + router + confirm hold clear**

Shared helper pattern in `BookingServiceImpl`:

```typescript
private async transition(
  id: string,
  from: AppointmentStatus[],
  to: AppointmentStatus,
  extra?: { cancelledReason?: string },
  invalidMessage = 'invalid appointment transition',
): Promise<Appointment> {
  const existing = await this.deps.appointments.getById(id);
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'appointment not found');
  const updated = await this.deps.appointments.updateStatus(id, from, to, extra);
  if (!updated) throw new AppError(409, 'INVALID_TRANSITION', invalidMessage);
  return updated;
}

async confirm(appointmentId: string): Promise<Appointment> {
  return this.transition(appointmentId, ['HELD'], 'CONFIRMED', undefined, 'appointment is not in HELD state');
}

async cancel(appointmentId: string): Promise<Appointment> {
  return this.transition(
    appointmentId,
    ['HELD', 'CONFIRMED'],
    'CANCELLED',
    { cancelledReason: 'cancelled_by_customer' },
    'appointment cannot be cancelled',
  );
}

async complete(appointmentId: string): Promise<Appointment> {
  return this.transition(appointmentId, ['CONFIRMED'], 'COMPLETED', undefined, 'appointment is not in CONFIRMED state');
}

async noShow(appointmentId: string): Promise<Appointment> {
  return this.transition(appointmentId, ['CONFIRMED'], 'NO_SHOW', undefined, 'appointment is not in CONFIRMED state');
}
```

Add `complete` / `noShow` to the `BookingService` interface.

In `updateStatus` SQL, when `to === 'CONFIRMED'`, also set `hold_expires_at = null`:

```sql
update appointment
   set status = $3,
       cancelled_reason = coalesce($4, cancelled_reason),
       hold_expires_at = case when $3 = 'CONFIRMED' then null else hold_expires_at end,
       updated_at = now()
 where id = $1 and status = any($2::text[])
 returning *
```

Router:

```typescript
router.post('/appointments/:id/complete', asyncHandler(async (req, res) => {
  res.json({ appointment: await service.complete(pathParam(req, 'id')) });
}));
router.post('/appointments/:id/no-show', asyncHandler(async (req, res) => {
  res.json({ appointment: await service.noShow(pathParam(req, 'id')) });
}));
```

README API table: add the two rows; note confirm/cancel return 404 when missing.

- [ ] **Step 4: Run contract tests**

Run: `npm run test:contract -- test/contract/appointments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/booking/booking.types.ts src/booking/booking.service.ts \
  src/booking/booking.repo.ts src/booking/booking.router.ts \
  test/contract/appointments.test.ts README.md
git commit -m "$(cat <<'EOF'
feat: lifecycle 404s plus complete and no-show endpoints

EOF
)"
```

---

### Task 7: Race-safe customer upsert

**Files:**
- Modify: `src/booking/booking.repo.ts` (`PgCustomerRepo.upsert`)
- Create: `test/integration/customer.test.ts` (or append a small case to `booking.test.ts`)

**Interfaces:**
- Consumes: `customer_email_uidx` from Task 1
- Produces: `upsert` uses `INSERT … ON CONFLICT (email) WHERE email IS NOT NULL` — for partial unique indexes Postgres needs matching inference:

```sql
insert into customer (name, phone, email)
values ($1, $2, $3)
on conflict (email) where (email is not null)
do update set
  name = excluded.name,
  phone = coalesce(excluded.phone, customer.phone)
returning id
```

When `email` is absent/null, keep plain insert (multiple null emails allowed).

- [ ] **Step 1: Write the failing / characterizing integration test**

```typescript
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
```

- [ ] **Step 2: Run to verify current race (may flake pass)**

Run: `npm run test:integration -- test/integration/customer.test.ts`
Expected: often FAIL with unique violation or `n > 1` before the upsert rewrite; after Task 1 unique index exists, concurrent select-then-insert will throw `23505` — that failure is enough to drive the fix.

- [ ] **Step 3: Implement upsert**

Replace `PgCustomerRepo.upsert` with:

```typescript
async upsert(input: CustomerInput): Promise<{ id: string }> {
  if (!input.email) {
    const inserted = await this.db.query<{ id: string }>(
      'insert into customer (name, phone, email) values ($1, $2, null) returning id',
      [input.name, input.phone ?? null],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('customer insert returned no row');
    return { id: row.id };
  }

  const upserted = await this.db.query<{ id: string }>(
    `insert into customer (name, phone, email)
     values ($1, $2, $3)
     on conflict (email) where (email is not null)
     do update set
       name = excluded.name,
       phone = coalesce(excluded.phone, customer.phone)
     returning id`,
    [input.name, input.phone ?? null, input.email],
  );
  const row = upserted.rows[0];
  if (!row) throw new Error('customer upsert returned no row');
  return { id: row.id };
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test:integration -- test/integration/customer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/booking/booking.repo.ts test/integration/customer.test.ts
git commit -m "$(cat <<'EOF'
fix: upsert customers on email with a unique index

EOF
)"
```

---

### Task 8: Final verification + README idempotency note

**Files:**
- Modify: `README.md` (idempotency + buffer + lifecycle notes)

**Interfaces:**
- Consumes: all prior tasks
- Produces: docs that match runtime behavior

- [ ] **Step 1: Document behavior in README**

Under the booking section, add short bullets:

- Idempotency keys are unique among **active** (`HELD`/`CONFIRMED`) appointments per dealership; after cancel/expiry the key may be reused.
- Reusing a key with a different bay/tech/time returns `422 IDEMPOTENCY_MISMATCH`.
- Exact replay of an active key returns `200` with the existing appointment.
- Reserve enforces the service buffer the same way slot search does.
- Expired holds are released during reserve (reaper is a backup).
- Lifecycle: `confirm`, `cancel`, `complete`, `no-show`; missing ids are `404`.

- [ ] **Step 2: Run the full suite**

```bash
npm run typecheck
npm run test:unit
npm run test:contract
npm run test:integration
```

Expected: all PASS (integration requires `DATABASE_URL` / compose DB).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: document corrected idempotency, buffer, and lifecycle behavior

EOF
)"
```

---

## Self-Review

**1. Spec coverage**
- Critical idempotency after cancel/expiry → Tasks 1–2
- Fingerprint mismatch → Tasks 1–2
- Buffer on reserve → Task 4
- Stepped slot starts → Task 5
- Expired hold occupancy → Task 3
- Lifecycle 404 + COMPLETED/NO_SHOW → Task 6
- Customer upsert race → Tasks 1 + 7
- Test gaps → each task owns its tests; Task 8 runs the full suite

**2. Placeholder scan**
- No TBD/TODO steps; SQL, TypeScript, and commands are concrete.
- `bufferMin` is on `ReserveInput` from Task 2 (`0` until Task 4 wires catalog buffers into clash SQL).

**3. Type consistency**
- `ReserveResult` / `CreateAppointmentResult` both gain `idempotency_mismatch`.
- `BookingService` gains `complete` / `noShow`.
- `fingerprintReserveRequest` field set matches what `createAppointment` hashes.
- Partial unique `ON CONFLICT … WHERE (status in ('HELD','CONFIRMED'))` matches the index predicate from Task 1.

**Out of scope (Minor from review — do not implement unless asked):** horizon `<=` off-by-one, auth/rate limits, uncommitted `SYSTEM_DESIGN.md` packaging.
