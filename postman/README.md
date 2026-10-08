# Postman collection

Import both files into Postman:

1. `unified-service-scheduler.postman_collection.json` (the collection)
2. `local.postman_environment.json` **or** `docker-compose.postman_environment.json` (pick one as the active environment)

Both environments point at `http://localhost:8080` (the app publishes 8080 whether you run `npm run dev` or `docker compose up`); they differ only in the label so you can tell at a glance which stack you are hitting.

## Start the app first

```bash
# either
docker compose up --build
# or
export DATABASE_URL=postgres://keyloop:keyloop@localhost:5433/keyloop
npm run db:setup && npm run dev
```

## Run the requests top to bottom

The collection runs a collection-level pre-request script that keeps `desiredAt`,
`from`, and `to` in the future, so the flow never goes stale.

| # | Request | What it proves |
|---|---|---|
| 1 | Health / Readiness / Metrics | service is up; Prometheus counters exposed |
| 2 | Service types / Dealership / Vehicle | reference data resolves |
| 3 | **Search slots** | advisory search returns ranked slots; stores `bayId`, `technicianId`, `startAt`, `endAt` |
| 4 | **Book appointment** | `201` with `status: HELD`; stores `appointmentId` |
| 5 | **Book the same slot again** | `409 { error: "slot_taken", next_available }` — no double booking |
| 6 | Confirm → Get → Cancel | `HELD → CONFIRMED → CANCELLED` lifecycle |
| 7 | Technician calendar / Dealership capacity | diary read views |

Because step 3 stores the picked slot into the environment, steps 4–6 reuse it —
run them in order. Re-running the whole collection with a fresh environment (the
eye/refresh icon clears runtime values) exercises a new slot each time.

> **Note:** booking the *same* slot twice in parallel is the real race; the
> collection proves the sequential version (a new idempotency key still gets
> `409`). The true concurrency guarantee is covered by
> `test/integration/concurrency.test.ts`.

## Variables

| Variable | Set by | Meaning |
|---|---|---|
| `baseUrl` | environment | `http://localhost:8080` |
| `dealershipId` | environment | the seeded demo dealership |
| `vin` | environment | the seeded vehicle |
| `serviceTypeCode` | environment | `diagnostic` (120 min, diagnostic bay, diagnostics skill) |
| `desiredAt`, `from`, `to` | pre-request script | refreshed into the future |
| `bayId`, `technicianId`, `startAt`, `endAt` | **Search slots** | the picked slot |
| `appointmentId` | **Book appointment** | the created appointment |

`postman.test.ts` in `test/contract/` keeps these files honest: it checks every
`{{variable}}` is defined and every request asserts something.
