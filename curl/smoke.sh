#!/usr/bin/env bash
# smoke.sh runs the whole booking flow with curl; the same sequence as the
# Postman collection, for when Postman is unavailable.
#
#   BASE_URL=http://localhost:8080 ./curl/smoke.sh
#
# Needs only curl. Uses jq when it is installed, and falls back to grep/sed when
# it is not. Exits non-zero if any expected status does not match.

set -u

BASE_URL="${BASE_URL:-http://localhost:8080}"
DEALERSHIP_ID="${DEALERSHIP_ID:-00000000-0000-0000-0000-000000000100}"
VIN="${VIN:-1HGCM82633A004352}"
SERVICE_TYPE="${SERVICE_TYPE:-diagnostic}"

pass=0
fail=0
RESP=""
STATUS=""
BODY=""

# request performs one HTTP call and splits the response into BODY and STATUS.
request() {
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    RESP=$(curl -s -w '\n%{http_code}' -X "$method" -H 'content-type: application/json' -d "$data" "$url")
  else
    RESP=$(curl -s -w '\n%{http_code}' -X "$method" "$url")
  fi
  STATUS="${RESP##*$'\n'}"
  BODY="${RESP%$'\n'*}"
}

# json_get <json> <jq-filter> <grep-key> reads a string field, preferring jq and
# falling back to the first matching key (which is the nested one we want).
json_get() {
  local json="$1" filter="$2" key="$3"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r "$filter // empty" 2>/dev/null
  else
    printf '%s' "$json" | grep -o "\"$key\":\"[^\"]*\"" | head -1 | sed "s/.*\"$key\":\"//; s/\"$//"
  fi
}

json_has() {
  local json="$1" needle="$2"
  printf '%s' "$json" | grep -q "$needle"
}

# check asserts the last response's status code.
check() {
  local want="$1" label="$2"
  if [ "$STATUS" = "$want" ]; then
    printf '  ok   %-46s %s\n' "$label" "$STATUS"
    pass=$((pass + 1))
  else
    printf '  FAIL %-46s expected %s, got %s\n' "$label" "$want" "$STATUS"
    printf '       body: %s\n' "$(printf '%s' "$BODY" | head -c 200)"
    fail=$((fail + 1))
  fi
}

# plus_one_day prints a UTC ISO instant roughly a day ahead (BSD or GNU date).
plus_one_day() {
  date -u -v+1d +%Y-%m-%dT10:00:00Z 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT10:00:00Z
}

# now_iso / plus_days_iso bound the diary windows.
now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}
plus_days_iso() {
  date -u -v+"$1"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+$1 days" +%Y-%m-%dT%H:%M:%SZ
}

printf 'Unified Service Scheduler - curl smoke test\n'
printf 'base url: %s\n\n' "$BASE_URL"

printf '1. service health\n'
request GET "$BASE_URL/healthz"; check 200 "GET /healthz"
request GET "$BASE_URL/readyz"; check 200 "GET /readyz"
request GET "$BASE_URL/metrics"; check 200 "GET /metrics"

printf '\n2. reference data\n'
request GET "$BASE_URL/service-types"; check 200 "GET /service-types"
request GET "$BASE_URL/dealerships/$DEALERSHIP_ID"; check 200 "GET /dealerships/:id"
request GET "$BASE_URL/vehicles/$VIN"; check 200 "GET /vehicles/:vin"

printf '\n3. booking flow\n'
DESIRED=$(plus_one_day)
request GET "$BASE_URL/slots?dealership_id=$DEALERSHIP_ID&service_type_code=$SERVICE_TYPE&vin=$VIN&desired_at=$DESIRED&horizon_days=7"
check 200 "GET /slots"
BAY_ID=$(json_get "$BODY" '.slots[0].bayId' bayId)
TECH_ID=$(json_get "$BODY" '.slots[0].technicianId' technicianId)
START_AT=$(json_get "$BODY" '.slots[0].startAt' startAt)
END_AT=$(json_get "$BODY" '.slots[0].endAt' endAt)
if [ -z "$BAY_ID" ] || [ -z "$START_AT" ]; then
  printf '  FAIL no slot returned; is the database seeded?\n'
  exit 1
fi
printf '       picked slot %s .. %s (bay %s, tech %s)\n' "$START_AT" "$END_AT" "$BAY_ID" "$TECH_ID"

# body builds the booking payload with a fresh idempotency key.
body() {
  printf '{"dealership_id":"%s","service_type_code":"%s","vin":"%s","customer":{"name":"%s","email":"%s"},"bay_id":"%s","technician_id":"%s","start_at":"%s","end_at":"%s","idempotency_key":"%s"}' \
    "$DEALERSHIP_ID" "$SERVICE_TYPE" "$VIN" "$1" "$2" "$BAY_ID" "$TECH_ID" "$START_AT" "$END_AT" "$3"
}

KEY_A="smoke-$$-a"
request POST "$BASE_URL/appointments" "$(body 'Smoke Customer' 'smoke@example.com' "$KEY_A")"
check 201 "POST /appointments (first)"
APP_ID=$(json_get "$BODY" '.appointment.id' id)

request POST "$BASE_URL/appointments" "$(body 'Second Customer' 'second@example.com' "smoke-$$-b")"
check 409 "POST /appointments (same slot again)"
json_has "$BODY" 'slot_taken' && printf '  ok   %-46s %s\n' "      → error is slot_taken" "" || printf '  FAIL body was not slot_taken\n'

request POST "$BASE_URL/appointments" "$(body 'Smoke Customer' 'smoke@example.com' "$KEY_A")"
check 200 "POST /appointments (idempotent retry)"
repeat_id=$(json_get "$BODY" '.appointment.id' id)
if [ "$repeat_id" = "$APP_ID" ]; then
  printf '  ok   %-46s %s\n' "      → same appointment id" ""
  pass=$((pass + 1))
else
  printf '  FAIL idempotent retry returned a different id (%s vs %s)\n' "$repeat_id" "$APP_ID"
  fail=$((fail + 1))
fi

request POST "$BASE_URL/appointments/$APP_ID/confirm"; check 200 "POST /appointments/:id/confirm"
request GET "$BASE_URL/appointments/$APP_ID"; check 200 "GET /appointments/:id"
request POST "$BASE_URL/appointments/$APP_ID/cancel"; check 200 "POST /appointments/:id/cancel"

printf '\n4. diary views\n'
FROM=$(now_iso)
TO=$(plus_days_iso 7)
request GET "$BASE_URL/technicians/$TECH_ID/appointments?from=$FROM&to=$TO"; check 200 "GET /technicians/:id/appointments"
request GET "$BASE_URL/dealerships/$DEALERSHIP_ID/capacity?from=$FROM&to=$TO"; check 200 "GET /dealerships/:id/capacity"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
