# Unified Service Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Scenario A "Unified Service Scheduler" MVP — a working monolith (ExpressJS + TypeScript + PostgreSQL) that searches continuous slots where a compatible bay **and** a qualified technician are both free for the full job duration, then books an appointment with a DB-level no-double-booking guarantee.

**Architecture:** One Express app composed of independent modules behind narrow interfaces (each module = a future microservice boundary). Availability is checked twice: `GET /slots` is advisory (a pure TypeScript interval-intersection engine over busy intervals read from the DB), and `POST /appointments` is authoritative (a single transaction that re-checks, inserts a `HELD` appointment, and lets PostgreSQL exclusion constraints reject any overlap). Events go through a same-transaction outbox table whose transport is stubbed for MVP.

**Tech Stack:** Node 20+ / TypeScript 5, Express 4, PostgreSQL 17+, `pg` + Knex (migrations), Zod (validation), Vitest + Supertest, pino (logs), OpenTelemetry SDK (traces), prom-client (metrics), Docker Compose.

**Spec:** `system-design-document.md` (primary), `Scenario_A_Domain_Brief.pdf` (domain rules + acceptance criteria), `booking-flow-design-review.md` (the "check twice" + exclusion-constraint decisions this plan encodes).

## Global Constraints

- All times stored/returned in **UTC ISO-8601**; dealership timezone stored separately and used only to compute local open hours. Never store or compare wall-clock local times.
- Booking authority: **only the DB decides "no double booking"**. App-level checks are advisory; the `EXCLUDE` constraints are the safety net.
- Service duration **and buffer** must both fit in a candidate slot; a 4 h job must never be offered in a 2 h gap.
- A technician and a bay are each **single-capacity** interval resources (one job at a time each); both get an exclusion constraint.
- Every diary query is scoped by `dealership_id`; a bay or technician from a different dealership must never be offered.
- **Partitioning & the exclusion constraint (requires PostgreSQL 17+):** the `appointment` table is **hash-partitioned by `dealership_id`** and both `EXCLUDE` constraints are declared once on the partitioned parent. This is legal only from PostgreSQL 17 — 15/16 allow an exclusion constraint *only on each leaf partition*. It works because the constraint includes **all** partition-key columns compared with `=` (here `dealership_id WITH =`), which is exactly the condition PG 17 imposes. Enforcement is still global for this constraint: two rows can conflict only if they share a `dealership_id`, and the partition key forces all such rows into the same hash partition, so per-partition enforcement equals global enforcement. Postgres is the only mainstream RDBMS with a declarative `EXCLUDE` constraint (SQL Server, Oracle, MySQL/MariaDB, SQLite, CockroachDB, TiDB, YugabyteDB have none); the distributed escape hatch at larger scale is **Citus** (distribute by `dealership_id`; the constraint includes the distribution column).
- **Monolith-now / microservices-later:** modules communicate through in-process interfaces only; no module imports another module's repository or router directly. Extracting a module = give its interface an HTTP client and deploy it separately.
- Hold TTL: **10 minutes** (`hold_expires_at = now + 10 min`), configurable via env.
- Version floors / commands: Node 20+ and **PostgreSQL 17+** (the partitioned exclusion constraint requires 17; the compose file pins `postgres:17`). `npm` for scripts, `npx vitest` for tests, `npx knex` for migrations, `docker compose up` to run. The executor must have Node and Docker installed.
- **Partitioned-table constraint rule:** on a partitioned table a PRIMARY KEY or UNIQUE constraint must include every partition-key column. So the PK is `(dealership_id, id)` and idempotency is `unique (dealership_id, idempotency_key)` — `id` alone and `idempotency_key` alone cannot be globally unique. Lookups by `id` alone still work but scan all partitions (bounded: 4 in the MVP).

## Review Focus

The input classes / failure modes the spec implies but no happy-path test exercises, each with the test that pins it (added to the owning task):

1. **Duration-aware slotting** — a 4 h (240 min) job against a 2 h free gap must yield no slot for that gap. → Task 4, `test/unit/availability.algorithm.test.ts`.
2. **Buffer sits between jobs, not inside the slot** — a 30 min buffer must reduce the usable gap, and the returned slot must equal `duration`, not `duration + buffer`. → Task 4.
3. **Technician is single-capacity too** — a tech with a busy interval for a different bay is not free for that window; the algorithm must exclude it and the DB must reject the overlap. → Task 4 (algorithm) + Task 6 (constraint).
4. **Idempotent retry** — two `POST`s with the same `idempotency_key` return the same appointment id, never two rows. → Task 6.
5. **Concurrent race** — two concurrent `POST`s for the same bay+tech+time produce exactly one `201` and one `409 {reason:"slot_taken"}`, never a double book. → Task 9 (integration).
6. **Desired time in the past / outside dealership hours** — `GET /slots` must not crash or return a slot in the past; it returns an empty list or recommendations anchored to the next open window. → Task 5.
7. **Cross-dealership leakage** — a bay/technician whose `dealership_id` differs from the request's is never returned. → Task 5.

---

## File Structure

```
keyloop/
├── docker-compose.yml            # postgres + app (+ optional prometheus/collector, commented)
├── Dockerfile                    # multi-stage: tsc build → node dist
├── .dockerignore
├── .env.example                  # PORT, DATABASE_URL, LOG_LEVEL, OTLP endpoint, HOLD_MINUTES
├── package.json
├── tsconfig.json
├── knexfile.ts                   # migrations dir + pg connection from env
├── vitest.config.ts
├── README.md                     # run instructions + demo curl script
├── docs/superpowers/plans/2026-10-08-unified-service-scheduler.md
├── src/
│   ├── server.ts                 # composition root: wire real repos/services, start HTTP + reaper
│   ├── app.ts                    # buildApp(services): Express app (no listen) — injectable for tests
│   ├── config.ts                 # env parsing (zod), typed Config
│   ├── domain/types.ts           # Id, AppointmentStatus, shared row types
│   ├── common/
│   │   ├── errors.ts             # AppError, ErrorCode union, error→HTTP mapping middleware
│   │   ├── http.ts               # asyncHandler, json helpers, zod validate middleware
│   │   └── time.ts               # parse/format ISO, minute-of-day helpers (pure)
│   ├── db/
│   │   ├── pool.ts               # pg Pool factory + DbTx type (pg client/transaction)
│   │   └── migrations/           # 001_catalog, 002_resources, 003_appointments
│   │   └── seeds/                # reference data + demo dealership/resources/vehicle
│   ├── telemetry/
│   │   ├── logger.ts             # pino root + child-with-ctx helper
│   │   ├── tracer.ts             # OTel NodeSDK init + express tracing middleware
│   │   └── metrics.ts            # prom-client registry, counters/histograms, /metrics handler
│   ├── catalog/
│   │   ├── catalog.types.ts      # ServiceTypeDetail, CatalogReader, CatalogRepository
│   │   ├── catalog.repo.ts       # pg implementation
│   │   └── catalog.router.ts     # GET /service-types (admin/read)
│   ├── resources/
│   │   ├── resources.types.ts    # Vehicle/Dealership/ServiceBay/Technician readers
│   │   ├── resources.repo.ts     # pg implementation (listQualified joins technician_skill)
│   │   └── resources.router.ts   # GET /dealerships/:id (hours), GET /vehicles/:vin
│   ├── availability/
│   │   ├── availability.types.ts # Slot, SlotSearchInput, BusyInterval, AvailabilityEngine
│   │   ├── interval.ts           # pure interval math (union/subtract/overlap) — unit-tested
│   │   └── availability.engine.ts# AvailabilityEngineImpl(reads busy intervals, pure math)
│   ├── booking/
│   │   ├── booking.types.ts      # Appointment, CreateAppointmentInput/Result, BookingService, AppointmentRepository, ReserveResult
│   │   ├── booking.repo.ts       # pg impl: createWithReserve (tx + EXCLUDE catch), updateStatus, busyIntervals, releaseExpiredHolds
│   │   ├── booking.service.ts    # orchestrates: searchSlots, createAppointment, confirm/cancel, releaseExpiredHolds
│   │   ├── state-machine.ts      # pure: legal transitions + canTransition — unit-tested
│   │   └── booking.router.ts     # GET /slots, POST /appointments, POST /appointments/:id/{confirm,cancel}, GET /appointments/:id
│   ├── diary/
│   │   ├── diary.types.ts        # TechnicianCalendarEntry, CapacitySummary, DiaryService
│   │   ├── diary.service.ts      # read-only views over appointments
│   │   └── diary.router.ts       # GET /technicians/:id/appointments, GET /dealerships/:id/capacity
│   ├── outbox/
│   │   ├── outbox.types.ts       # DomainEvent, OutboxWriter
│   │   └── outbox.repo.ts        # pg impl: append(trx, event); transport stub
│   └── jobs/
│       └── reaper.ts             # in-process interval calling releaseExpiredHolds (runnable standalone)
└── test/
    ├── unit/availability.interval.test.ts
    ├── unit/availability.engine.test.ts
    ├── unit/state-machine.test.ts
    ├── contract/slots.test.ts          # supertest against buildApp with fake readers + fake repo
    ├── contract/appointments.test.ts   # create/confirm/cancel/validate/idempotency (fake repo for unit; real for integration)
    └── integration/concurrency.test.ts # real Postgres: two parallel POSTs → 201 + 409
```

---

### Task 1: Project skeleton, Docker Compose, and telemetry foundation

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `knexfile.ts`, `Dockerfile`, `.dockerignore`, `.env.example`, `docker-compose.yml`
- Create: `src/config.ts`, `src/domain/types.ts`, `src/common/errors.ts`, `src/common/http.ts`, `src/common/time.ts`
- Create: `src/telemetry/logger.ts`, `src/telemetry/tracer.ts`, `src/telemetry/metrics.ts`
- Create: `src/app.ts`, `src/server.ts`, `src/db/pool.ts`

**Interfaces:**
- Produces: `Config` (`port`, `databaseUrl`, `logLevel`, `otlpEndpoint?`, `holdMinutes`); `Id`, `AppointmentStatus`; `AppError(status, code, message)`, `ErrorCode`; `asyncHandler`, `validate(schema)`; `logger`, `traceMiddleware`, `metricsRegistry`, `httpRequestDuration`, `buildApp(deps)`, `start(config)`.
- `buildApp(deps: AppDeps): Express` where `AppDeps` is filled in by later tasks (`{ catalog, resources, availability, booking, diary }` services).

- [ ] **Step 1: Write the failing health-check test**

`test/contract/health.test.ts` (or assert inside `app.test.ts`):

```ts
test('GET /healthz returns ok', async () => {
  const res = await request(buildApp({})).get('/healthz');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/contract/health.test.ts`
Expected: FAIL — `buildApp` does not exist.

- [ ] **Step 3: Implement the skeleton**

`src/config.ts`: `loadConfig(env = process.env): Config` using Zod — `PORT` (default 8080), `DATABASE_URL` (required), `LOG_LEVEL` (default `info`), `OTEL_EXPORTER_OTLP_ENDPOINT` (optional; when absent, tracing is no-op console), `HOLD_MINUTES` (default 10).

`src/app.ts`: `buildApp(deps: Partial<AppDeps> = {})` returns an Express app with JSON body parsing, request-id/trace middleware, a `GET /healthz`, a `GET /readyz` (checks `deps.dbHealthy?.()` or returns ok), `GET /metrics`, and the JSON error middleware from `common/errors.ts`.

`src/telemetry/logger.ts`: pino with level from config; `childLogger(ctx: { trace_id?: string; dealership_id?: string; appointment_id?: string })`.

`src/telemetry/tracer.ts`: OTel `NodeSDK` + `getNodeAutoInstrumentations`; a `traceMiddleware` that injects W3C context and adds `trace_id` to the log context. No-op console exporter when no endpoint configured.

`src/telemetry/metrics.ts`: prom-client `Registry`, `httpRequestDuration` histogram + `httpRequestsTotal` counter, a `metricsMiddleware` (Express handler) exposing `register.metrics()`.

`src/server.ts`: `loadConfig` → `buildApp({})` → listen; log startup; graceful shutdown.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/contract/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Write docker-compose + Dockerfile + verify it boots**

`docker-compose.yml`: services `db` (postgres:17-alpine, `POSTGRES_DB=keyloop`, healthcheck `pg_isready`, volume) and `app` (build `.`, env from `.env`, `depends_on db (condition: service_healthy)`, healthcheck on `/healthz`, port 8080). Commented-out `prometheus` and `otel-collector` stanzas. `Dockerfile`: `node:20-alpine` → `npm ci` → `tsc` → `node dist/server.js`, runs `knex migrate:latest` + seed on start (or via a compose entrypoint).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts knexfile.ts Dockerfile .dockerignore .env.example docker-compose.yml src/
git commit -m "chore: scaffold express+ts skeleton with docker compose and telemetry"
```

---

### Task 2: Database schema (migrations + seed)

**Files:**
- Create: `src/db/migrations/001_catalog.ts`, `002_resources.ts`, `003_appointments.ts`
- Create: `src/db/seeds/001_demo.ts`

**Interfaces:**
- Produces (tables/columns consumed by every later task): see DDL below.

- [ ] **Step 1: Write the failing test — exclusion constraints reject overlaps**

`test/integration/schema.test.ts` (runs against the compose/CI Postgres; skipped when `DATABASE_URL` unset):

```ts
test('appointment is hash-partitioned by dealership_id with both exclusion constraints on the parent', async () => {
  const strat = await pool.query(
    `SELECT partstrat FROM pg_partitioned_table p
       JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname = 'appointment'`
  );
  expect(strat.rows[0].partstrat).toBe('h');                       // hash
  const cons = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'appointment'::regclass AND contype = 'x'`
  );
  expect(cons.rows.map(r => r.conname).sort())
    .toEqual(['no_bay_overlap', 'no_tech_overlap']);
  const parts = await pool.query(
    `SELECT count(*) FROM pg_inherits WHERE inhparent = 'appointment'::regclass`
  );
  expect(Number(parts.rows[0].count)).toBe(4);                     // p0..p3
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/schema.test.ts`
Expected: FAIL — relation `appointment` does not exist.

- [ ] **Step 3: Implement the migrations**

`001_catalog.ts` (up):
- `service_type(id uuid pk default gen_random_uuid(), code text unique not null, name text not null, duration_min int not null, buffer_min int not null)`
- `skill(id uuid pk, code text unique not null, name text not null)`
- `bay_type(id uuid pk, code text unique not null, name text not null)`
- `technician_skill(technician_id uuid, skill_id uuid, proficiency int not null default 1, pk(technician_id, skill_id))` — FK added in 002 for technician.
- `service_type_required_skill(service_type_id uuid, skill_id uuid, min_proficiency int not null default 1, pk(service_type_id, skill_id))`
- `service_type_bay_type(service_type_id uuid, bay_type_id uuid, kind text not null check (kind in ('required','preferred')), pk(service_type_id, bay_type_id))`

`002_resources.ts` (up):
- `dealership(id uuid pk, name text not null, timezone text not null)` + `dealership_hours(dealership_id uuid, weekday int not null check (0..6), open_time time not null, close_time time not null, pk(dealership_id, weekday))`
- `service_bay(id uuid pk, dealership_id uuid not null, name text not null, bay_type_id uuid not null, active boolean not null default true)`
- `technician(id uuid pk, dealership_id uuid not null, name text not null, active boolean not null default true)` + `technician_shift(technician_id uuid, weekday int not null check (0..6), start_time time not null, end_time time not null, pk(technician_id, weekday))`
- `vehicle(id uuid pk, vin text unique not null, make text not null, model text not null, year int not null)`
- `customer(id uuid pk, name text not null, phone text, email text)`
- FKs for `technician_skill.technician_id → technician`, `technician_skill.skill_id → skill`, `service_bay.bay_type_id → bay_type`, and the catalog join tables.

`003_appointments.ts` (up) — the hot table:

```sql
create extension if not exists btree_gist;   -- "=" on scalar columns inside a GiST exclusion

-- hash-partitioned by dealership_id: all of one dealership's rows share a partition,
-- so its booking races never contend across partitions.
create table appointment (
  dealership_id uuid not null references dealership(id),
  id uuid not null default gen_random_uuid(),
  customer_id uuid not null references customer(id),
  vehicle_id uuid not null references vehicle(id),
  service_type_id uuid not null references service_type(id),
  service_bay_id uuid not null references service_bay(id),
  technician_id uuid not null references technician(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null check (status in ('HELD','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
  hold_expires_at timestamptz,
  cancelled_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  -- PK/UNIQUE must include the partition key on a partitioned table
  primary key (dealership_id, id),
  unique (dealership_id, idempotency_key)
) partition by hash (dealership_id);

-- fixed hash fan-out; a later migration adds partitions to reshard
create table appointment_p0 partition of appointment for values with (modulus 4, remainder 0);
create table appointment_p1 partition of appointment for values with (modulus 4, remainder 1);
create table appointment_p2 partition of appointment for values with (modulus 4, remainder 2);
create table appointment_p3 partition of appointment for values with (modulus 4, remainder 3);

-- one bay cannot hold two jobs; one tech cannot be in two places, same time.
-- Legal on PostgreSQL 17+ because the partition key dealership_id is included with "=".
alter table appointment add constraint no_bay_overlap
  exclude using gist (dealership_id with =, service_bay_id with =, tstzrange(start_at, end_at) with &&);
alter table appointment add constraint no_tech_overlap
  exclude using gist (dealership_id with =, technician_id with =, tstzrange(start_at, end_at) with &&);

create index appointment_dealership_time_idx on appointment (dealership_id, start_at, end_at);
create index appointment_status_idx on appointment (status) where status = 'HELD';
```

Plus `outbox(id bigserial pk, aggregate_id uuid not null, event_type text not null, payload jsonb not null, occurred_at timestamptz not null default now(), published_at timestamptz)`.

`down` for each migration reverses in order.

- [ ] **Step 4: Write and run the seed**

`001_demo.ts`: one `dealership` (timezone `Europe/London`, Mon–Fri 08:00–18:00, Sat 09:00–13:00), `bay_type`s `express`/`diagnostic`/`alignment`, `skill`s `general`/`brakes`/`electrical`/`diagnostics`, `service_type`s `oil_change` (30 min, buffer 15, skills `general`, bays `express` preferred + required), `brake_job` (90 min, buffer 30, skills `brakes`, bays `diagnostic`), `diagnostic` (120 min, buffer 30, skills `diagnostics`, bays `diagnostic` required), `major_repair` (240 min, buffer 60, skills `brakes`+`electrical`+`diagnostics`, bays `diagnostic`), 3 `service_bay`s, 2 `technician`s with skills/shifts, 1 `vehicle` (`vin` `1HGCM82633A004352`).

Run: `npx knex migrate:latest` then `npx knex seed:run`.
Expected: all steps complete with no error; `appointment` has 2 exclusion constraints.

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `npx vitest run test/integration/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/
git commit -m "feat: appointments schema with exclusion constraints, outbox, and demo seed"
```

---

### Task 3: Catalog and resources modules (reference-data readers)

**Files:**
- Create: `src/catalog/catalog.types.ts`, `src/catalog/catalog.repo.ts`, `src/catalog/catalog.router.ts`
- Create: `src/resources/resources.types.ts`, `src/resources/resources.repo.ts`, `src/resources/resources.router.ts`

**Interfaces:**
- Produces (used by Tasks 4–8):

```ts
interface ServiceTypeDetail {
  id: string; code: string; name: string;
  durationMin: number; bufferMin: number;
  requiredSkills: { skillCode: string; minProficiency: number }[];
  bayTypes: { bayTypeCode: string; kind: 'required' | 'preferred' }[];
}
interface CatalogReader { getServiceTypeDetail(code: string): Promise<ServiceTypeDetail | null>; }
interface CatalogRepository extends CatalogReader { listServiceTypes(): Promise<ServiceTypeDetail[]>; }

interface Vehicle { id: string; vin: string; make: string; model: string; year: number; }
interface VehicleReader { getByVin(vin: string): Promise<Vehicle | null>; }
interface Dealership {
  id: string; name: string; timezone: string;
  hours: { weekday: number; open: string; close: string }[]; // local HH:MM
}
interface DealershipReader { getById(id: string): Promise<Dealership | null>; }
interface ServiceBay { id: string; dealershipId: string; name: string; bayTypeCode: string; active: boolean; }
interface BayReader { listByDealership(dealershipId: string): Promise<ServiceBay[]>; }
interface Technician {
  id: string; dealershipId: string; name: string; active: boolean;
  skills: { skillCode: string; proficiency: number }[];
  shifts: { weekday: number; start: string; end: string }[]; // local HH:MM
}
interface TechnicianReader {
  listQualified(dealershipId: string, required: { skillCode: string; minProficiency: number }[]): Promise<Technician[]>;
}
```

- [ ] **Step 1: Write the failing test — qualified technician join**

`test/integration/resources.test.ts` (real DB):

```ts
test('listQualified returns only technicians with every required skill at min proficiency', async () => {
  const repo = new PgResourcesRepo(pool);
  const techs = await repo.listQualified(dealershipId, [
    { skillCode: 'diagnostics', minProficiency: 3 },
  ]);
  expect(techs.map(t => t.name)).toEqual(['Master Tech']); // not the general-only tech
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/resources.test.ts`
Expected: FAIL — `PgResourcesRepo` not implemented.

- [ ] **Step 3: Implement the repositories**

`catalog.repo.ts`: `getServiceTypeDetail` runs one query joining `service_type_required_skill → skill` and `service_type_bay_type → bay_type`, assembling `ServiceTypeDetail` (map FK codes to `code`). `listServiceTypes` returns the list.

`resources.repo.ts`:
- `getByVin` → `vehicle` row.
- `getById` → `dealership` + its `dealership_hours` rows ordered by weekday.
- `listByDealership` → `service_bay` join `bay_type` (map to `bayTypeCode`).
- `listQualified` → `technician` where `dealership_id = $1 and active`, plus their `technician_skill` and `technician_shift`; keep only techs whose skill set covers **every** required skill at ≥ `minProficiency` (do the coverage check in TS — simple and unit-testable; the SQL only filters by dealership).

- [ ] **Step 4: Add the routers and wire into `buildApp`**

`catalog.router.ts`: `GET /service-types` → `{ service_types: [...] }`.
`resources.router.ts`: `GET /dealerships/:id` → dealership + hours; `GET /vehicles/:vin` → vehicle or 404.
`app.ts`: `buildApp({ catalog, resources, ... })` mounts the routers; missing service returns 501 (so the health test still passes).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/integration/resources.test.ts test/contract/health.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog src/resources src/app.ts test/integration/resources.test.ts
git commit -m "feat: catalog and resource readers behind interfaces"
```

---

### Task 4: Availability Engine (continuous-slot intersection)

**Files:**
- Create: `src/availability/availability.types.ts`, `src/availability/interval.ts`, `src/availability/availability.engine.ts`
- Test: `test/unit/availability.interval.test.ts`, `test/unit/availability.engine.test.ts`

**Interfaces:**
- Consumes: `ServiceTypeDetail`, `Dealership`, `ServiceBay`, `Technician` (Task 3).
- Produces (used by Tasks 5–6, 9):

```ts
interface Slot {
  dealershipId: string; bayId: string; technicianId: string;
  startAt: string; endAt: string;           // ISO UTC
  preferredBay: boolean; score: number;      // lower = better
}
interface SlotSearchInput {
  dealershipId: string; serviceType: ServiceTypeDetail;
  desiredAt: string; horizonDays: number; limit: number;
}
interface BusyInterval { bayId: string; technicianId: string; startAt: string; endAt: string; }
interface AvailabilityEngine { findSlots(input: SlotSearchInput): Promise<Slot[]>; }
```

`interval.ts` exports pure helpers: `Interval { start: Date; end: Date }`, `subtract(base: Interval, cuts: Interval[]): Interval[]`, `union(intervals): Interval[]`, `overlaps(a, b): boolean`, `minutes(a): number`.

`AvailabilityEngine` constructor takes `(appointmentBusy: (dealershipId, from, to) => Promise<BusyInterval[]>, dealership, bays, technicians)` — the pure math stays unit-testable.

- [ ] **Step 1: Write the failing interval-math tests**

`test/unit/availability.interval.test.ts`:

```ts
test('subtract removes overlapping and contained cuts', () => {
  expect(subtract(day(8, 18), [range(9, 10), range(11, 12)]))
    .toEqual([range(8, 9), range(10, 11), range(12, 18)]);
});
test('subtract yields no interval when a cut covers the whole base', () => {
  expect(subtract(day(8, 18), [range(7, 19)])).toEqual([]);
});
```

`test/unit/availability.engine.test.ts` (drives the engine with fakes — no DB):

```ts
test('a 240min job does not fit a 120min gap', async () => {
  const slots = await engine.findSlots({ ...input, serviceType: majorRepair });
  expect(slots).toHaveLength(0);
});
test('buffer is removed from the gap and not added to the slot', async () => {
  // bay+tech free 08:00-10:00, service 60min + 30min buffer
  const slots = await engine.findSlots(input);
  expect(slots.map(s => [s.startAt, s.endAt]))
    .toEqual([['...08:00Z', '...09:00Z']]); // 60 min, not 90
});
test('a busy interval for a different bay still blocks the technician', async () => {
  const slots = await engine.findSlots(input);
  expect(slots.some(s => s.technicianId === busyTech)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/availability.interval.test.ts test/unit/availability.engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the algorithm**

`interval.ts`: standard closed-open interval arithmetic (the test cases pin the semantics).

`availability.engine.ts` — `findSlots` does:
1. Compute the search window `[now (or desiredAt if later), desiredAt + horizonDays]` in UTC.
2. Per compatible bay (bay whose `bay_type` satisfies the service's `required` types; `preferred` is captured as a flag), compute the bay's **open** intervals = dealership hours (local, converted to UTC for each day in the window) ∩ bay busy complement.
3. Per qualified technician, compute the tech's **open** intervals = shifts ∩ busy complement.
4. For each (bay, tech) pair, `free = openBay ∩ openTech`, then carve out `buffer` from the **end of every existing busy interval** (buffer time is "between jobs", never added to the slot length), then emit every sub-interval of `free` with `minutes(sub) >= durationMin` as a candidate slot of exactly `durationMin` (anchored at the sub-interval start, or centered on desired time — pick start-anchored).
5. Score = `|start − desiredAt|` + (preferredBay ? 0 : penalty) ; sort ascending, return top `limit`.

Only the interval math and the bay/tech compatibility are "the algorithm"; dealership-hours→UTC conversion lives in `common/time.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/availability.interval.test.ts test/unit/availability.engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/availability test/unit/availability.interval.test.ts test/unit/availability.engine.test.ts
git commit -m "feat: availability engine with duration-aware continuous slot intersection"
```

---

### Task 5: Slot search endpoint (`GET /slots`)

**Files:**
- Create: `src/booking/booking.service.ts` (search half), `src/booking/booking.router.ts`
- Test: `test/contract/slots.test.ts`

**Interfaces:**
- Consumes: `CatalogReader`, `VehicleReader`, `DealershipReader`, `BayReader`, `TechnicianReader` (Task 3), `AvailabilityEngine` (Task 4), `AppointmentRepository.busyIntervals` (declared here, implemented Task 6).
- Produces: `GET /slots?dealership_id=&service_type_code=&vin=&desired_at=&horizon_days=&limit=` → `200 { slots: Slot[] }`; `400` invalid input; `404` unknown dealership/service type/VIN; `422` desired time in the past (with `next_available` computed from next open window).

- [ ] **Step 1: Write the failing contract tests**

`test/contract/slots.test.ts` (fakes for all readers; a fake `busyIntervals` returning `[]`):

```ts
test('returns ranked slots nearest to desired time first', async () => {
  const res = await request(app).get('/slots')
    .query({ dealership_id: 'd1', service_type_code: 'oil_change', vin: 'VIN1', desired_at: '2026-10-12T09:00:00Z' });
  expect(res.status).toBe(200);
  expect(res.body.slots.length).toBeGreaterThan(0);
  const starts = res.body.slots.map(s => Date.parse(s.startAt));
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
});
test('rejects desired time in the past with 422', async () => {
  const res = await request(app).get('/slots').query({ ...pastTime });
  expect(res.status).toBe(422);
});
test('never returns a bay or technician from another dealership', async () => {
  const res = await request(app).get('/slots').query({ dealership_id: 'd1', ... });
  for (const s of res.body.slots) {
    expect(s.dealershipId).toBe('d1');
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/contract/slots.test.ts`
Expected: FAIL — `GET /slots` 404/501.

- [ ] **Step 3: Implement `BookingService.searchSlots` + the route**

`booking.service.ts` — `searchSlots(query: { dealershipId, serviceTypeCode, vin, desiredAt, horizonDays?, limit? })`:
1. Resolve catalog/vehicle/dealership in parallel via `Promise.all` (they are independent); throw `AppError(404, 'NOT_FOUND', ...)` on any miss, `AppError(422, 'VALIDATION_FAILED', 'desired time is in the past')` when `desiredAt < now`.
2. `bays = bayReader.listByDealership`, `techs = techReader.listQualified(dealershipId, serviceType.requiredSkills)` in parallel.
3. `busy = appointmentRepo.busyIntervals(dealershipId, from, to)`.
4. Build the engine and return `findSlots(...)`.

`booking.router.ts` — `GET /slots` parses/validates the query with Zod (`horizon_days` default 7, `limit` default 10), logs `{ trace_id, dealership_id, service_type_code, desired_at, slot_count, duration_ms }`, and responds. Errors map through `common/errors.ts` (422 for past time, 404 for unknown refs).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/contract/slots.test.ts test/unit/availability.engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/booking/booking.service.ts src/booking/booking.router.ts test/contract/slots.test.ts
git commit -m "feat: GET /slots advisory slot search"
```

---

### Task 6: Booking reserve (`POST /appointments`) — transactional, idempotent, 409 on race

**Files:**
- Create: `src/booking/booking.types.ts` (full types), `src/booking/booking.repo.ts`
- Modify: `src/booking/booking.service.ts`, `src/booking/booking.router.ts`
- Create: `src/outbox/outbox.types.ts`, `src/outbox/outbox.repo.ts`
- Test: `test/contract/appointments.test.ts`, `test/integration/concurrency.test.ts` (first half)

**Interfaces:**
- Produces:

```ts
interface Appointment { /* Task 2 columns, camelCase, ISO timestamps */ }
type CreateAppointmentResult =
  | { outcome: 'created'; appointment: Appointment }
  | { outcome: 'duplicate'; appointment: Appointment }
  | { outcome: 'conflict'; nextAvailable: Slot[] }
  | { outcome: 'invalid_slot'; reason: string };
interface ReserveInput { dealershipId: string; serviceTypeId: string; vehicleId: string; customerId: string;
  bayId: string; technicianId: string; startAt: string; endAt: string; idempotencyKey: string; holdMinutes: number; }
type ReserveResult =
  | { outcome: 'created'; appointment: Appointment }
  | { outcome: 'duplicate'; appointment: Appointment }
  | { outcome: 'conflict' };
interface AppointmentRepository {
  busyIntervals(dealershipId: string, from: string, to: string): Promise<BusyInterval[]>;
  createWithReserve(input: ReserveInput): Promise<ReserveResult>;
  updateStatus(id: string, from: AppointmentStatus[], to: AppointmentStatus, extra?: { cancelledReason?: string }): Promise<Appointment | null>;
  releaseExpiredHolds(now: string): Promise<string[]>;
  getById(id: string): Promise<Appointment | null>;
}
type DomainEvent = { type: 'AppointmentHeld' | 'AppointmentConfirmed' | 'AppointmentCancelled' | 'AppointmentCompleted' | 'AppointmentNoShow'; appointmentId: string; occurredAt: string };
interface OutboxWriter { append(trx: DbTx, event: DomainEvent): Promise<void>; }
```

`POST /appointments` body: `{ dealership_id, service_type_code, vin, customer: {name, phone, email}, bay_id, technician_id, start_at, end_at, idempotency_key }` → `201 { appointment }` | `409 { error: 'slot_taken', next_available }` | `422` validation | `404` unknown refs.

- [ ] **Step 1: Write the failing contract tests**

`test/contract/appointments.test.ts` (fake repo):

```ts
test('creates a HELD appointment with a 10-minute hold', async () => {
  const res = await request(app).post('/appointments').send(validBody);
  expect(res.status).toBe(201);
  expect(res.body.appointment.status).toBe('HELD');
  expect(Date.parse(res.body.appointment.holdExpiresAt) - Date.parse(res.body.appointment.startAt)).toBeGreaterThan(0);
});
test('returns 409 slot_taken with next_available when the repo reports a conflict', async () => {
  fakeRepo.createWithReserve.mockResolvedValue({ outcome: 'conflict' });
  const res = await request(app).post('/appointments').send(validBody);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('slot_taken');
  expect(res.body.next_available).toBeDefined();
});
test('returns the same appointment for a duplicate idempotency key', async () => {
  fakeRepo.createWithReserve.mockResolvedValue({ outcome: 'duplicate', appointment: existing });
  const res = await request(app).post('/appointments').send(validBody);
  expect(res.status).toBe(201);
  expect(res.body.appointment.id).toBe(existing.id);
});
test('rejects when bay/tech are not at the dealership or outside hours', async () => {
  const res = await request(app).post('/appointments').send({ ...validBody, bay_id: 'other-dealership-bay' });
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/contract/appointments.test.ts`
Expected: FAIL — `POST /appointments` not routed.

- [ ] **Step 3: Implement `createWithReserve` in `booking.repo.ts` (the authoritative check)**

One transaction (`const client = await pool.connect(); BEGIN … COMMIT/ROLLBACK`):

```sql
BEGIN;
-- serialize competitors for the same two resources
SELECT id FROM service_bay  WHERE id = $1 FOR UPDATE;
SELECT id FROM technician WHERE id = $1 FOR UPDATE;
-- re-verify still free for the full duration (status in the active set)
SELECT 1 FROM appointment
 WHERE dealership_id = $1 AND (service_bay_id = $2 OR technician_id = $3)
   AND status IN ('HELD','CONFIRMED')
   AND tstzrange(start_at, end_at) && tstzrange($4, $5)
 LIMIT 1;
-- if a row came back → ROLLBACK → { outcome: 'conflict' }

INSERT INTO appointment (dealership_id, customer_id, vehicle_id, service_type_id,
  service_bay_id, technician_id, start_at, end_at, status, hold_expires_at, idempotency_key)
VALUES (..., 'HELD', now() + make_interval(mins => $holdMinutes), $idempotencyKey)
ON CONFLICT (dealership_id, idempotency_key) DO NOTHING
RETURNING *;
-- 0 rows → the key already exists: SELECT existing, ROLLBACK → { outcome: 'duplicate', appointment: existing }
INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($appointmentId, 'AppointmentHeld', $payload);
COMMIT;
```

Catch: SQLSTATE `23P01` (exclusion violation) → `{ outcome: 'conflict' }`; `23505` on `(dealership_id, idempotency_key)` is pre-empted by `ON CONFLICT DO NOTHING`. The `INSERT … RETURNING` + `outbox` insert happen in the same transaction, so the event is atomic with the write. The `(dealership_id, idempotency_key)` unique constraint is the dedupe net; the exclusion constraints are the no-overlap net. The `SELECT … FOR UPDATE` locks `service_bay`/`technician` (both unpartitioned reference tables), which serializes competitors on the same resources before the insert.

`outbox.repo.ts`: `append(trx, event)` inserts into `outbox`; publishing transport is a `noop` stub for MVP (logged, not sent) — the table is the contract for the future stream.

- [ ] **Step 4: Implement `BookingService.createAppointment` + the route**

`createAppointment(input)`:
1. Resolve catalog (for `serviceTypeId`), vehicle by VIN (upsert if unknown VIN is **not** auto-created — 404 per brief's "unknown VIN" edge), dealership, and re-validate the requested bay/tech belong to the dealership (and bay/tech active), else `{ outcome: 'invalid_slot', reason }`.
2. Re-validate the requested `[startAt, endAt)` is exactly `durationMin` and `endAt − startAt = durationMin`, inside dealership hours + tech shift, else `invalid_slot`.
3. Upsert customer (by email/phone or create), then `appointmentRepo.createWithReserve({...})`.
4. Map result → `created`/`duplicate` (201) / `conflict` (re-run `searchSlots` for `nextAvailable`) / `invalid_slot` (422). Increment `bookingCounter` and, on conflict, `conflictCounter`; log outcome with `appointment_id`.

`booking.router.ts` — add `POST /appointments` with Zod body validation and `Idempotency-Key` header fallback (body key takes precedence).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/contract/appointments.test.ts test/contract/slots.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/booking src/outbox test/contract/appointments.test.ts
git commit -m "feat: transactional booking reserve with idempotency and slot_taken 409"
```

---

### Task 7: Appointment lifecycle (confirm/cancel/state machine) + hold reaper

**Files:**
- Create: `src/booking/state-machine.ts`
- Modify: `src/booking/booking.service.ts`, `src/booking/booking.repo.ts`, `src/booking/booking.router.ts`
- Create: `src/jobs/reaper.ts`
- Test: `test/unit/state-machine.test.ts`, `test/contract/appointments.test.ts` (extend)

**Interfaces:**
- Consumes: `AppointmentRepository.updateStatus` (Task 6), `DomainEvent`/`OutboxWriter` (Task 6).
- Produces: `POST /appointments/:id/confirm`, `POST /appointments/:id/cancel`, `GET /appointments/:id`; `reaper` interval.

State machine: `HELD → CONFIRMED`; `HELD → CANCELLED`; `CONFIRMED → COMPLETED | CANCELLED | NO_SHOW`; `CANCELLED/COMPLETED/NO_SHOW` are terminal. `updateStatus` must enforce `from` set (optimistic guard: `UPDATE … WHERE id=$1 AND status = ANY($2)`).

- [ ] **Step 1: Write the failing state-machine tests**

```ts
test('HELD may transition to CONFIRMED or CANCELLED', () => {
  expect(nextStates('HELD')).toEqual(['CONFIRMED', 'CANCELLED']);
});
test('CANCELLED is terminal', () => {
  expect(nextStates('CANCELLED')).toEqual([]);
});
test('updateStatus refuses a transition not in the allowed set', async () => {
  const res = await repo.updateStatus(id, ['HELD'], 'NO_SHOW'); // illegal: HELD→NO_SHOW
  expect(res).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/state-machine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the state machine + lifecycle methods**

`state-machine.ts`: `ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]>`, `nextStates(status)`, `canTransition(from, to)`.

`booking.repo.ts` `updateStatus`: `UPDATE appointment SET status=$to, cancelled_reason=$reason, updated_at=now() WHERE id=$id AND status = ANY($from) RETURNING *`; append the corresponding outbox event in the same transaction.

`booking.service.ts`: `confirm(id)` (calls `updateStatus(id, ['HELD'], 'CONFIRMED')`, throws `AppError(409, 'INVALID_TRANSITION', ...)` if null), `cancel(id)` (`HELD|CONFIRMED → CANCELLED` with reason `cancelled_by_customer`), `releaseExpiredHolds()` (`repo.releaseExpiredHolds(now)` → `HELD → CANCELLED` with reason `hold_expired`, count returned).

`booking.repo.ts` `releaseExpiredHolds`: `UPDATE … SET status='CANCELLED', cancelled_reason='hold_expired' WHERE status='HELD' AND hold_expires_at < $1 RETURNING id` — safe across instances because it only touches expired rows (single UPDATE, no long lock).

`booking.router.ts`: the three routes; `reaper.ts`: `setInterval(releaseExpiredHolds, 60_000)` with `unref()`, also runnable as its own entrypoint.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/state-machine.test.ts test/contract/appointments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/booking/state-machine.ts src/jobs/reaper.ts src/booking
git commit -m "feat: appointment state machine and hold reaper"
```

---

### Task 8: Diary views (technician calendar + dealership capacity)

**Files:**
- Create: `src/diary/diary.types.ts`, `src/diary/diary.service.ts`, `src/diary/diary.router.ts`
- Test: `test/contract/diary.test.ts`

**Interfaces:**
- Consumes: `AppointmentRepository.busyIntervals` + a new `AppointmentRepository.listByResource` (added here), `CatalogReader`, `VehicleReader`.
- Produces: `GET /technicians/:id/appointments?from=&to=` → `{ appointments: TechnicianCalendarEntry[] }`; `GET /dealerships/:id/capacity?from=&to=` → `CapacitySummary`.

```ts
interface TechnicianCalendarEntry {
  appointmentId: string; startAt: string; endAt: string; status: AppointmentStatus;
  serviceTypeCode: string; vehicleVin: string; bayName: string;
}
interface CapacitySummary {
  dealershipId: string; from: string; to: string;
  bays: { bayId: string; bayName: string; utilizationPct: number; busy: BusyInterval[] }[];
  technicians: { technicianId: string; name: string; utilizationPct: number; busy: BusyInterval[] }[];
}
```

- [ ] **Step 1: Write the failing contract tests**

```ts
test('technician calendar lists only that technician, chronological', async () => {
  const res = await request(app).get('/technicians/t1/appointments').query({ from, to });
  expect(res.status).toBe(200);
  expect(res.body.appointments.every(a => a.technicianId === 't1')).toBe(true);
  expect(starts).toEqual(sorted(starts));
});
test('capacity reports utilization as busy minutes / open minutes per bay and tech', async () => {
  const res = await request(app).get('/dealerships/d1/capacity').query({ from, to });
  expect(res.status).toBe(200);
  expect(res.body.bays[0].utilizationPct).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/contract/diary.test.ts`
Expected: FAIL — routes not found.

- [ ] **Step 3: Implement `DiaryService` + router**

`diary.service.ts`: `technicianCalendar` reads the tech's appointments in `[from,to)` (active statuses), enriches with `serviceTypeCode`/`vin`/`bayName` via the readers, sorts by `startAt`. `dealershipCapacity` reads all active appointments for the dealership in the window and computes `utilizationPct = busyMinutes / (dealership open minutes within the window)` per bay and per tech (open minutes from dealership hours). Wire the router into `buildApp`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/contract/diary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diary test/contract/diary.test.ts
git commit -m "feat: technician calendar and dealership capacity views"
```

---

### Task 9: End-to-end concurrency test, metrics verification, README

**Files:**
- Create: `test/integration/concurrency.test.ts`
- Create: `README.md`
- Modify: `src/server.ts` (wire the real `AppDeps` composition root), `docker-compose.yml` (entrypoint migrate+seed)

**Interfaces:**
- Consumes: everything above; `buildApp(deps)` real wiring in `server.ts`.

- [ ] **Step 1: Write the failing concurrency integration test**

`test/integration/concurrency.test.ts` (real Postgres from `DATABASE_URL`; skips otherwise):

```ts
test('two concurrent POSTs for the same slot → exactly one 201 and one 409', async () => {
  const slot = (await request(app).get('/slots').query({ ...seedParams })).body.slots[0];
  const body = { ...validBodyFor(slot), idempotency_key: crypto.randomUUID() };
  const [a, b] = await Promise.all([
    request(app).post('/appointments').send({ ...body, idempotency_key: crypto.randomUUID() }),
    request(app).post('/appointments').send({ ...body, idempotency_key: crypto.randomUUID() }),
  ]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([201, 409]);
  const conflict = a.status === 409 ? a : b;
  expect(conflict.body.error).toBe('slot_taken');
  const count = await pool.query(`SELECT count(*) FROM appointment WHERE service_bay_id=$1 AND technician_id=$2 AND tstzrange(start_at,end_at) && tstzrange($3,$4)`, [...]);
  expect(Number(count.rows[0].count)).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://... npx vitest run test/integration/concurrency.test.ts`
Expected: FAIL — `GET /slots`/`POST /appointments` not wired against real DB, or 500.

- [ ] **Step 3: Wire the composition root in `server.ts` + verify metrics**

`server.ts`: build real `pg Pool` → `PgCatalogRepo`, `PgResourcesRepo`, `PgAppointmentRepo`, `PgOutboxWriter` → `BookingService`, `DiaryService`, `AvailabilityEngine` (fed by `appointmentRepo.busyIntervals`) → `buildApp({...})` → listen + start reaper. Ensure `/metrics` exposes `httpRequestDuration`, `bookingCounter` (created vs duplicate), `conflictCounter`, `slotSearchDuration`.

- [ ] **Step 4: Run the full suite + concurrency test to verify they pass**

Run: `npx vitest run` (unit/contract with fakes; integration runs when `DATABASE_URL` set) then, with a live DB, `DATABASE_URL=... npx vitest run test/integration/concurrency.test.ts`.
Expected: all PASS; concurrency test shows one `201` + one `409`.

- [ ] **Step 5: Write README + verify `docker compose up` end-to-end**

`README.md`: prerequisites (Node 20, Docker), `cp .env.example .env`, `docker compose up --build`, the demo curl flow (list service types → `GET /slots` → `POST /appointments` → confirm → technician calendar → capacity), and a "How to split a module into a microservice" note pointing at the module interfaces.

Run: `docker compose up --build -d` then the demo curls against `localhost:8080`.
Expected: `GET /healthz` ok; `GET /slots` returns slots; `POST /appointments` returns `201` `HELD`; a second identical `POST` with a different idempotency key returns `409 slot_taken`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/integration/concurrency.test.ts README.md docker-compose.yml
git commit -m "test: concurrency integration test, composition root, and README"
```

---

## Self-Review Notes

- **Spec coverage:** mandatory requirements 1–3 (resource-constrained request, dual availability check, persistent appointment) → Tasks 3–6; continuous-slot search → Task 4–5; concurrency safety → Task 6 + 9; observability (logging/tracing/metrics) → Task 1 + 9; single source of truth + state machine → Tasks 2, 7; capacity view → Task 8. Nice-to-haves (parts, loaner, reminders, digital check-in) are intentionally out of scope per the brief.
- **Step scan:** each step names the test and assertion (or the command + expected output); code steps give exact signatures and the pinned DDL/reserve SQL; no "TBD" or transcript-only bodies.
- **Type consistency:** `ServiceTypeDetail`, `Slot`, `SlotSearchInput`, `BusyInterval`, `AppointmentRepository`, `ReserveResult`, `OutboxWriter`, `DiaryService` are defined once (Tasks 3/4/6/8) and referenced verbatim in later tasks.
- **Review Focus:** all 7 lines have an owning test in Tasks 4–6 and 9.
- **Proportion:** ~1:1 with the spec's scope; bodies appear only for the two things a signature cannot determine (the exclusion DDL and the reserve transaction).
