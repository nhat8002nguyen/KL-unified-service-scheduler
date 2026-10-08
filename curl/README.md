# cURL examples

The same flow as the Postman collection, for when Postman isn't available.
Every command below is copy-pasteable.

- Prefer a script? Run [`smoke.sh`](smoke.sh) — it walks the whole flow and
  checks each status: `BASE_URL=http://localhost:8080 ./curl/smoke.sh`
- Prefer Postman? See [`../postman/README.md`](../postman/README.md).

## Setup

```bash
BASE_URL=${BASE_URL:-http://localhost:8080}

# seeded demo data (see src/db/seeds/001_demo.ts)
DEALERSHIP_ID=00000000-0000-0000-0000-000000000100
VIN=1HGCM82633A004352
SERVICE_TYPE=diagnostic

# a future instant for the slot search (BSD/macOS or GNU date)
DESIRED=$(date -u -v+1d +%Y-%m-%dT10:00:00Z 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT10:00:00Z)
```

Start the app first (either `docker compose up --build`, or
`npm run db:setup && npm run dev` against a PostgreSQL 17).

## 1. Service health

```bash
curl -s "$BASE_URL/healthz"                  # {"status":"ok"}
curl -s "$BASE_URL/readyz"                   # {"status":"ready"}
curl -s "$BASE_URL/metrics" | head           # Prometheus text
```

## 2. Reference data

```bash
curl -s "$BASE_URL/service-types"
curl -s "$BASE_URL/dealerships/$DEALERSHIP_ID"
curl -s "$BASE_URL/vehicles/$VIN"
```

An unknown reference returns `404`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/vehicles/NOPE"   # 404
```

## 3. Search slots (advisory)

```bash
curl -s "$BASE_URL/slots?dealership_id=$DEALERSHIP_ID&service_type_code=$SERVICE_TYPE&vin=$VIN&desired_at=$DESIRED&horizon_days=7"
```

```jsonc
{ "slots": [ { "dealershipId": "...", "bayId": "...", "technicianId": "...",
               "startAt": "2026-10-09T09:30:00.000Z", "endAt": "2026-10-09T11:30:00.000Z",
               "preferredBay": false, "score": 90 } ] }
```

A `desired_at` in the past is rejected with `422`.

## 4. Book the first slot (authoritative)

Grab the chosen slot with `jq` (or copy the fields by hand):

```bash
SLOT=$(curl -s "$BASE_URL/slots?dealership_id=$DEALERSHIP_ID&service_type_code=$SERVICE_TYPE&vin=$VIN&desired_at=$DESIRED&horizon_days=7" | jq '.slots[0]')
BAY_ID=$(echo "$SLOT" | jq -r .bayId)
TECH_ID=$(echo "$SLOT" | jq -r .technicianId)
START_AT=$(echo "$SLOT" | jq -r .startAt)
END_AT=$(echo "$SLOT" | jq -r .endAt)
```

```bash
curl -s -X POST "$BASE_URL/appointments" -H 'content-type: application/json' -d '{
  "dealership_id": "'"$DEALERSHIP_ID"'",
  "service_type_code": "'"$SERVICE_TYPE"'",
  "vin": "'"$VIN"'",
  "customer": { "name": "cURL Customer", "email": "curl@example.com" },
  "bay_id": "'"$BAY_ID"'",
  "technician_id": "'"$TECH_ID"'",
  "start_at": "'"$START_AT"'",
  "end_at": "'"$END_AT"'",
  "idempotency_key": "curl-demo-1"
}'
# -> 201 { "appointment": { "id": "...", "status": "HELD", "holdExpiresAt": "..." } }
```

Capture the id:

```bash
APP_ID=$(curl -s -X POST "$BASE_URL/appointments" -H 'content-type: application/json' -d '{
  "dealership_id": "'"$DEALERSHIP_ID"'", "service_type_code": "'"$SERVICE_TYPE"'", "vin": "'"$VIN"'",
  "customer": { "name": "cURL Customer", "email": "curl@example.com" },
  "bay_id": "'"$BAY_ID"'", "technician_id": "'"$TECH_ID"'",
  "start_at": "'"$START_AT"'", "end_at": "'"$END_AT"'",
  "idempotency_key": "curl-demo-2"
}' | jq -r .appointment.id)
```

## 5. The two guarantees

**Idempotent retry** — same `idempotency_key` returns the same appointment (`201`):

```bash
# repeat the exact request from step 4 (same idempotency_key) -> same "id"
```

**No double booking** — the *same slot* with a *new* key gets `409`:

```bash
curl -s -X POST "$BASE_URL/appointments" -H 'content-type: application/json' -d '{
  "dealership_id": "'"$DEALERSHIP_ID"'", "service_type_code": "'"$SERVICE_TYPE"'", "vin": "'"$VIN"'",
  "customer": { "name": "Someone Else", "email": "other@example.com" },
  "bay_id": "'"$BAY_ID"'", "technician_id": "'"$TECH_ID"'",
  "start_at": "'"$START_AT"'", "end_at": "'"$END_AT"'",
  "idempotency_key": "curl-demo-3"
}'
# -> 409 { "error": "slot_taken", "next_available": [ ... ] }
```

## 6. Lifecycle

```bash
curl -s "$BASE_URL/appointments/$APP_ID"                      # 200, status HELD
curl -s -X POST "$BASE_URL/appointments/$APP_ID/confirm"      # 200, status CONFIRMED
curl -s -X POST "$BASE_URL/appointments/$APP_ID/cancel"       # 200, status CANCELLED

# the state machine refuses an illegal move
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE_URL/appointments/$APP_ID/confirm"   # 409
curl -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/appointments/nope"                      # 404
```

A cancelled appointment frees its interval — repeating step 4 with a fresh
`idempotency_key` **after** cancel returns `201`, not `409`.

## 7. Diary views

```bash
FROM=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TO=$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)

curl -s "$BASE_URL/technicians/$TECH_ID/appointments?from=$FROM&to=$TO"
curl -s "$BASE_URL/dealerships/$DEALERSHIP_ID/capacity?from=$FROM&to=$TO"
```

## Notes

- Every `POST /appointments` needs an `idempotency_key`. A retry with the *same*
  key returns the original appointment; a *new* key for a taken slot returns `409`.
- `Idempotency-Key` as a request header also works when the body omits the field.
- Slots are held for `HOLD_MINUTES` (default 10); the reaper releases expired
  holds and frees the interval.
