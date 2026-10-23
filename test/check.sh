#!/usr/bin/env bash
# Level-by-level verification of the booking API. Needs only curl + jq.
# Usage: BASE_URL=http://localhost:3000 API_KEY=... [MAX_LEVEL=5] ./test/check.sh
set -u

BASE_URL=${BASE_URL:?set BASE_URL}
BASE_URL=${BASE_URL%/}
API_KEY=${API_KEY:?set API_KEY}
MAX_LEVEL=${MAX_LEVEL:-5}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
STATUS=''
BODY=''

pass() { echo "PASS $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL $1 — $2"; FAILED=$((FAILED + 1)); }

# Every assertion gets its own email so the 5-per-minute limit never turns a 400 into a 429.
email() { echo "$1-$RANDOM$RANDOM@test.com"; }

booking_body() {
  jq -nc --arg s "$1" --arg n "$2" --arg e "$3" '{slot_id: $s, name: $n, email: $e}'
}

# request_as KEY METHOD PATH [BODY] [extra curl args...]; empty KEY sends no X-API-Key header.
request_as() {
  local key=$1 method=$2 path=$3 body=${4-}
  shift 3
  [ $# -gt 0 ] && shift
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X "$method")
  [ -n "$key" ] && args+=(-H "X-API-Key: $key")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  STATUS=$(curl "${args[@]}" "$@" "$BASE_URL$path")
  BODY=$(cat "$TMP/body")
}

request() { request_as "$API_KEY" "$@"; }

field() { jq -r "$1" <<<"$BODY" 2>/dev/null; }

header() { grep -i "^$1:" "$TMP/headers" | tail -1 | cut -d: -f2- | tr -d ' \r'; }

expect_status() {
  if [ "$STATUS" = "$2" ]; then pass "$1"; else fail "$1" "expected $2, got $STATUS: $BODY"; fi
}

# expect_status plus a jq predicate on the body.
expect() {
  local name=$1 want=$2 filter=$3
  if [ "$STATUS" != "$want" ]; then
    fail "$name" "expected $want, got $STATUS: $BODY"
  elif jq -e "$filter" <<<"$BODY" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name" "body did not match ($filter): $BODY"
  fi
}

expect_error() { expect "$1" "$2" 'keys == ["error"] and (.error | type == "string")'; }

reset_with() {
  request POST /reset "$2"
  expect "$1: reset" 200 '. == {"ok": true}'
}

slot_json() {
  jq -nc --arg id "$1" --arg p "$2" --arg s "$3" --arg e "$4" '{id: $id, provider: $p, start: $s, end: $e}'
}

slots_fixture() {
  local out='' item
  for item in "$@"; do out="$out${out:+,}$item"; done
  echo "{\"slots\":[$out]}"
}

# fire_concurrent N PREFIX KEY BODY: N simultaneous POST /bookings; results in $TMP/PREFIX_i.{code,body}.
fire_concurrent() {
  local n=$1 prefix=$2 key=$3 body=$4 i
  for i in $(seq 1 "$n"); do
    if [ -n "$key" ]; then
      curl -s -o "$TMP/${prefix}_$i.body" -w '%{http_code}' -X POST \
        -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" \
        --data "$body" "$BASE_URL/bookings" >"$TMP/${prefix}_$i.code" &
    else
      curl -s -o "$TMP/${prefix}_$i.body" -w '%{http_code}' -X POST \
        -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
        --data "$(booking_body "$body" "Racer $i" "$(email "race$i")")" "$BASE_URL/bookings" >"$TMP/${prefix}_$i.code" &
    fi
  done
  wait
}

finish() {
  echo
  echo "Summary: $PASSED passed, $FAILED failed (levels 1–$MAX_LEVEL)"
  [ "$FAILED" -eq 0 ]
  exit $?
}

FUTURE_DAY=2030-01-15
PAST_DAY=2020-01-15

# ---------------------------------------------------------------- Level 1
echo "== Level 1: list, book, look up"
# Slots are sent out of order; l1-b uses a +01:00 offset to prove sorting is by instant and start/end echo raw.
reset_with L1 "$(slots_fixture \
  "$(slot_json l1-c 'Dr Nkechi' "${FUTURE_DAY}T10:00:00Z" "${FUTURE_DAY}T10:30:00Z")" \
  "$(slot_json l1-a 'Dr Ade' "${FUTURE_DAY}T09:00:00Z" "${FUTURE_DAY}T09:30:00Z")" \
  "$(slot_json l1-past 'Dr Musa' "${PAST_DAY}T09:00:00Z" "${PAST_DAY}T09:30:00Z")" \
  "$(slot_json l1-b 'Dr Ade' "${FUTURE_DAY}T10:30:00+01:00" "${FUTURE_DAY}T11:00:00+01:00")")"

request GET /slots
expect "L1: GET /slots returns 4 slots" 200 '.slots | length == 4'
expect "L1: slots ordered by start time" 200 '[.slots[].id] == ["l1-past","l1-a","l1-b","l1-c"]'
expect "L1: all slots available (past included)" 200 'all(.slots[]; .available == true)'
expect "L1: slot has exactly id/provider/start/end/available" 200 \
  'all(.slots[]; (keys | sort) == ["available","end","id","provider","start"])'
expect "L1: start/end echo the raw strings" 200 \
  '(.slots[] | select(.id == "l1-b")) as $s | $s.start == "'"${FUTURE_DAY}"'T10:30:00+01:00" and $s.end == "'"${FUTURE_DAY}"'T11:00:00+01:00"'

request GET "/slots?provider=Dr%20Ade"
expect "L1: ?provider= filters exactly" 200 '[.slots[].id] == ["l1-a","l1-b"]'
request GET "/slots?provider=dr%20ade"
expect "L1: ?provider= is case-sensitive" 200 '.slots == []'

L1_EMAIL=$(email l1-book)
request POST /bookings "$(booking_body l1-a 'Ada Obi' "$L1_EMAIL")"
expect "L1: book a slot -> 201 confirmed" 201 \
  '.status == "confirmed" and .slot_id == "l1-a" and .name == "Ada Obi" and .email == "'"$L1_EMAIL"'" and (.id | length > 0) and (.created_at | test("^\\d{4}-\\d{2}-\\d{2}T.*Z$"))'
L1_BOOKING=$BODY
L1_ID=$(field .id)

request GET /slots
expect "L1: booked slot now unavailable" 200 \
  '(.slots[] | select(.id == "l1-a") | .available) == false and (.slots[] | select(.id == "l1-c") | .available) == true'

request GET "/bookings/$L1_ID"
expect "L1: GET /bookings/:id returns the same booking" 200 ". == $L1_BOOKING"

request GET /bookings/does-not-exist
expect "L1: unknown booking -> 404" 404 '. == {"error": "booking not found"}'

[ "$MAX_LEVEL" -ge 2 ] || finish

# ---------------------------------------------------------------- Level 2
echo "== Level 2: API key, input validation"
reset_with L2 "$(slots_fixture \
  "$(slot_json l2-a 'Dr Ade' "${FUTURE_DAY}T09:00:00Z" "${FUTURE_DAY}T09:30:00Z")" \
  "$(slot_json l2-b 'Dr Ade' "${FUTURE_DAY}T09:30:00Z" "${FUTURE_DAY}T10:00:00Z")" \
  "$(slot_json l2-past 'Dr Musa' "${PAST_DAY}T09:00:00Z" "${PAST_DAY}T09:30:00Z")")"

L2_RESET_BODY=$(slots_fixture "$(slot_json x 'Dr X' "${FUTURE_DAY}T09:00:00Z" "${FUTURE_DAY}T09:30:00Z")")
L2_BOOK_BODY=$(booking_body l2-a 'No Key' "$(email l2-nokey)")
for key_case in none wrong; do
  key=''
  [ "$key_case" = wrong ] && key="wrong-$API_KEY"
  request_as "$key" POST /reset "$L2_RESET_BODY";   expect_status "L2: POST /reset ($key_case key) -> 401" 401
  request_as "$key" GET /slots;                     expect_status "L2: GET /slots ($key_case key) -> 401" 401
  request_as "$key" POST /bookings "$L2_BOOK_BODY"; expect_status "L2: POST /bookings ($key_case key) -> 401" 401
  request_as "$key" GET "/bookings?email=a@b.co";   expect_status "L2: GET /bookings ($key_case key) -> 401" 401
  request_as "$key" GET /bookings/anything;         expect_status "L2: GET /bookings/:id ($key_case key) -> 401" 401
  request_as "$key" DELETE /bookings/anything;      expect_status "L2: DELETE /bookings/:id ($key_case key) -> 401" 401
done
request_as '' GET /slots
expect_error "L2: 401 body is {\"error\": ...}" 401
request GET /slots
expect "L2: unauthenticated /reset did not wipe data" 200 '.slots | length == 3'
request_as '' GET /healthz
expect_status "L2: /healthz needs no key" 200

request POST /bookings "$(booking_body l2-a '' "$(email l2-emptyname)")"
expect_error "L2: empty name -> 400" 400
request POST /bookings "$(booking_body l2-a '    ' "$(email l2-spacename)")"
expect_error "L2: whitespace name -> 400" 400
request POST /bookings "$(jq -nc '{slot_id: "l2-a", name: "Ada Obi"}')"
expect_error "L2: missing email -> 400" 400
request POST /bookings "$(booking_body l2-a 'Ada Obi' notanemail)"
expect_error "L2: invalid email -> 400" 400
request POST /bookings "$(jq -nc --arg e "$(email l2-noslot)" '{name: "Ada Obi", email: $e}')"
expect_error "L2: missing slot_id -> 400" 400
request POST /bookings "$(jq -nc --arg e "$(email l2-numname)" '{slot_id: "l2-a", name: 123, email: $e}')"
expect_error "L2: non-string name -> 400" 400
request POST /bookings '{"slot_id": "l2-a", "name": '
expect_error "L2: malformed JSON -> 400" 400
request POST /bookings "$(booking_body nope 'Ada Obi' "$(email l2-unknown)")"
expect "L2: unknown slot -> 404" 404 '. == {"error": "slot not found"}'
request POST /bookings "$(booking_body l2-past 'Ada Obi' "$(email l2-past)")"
expect "L2: past slot -> 400" 400 '. == {"error": "slot has already started"}'

request GET /slots
expect "L2: rejected requests booked nothing" 200 'all(.slots[]; .available == true)'

L2_MIXED="L2-Norm-$RANDOM$RANDOM@Example.COM"
L2_LOWER=$(tr '[:upper:]' '[:lower:]' <<<"$L2_MIXED")
request POST /bookings "$(booking_body l2-b '  Ada Obi  ' "  $L2_MIXED ")"
expect "L2: email lowercased+trimmed, name trimmed" 201 '.email == "'"$L2_LOWER"'" and .name == "Ada Obi"'

[ "$MAX_LEVEL" -ge 3 ] || finish

# ---------------------------------------------------------------- Level 3
echo "== Level 3: no double-booking, cancellation"
reset_with L3 "$(slots_fixture \
  "$(slot_json l3-race 'Dr Ade' "${FUTURE_DAY}T09:00:00Z" "${FUTURE_DAY}T09:30:00Z")")"

fire_concurrent 20 race '' l3-race
L3_CREATED=0
L3_CONFLICT=0
L3_WINNER=''
for i in $(seq 1 20); do
  case $(cat "$TMP/race_$i.code") in
    201) L3_CREATED=$((L3_CREATED + 1)); L3_WINNER=$(jq -r .id "$TMP/race_$i.body") ;;
    409) L3_CONFLICT=$((L3_CONFLICT + 1)) ;;
  esac
done
if [ "$L3_CREATED" -eq 1 ] && [ "$L3_CONFLICT" -eq 19 ]; then
  pass "L3: 20 concurrent bookings -> one 201, nineteen 409"
else
  fail "L3: 20 concurrent bookings -> one 201, nineteen 409" "got $L3_CREATED x 201, $L3_CONFLICT x 409"
fi
if jq -e '. == {"error": "slot already booked"}' "$TMP/race_$( for i in $(seq 1 20); do [ "$(cat "$TMP/race_$i.code")" = 409 ] && echo "$i" && break; done ).body" >/dev/null 2>&1; then
  pass "L3: 409 body is {\"error\": \"slot already booked\"}"
else
  fail "L3: 409 body is {\"error\": \"slot already booked\"}" "unexpected 409 body"
fi

request GET /slots
expect "L3: raced slot unavailable" 200 '.slots[0].available == false'

request DELETE "/bookings/$L3_WINNER"
expect "L3: cancel winner -> 200 cancelled" 200 '.status == "cancelled" and .id == "'"$L3_WINNER"'"'
request GET "/bookings/$L3_WINNER"
expect "L3: cancelled booking still readable" 200 '.status == "cancelled"'
request GET /slots
expect "L3: slot available again after cancel" 200 '.slots[0].available == true'

request POST /bookings "$(booking_body l3-race 'Second Try' "$(email l3-rebook)")"
expect "L3: rebook cancelled slot -> 201" 201 '.status == "confirmed" and .slot_id == "l3-race"'

request DELETE "/bookings/$L3_WINNER"
expect "L3: cancel already-cancelled -> 409" 409 '. == {"error": "booking already cancelled"}'
request DELETE /bookings/does-not-exist
expect "L3: cancel unknown -> 404" 404 '. == {"error": "booking not found"}'

[ "$MAX_LEVEL" -ge 4 ] || finish

# ---------------------------------------------------------------- Level 4
echo "== Level 4: idempotency, pagination"
L4_SLOTS=()
for i in 1 2 3 4 5 6 7 8; do
  L4_SLOTS+=("$(slot_json "l4-s$i" 'Dr Ade' "${FUTURE_DAY}T1$i:00:00Z" "${FUTURE_DAY}T1$i:30:00Z")")
done
reset_with L4 "$(slots_fixture "${L4_SLOTS[@]}")"

L4_KEY="key-$RANDOM$RANDOM"
L4_EMAIL=$(email l4-idem)
L4_BODY=$(booking_body l4-s1 'Ada Obi' "$L4_EMAIL")
request POST /bookings "$L4_BODY" -H "Idempotency-Key: $L4_KEY"
L4_FIRST_STATUS=$STATUS
L4_FIRST_ID=$(field .id)
request POST /bookings "$L4_BODY" -H "Idempotency-Key: $L4_KEY"
if [ "$L4_FIRST_STATUS" = 201 ] && [ "$STATUS" = 201 ] && [ "$(field .id)" = "$L4_FIRST_ID" ]; then
  pass "L4: same key + same body -> same 201, same id"
else
  fail "L4: same key + same body -> same 201, same id" "first $L4_FIRST_STATUS/$L4_FIRST_ID, second $STATUS/$(field .id)"
fi
request GET "/bookings?email=$L4_EMAIL"
expect "L4: retried request created one booking" 200 '.bookings | length == 1'

request POST /bookings "$(booking_body l4-s2 'Someone Else' "$(email l4-idem-diff)")" -H "Idempotency-Key: $L4_KEY"
expect "L4: same key + different body -> 422" 422 '. == {"error": "idempotency key reused with a different body"}'

L4_CKEY="ckey-$RANDOM$RANDOM"
L4_CEMAIL=$(email l4-concurrent)
fire_concurrent 5 idem "$L4_CKEY" "$(booking_body l4-s2 'Ada Obi' "$L4_CEMAIL")"
L4_SIGS=$(for i in 1 2 3 4 5; do echo "$(cat "$TMP/idem_$i.code") $(jq -c . "$TMP/idem_$i.body" 2>/dev/null)"; done | sort -u)
if [ "$(wc -l <<<"$L4_SIGS" | tr -d ' ')" = 1 ] && [ "${L4_SIGS%% *}" = 201 ]; then
  pass "L4: same key fired 5x concurrently -> identical 201 responses"
else
  fail "L4: same key fired 5x concurrently -> identical 201 responses" "$(tr '\n' ';' <<<"$L4_SIGS")"
fi
request GET "/bookings?email=$L4_CEMAIL"
expect "L4: concurrent retries created one booking" 200 '.bookings | length == 1'

# Exactly 5 bookings for one email: a 6th attempt would trip the Level 5 limit.
L4_PEMAIL=$(email l4-page)
L4_EXPECTED_IDS=''
for i in 3 4 5 6 7; do
  request POST /bookings "$(booking_body "l4-s$i" 'Page Turner' "$L4_PEMAIL")"
  L4_EXPECTED_IDS="$L4_EXPECTED_IDS$(field .id) "
done
L4_GOT_IDS=''
L4_SIZES=''
L4_CURSOR=''
L4_LAST_CURSOR='unset'
for page in 1 2 3 4; do
  path="/bookings?email=$L4_PEMAIL&limit=2"
  [ -n "$L4_CURSOR" ] && path="$path&cursor=$L4_CURSOR"
  request GET "$path"
  [ "$STATUS" = 200 ] || break
  L4_SIZES="$L4_SIZES$(field '.bookings | length') "
  L4_GOT_IDS="$L4_GOT_IDS$(field '.bookings[].id' | tr '\n' ' ')"
  L4_CURSOR=$(field '.next_cursor // empty')
  L4_LAST_CURSOR=$(field '.next_cursor')
  [ -n "$L4_CURSOR" ] || break
done
if [ "$L4_SIZES" = "2 2 1 " ] && [ "$L4_LAST_CURSOR" = null ]; then
  pass "L4: limit=2 pages are 2/2/1, last next_cursor null"
else
  fail "L4: limit=2 pages are 2/2/1, last next_cursor null" "sizes '$L4_SIZES', last cursor $L4_LAST_CURSOR (status $STATUS: $BODY)"
fi
if [ "$L4_GOT_IDS" = "$L4_EXPECTED_IDS" ]; then
  pass "L4: pages oldest first, no duplicates or gaps"
else
  fail "L4: pages oldest first, no duplicates or gaps" "expected '$L4_EXPECTED_IDS' got '$L4_GOT_IDS'"
fi

request GET "/bookings?email=$(tr '[:lower:]' '[:upper:]' <<<"$L4_PEMAIL")"
expect "L4: email lookup ignores case (default limit)" 200 '(.bookings | length) == 5 and .next_cursor == null'

request DELETE "/bookings/${L4_EXPECTED_IDS%% *}"
request GET "/bookings?email=$L4_PEMAIL"
expect "L4: list includes cancelled bookings" 200 '(.bookings | length) == 5 and .bookings[0].status == "cancelled"'

for bad in 0 51 abc 1.5 -1; do
  request GET "/bookings?email=$L4_PEMAIL&limit=$bad"
  expect "L4: limit=$bad -> 400" 400 '. == {"error": "invalid limit"}'
done
request GET "/bookings?email=$L4_PEMAIL&cursor=@@garbage@@"
expect "L4: garbage cursor -> 400" 400 '. == {"error": "invalid cursor"}'
request GET "/bookings?email=$L4_PEMAIL&cursor=aGVsbG8"
expect "L4: well-formed base64 but bad cursor -> 400" 400 '. == {"error": "invalid cursor"}'
request GET /bookings
expect_error "L4: missing email -> 400" 400
request GET "/bookings?email="
expect_error "L4: empty email -> 400" 400

[ "$MAX_LEVEL" -ge 5 ] || finish

# ---------------------------------------------------------------- Level 5
echo "== Level 5: rate limit"
reset_with L5 "$(slots_fixture \
  "$(slot_json l5-a 'Dr Ade' "${FUTURE_DAY}T09:00:00Z" "${FUTURE_DAY}T09:30:00Z")")"

L5_EMAIL=$(email l5-limited)
L5_404S=0
for i in 1 2 3 4 5; do
  request POST /bookings "$(booking_body "l5-missing-$i" 'Ada Obi' "$L5_EMAIL")"
  [ "$STATUS" = 404 ] && L5_404S=$((L5_404S + 1))
done
if [ "$L5_404S" = 5 ]; then pass "L5: first 5 attempts processed (404s)"; else fail "L5: first 5 attempts processed (404s)" "only $L5_404S were 404"; fi

request POST /bookings "$(booking_body l5-a 'Ada Obi' "$L5_EMAIL")"
expect "L5: 6th attempt in a minute -> 429" 429 '. == {"error": "too many booking attempts"}'
L5_RETRY=$(header Retry-After)
if [[ "$L5_RETRY" =~ ^[0-9]+$ ]] && [ "$L5_RETRY" -ge 1 ]; then
  pass "L5: Retry-After is an integer >= 1 ($L5_RETRY)"
else
  fail "L5: Retry-After is an integer >= 1" "got '$L5_RETRY'"
fi

request POST /bookings "$(booking_body l5-a 'Other Person' "$(email l5-other)")"
expect "L5: a different email still books -> 201" 201 '.status == "confirmed"'

finish
