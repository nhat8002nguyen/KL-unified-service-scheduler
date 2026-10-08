# Unified Service Scheduler — Scenario A

A service-appointment scheduler: it searches for continuous slots where a
compatible **bay** *and* a qualified **technician** are both free for the full
job duration, then books an appointment with a database-level guarantee that no
bay or technician is ever double-booked.

Stack: **Node 24 + TypeScript, Express 5, PostgreSQL 17**. Observability: pino
logs, OpenTelemetry traces, Prometheus metrics. Runs with **Docker Compose**.

## The one rule

> A service appointment is a simultaneous reservation of a physical bay and a
> skilled human for a continuous block of time whose length is determined by the
> service type.

Availability is therefore checked **twice**:

| Call | Authority | What it does |
|---|---|---|
| `GET /slots` | advisory (best effort) | ranked, duration-aware continuous slots |
| `POST /appointments` | **authoritative** | transactional check-and-reserve; the DB decides |

`GET /slots` may be slightly stale. `POST /appointments` re-checks inside one
transaction and lets PostgreSQL **exclusion constraints** reject any overlap, so
two racing requests produce exactly one `201` and one `409`.

## Quick start (Docker Compose)

```bash
cp .env.example .env
docker compose up --build
# app on http://localhost:8080, postgres published on localhost:5433
```

The app container migrates and seeds on boot (`npm run db:setup`), then serves.

## Quick start (local)

```bash
npm install
export DATABASE_URL=postgres://keyloop:keyloop@localhost:5433/keyloop
npm run db:setup     # migrate + seed
npm run dev          # tsx watch src/server.ts
```

Requires a PostgreSQL **17+** (the partitioned exclusion constraint needs 17).

## Demo flow

```bash
BASE=http://localhost:8080

curl -s "$BASE/healthz"      # {"status":"ok"}
curl -s "$BASE/metrics" | head

# 1. reference data
curl -s "$BASE/service-types"
curl -s "$BASE/dealerships/00000000-0000-0000-0000-000000000100"

# 2. search for slots (advisory)
DESIRED=$(date -u -v+1d +%Y-%m-%dT10:00:00Z 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT10:00:00Z)
curl -s "$BASE/slots?dealership_id=00000000-0000-0000-0000-000000000100&service_type_code=diagnostic&vin=1HGCM82633A004352&desired_at=$DESIRED" | jq

# 3. book the first slot (authoritative)
#    copy bayId/technicianId/startAt/endAt from the response above
curl -s -X POST "$BASE/appointments" -H 'content-type: application/json' -d '{
  "dealership_id": "00000000-0000-0000-0000-000000000100",
  "service_type_code": "diagnostic",
  "vin": "1HGCM82633A004352",
  "customer": { "name": "Demo Customer", "email": "demo.customer@example.com" },
  "bay_id": "<bayId>", "technician_id": "<technicianId>",
  "start_at": "<startAt>", "end_at": "<endAt>",
  "idempotency_key": "demo-1"
}'
#    -> 201 { appointment: { status: "HELD", holdExpiresAt } }

# 4. confirm, then view the technician calendar / manager capacity
curl -s -X POST "$BASE/appointments/<id>/confirm"
curl -s "$BASE/technicians/00000000-0000-0000-0000-000000000302/appointments?from=$FROM&to=$TO"
curl -s "$BASE/dealerships/00000000-0000-0000-0000-000000000100/capacity?from=$FROM&to=$TO"
```

Post the same slot twice in parallel and you get one `201` and one
`409 {"error":"slot_taken","next_available":[...]}`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness |
| GET | `/readyz` | readiness (DB ping) |
| GET | `/metrics` | Prometheus metrics |
| GET | `/service-types` | catalog (duration, buffer, skills, bay types) |
| GET | `/dealerships/:id` | dealership + opening hours |
| GET | `/vehicles/:vin` | vehicle lookup |
| GET | `/slots` | advisory ranked slot search |
| POST | `/appointments` | book (transactional reserve, idempotent) |
| GET | `/appointments/:id` | read one appointment |
| POST | `/appointments/:id/confirm` | `HELD -> CONFIRMED` |
| POST | `/appointments/:id/cancel` | `HELD|CONFIRMED -> CANCELLED` |
| GET | `/technicians/:id/appointments` | technician calendar |
| GET | `/dealerships/:id/capacity` | manager capacity/utilization |

## Architecture

One Express app, composed of modules with narrow interfaces. Each module is a
future microservice seam — the scheduler talks to an interface, not a table.

```
src/
  app.ts                    buildApp(deps) — injectable, no listen
  server.ts                 composition root (picks concrete adapters)
  catalog/                  service types, skills, bay types   -> Service Catalog
  resources/                vehicle / dealership / bay / technician readers
  availability/             interval algebra + continuous-slot engine
  booking/                  search + transactional reserve + lifecycle
  diary/                    technician calendar + manager capacity (read model)
  outbox/                   events written in the same tx as the write (stub transport)
  telemetry/                pino logger + OpenTelemetry tracer + prom-client
  jobs/reaper.ts            releases expired holds
  db/                       pool, knex config, migrations, seeds
```

- **Single writer:** only the booking service writes the diary. Everyone reads
  through it (or the diary read model).
- **The DB is the safety net:** `appointment` is hash-partitioned by
  `dealership_id` and carries two `EXCLUDE USING gist` constraints
  (`no_bay_overlap`, `no_tech_overlap`). An overlapping insert throws SQLSTATE
  `23P01`; the loser of a race gets a clean `409`. Partitioning needs
  PostgreSQL 17+ because the constraint includes the partition key (`dealership_id
  WITH =`).
- **Idempotency:** `unique (dealership_id, idempotency_key)` makes a client retry
  return the original appointment (checked before the overlap test).
- **Reference data is cached/cheap; diaries are not** — no replicated schedules.

### Splitting a module into a microservice

Every module depends on an interface, e.g. `CatalogReader`, `VehicleReader`,
`TechnicianReader`, `DiaryRepository`. To extract one:

1. Implement the interface as an HTTP client (`HttpCatalogReader`) for the
   existing app.
2. Stand the module up as its own service exposing the same operations.
3. Swap the binding in `src/server.ts` — no other file changes.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `LOG_LEVEL` | `info` | pino level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP HTTP endpoint; empty = ids only |
| `HOLD_MINUTES` | `10` | slot hold TTL |

## Observability

- **Logs (pino):** one JSON line per request with `trace_id`, path, status,
  duration; booking outcomes log `slot_taken`, slot search logs `slot_count`.
- **Traces (OpenTelemetry):** HTTP + pg spans; point
  `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector to export.
- **Metrics (prom-client):** `http_request_duration_seconds`,
  `http_requests_total`, `slot_search_duration_seconds`, `appointments_total`
  (created|duplicate|conflict|invalid_slot), `appointment_conflicts_total`.

## Testing

```bash
npm test                # all (unit + contract always; integration when DATABASE_URL is set)
npm run test:unit       # pure logic
npm run test:integration
```

- **Unit:** interval algebra, availability engine, state machine.
- **Contract:** endpoint behaviour with fake adapters (supertest).
- **Integration:** real PostgreSQL — schema/partitioning, reserve + idempotency,
  lifecycle, reaper, and the parallel-booking race (one `201`, one `409`).

### Manual API testing (Postman)

`postman/` ships a ready-to-run collection and two environments — see
[postman/README.md](postman/README.md). Import them, pick an environment, and
run the requests top to bottom: *Search slots* stores the chosen slot and
*Book appointment* stores the id, so the rest of the flow just works.
`test/contract/postman.test.ts` keeps the collection honest (valid JSON, every
`{{variable}}` defined, every request asserted).
