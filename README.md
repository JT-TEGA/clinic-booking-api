# Ìlera Clinic Booking

[![CI](https://github.com/JT-TEGA/clinic-booking-api/actions/workflows/ci.yml/badge.svg)](https://github.com/JT-TEGA/clinic-booking-api/actions/workflows/ci.yml)

Appointment booking API with a booking page: list slots, book one, look it up, cancel it, without double-bookings or duplicate retries.

**Live:** https://clinic-booking-api-706o.onrender.com

## Stack

| Choice | Why |
|---|---|
| Node 20 + Express 4 | Small, well known, three runtime dependencies (`express`, `pg`, `dotenv`). |
| Postgres (Neon), raw SQL via `pg` | A partial unique index enforces "one confirmed booking per slot" inside the database, which makes Level 3 a constraint, not application logic. |
| Long-running process on Render | Each booking runs in one transaction on one connection, and the rate limit relies on per-email advisory locks. Both hold up best in a persistent process with a steady connection pool, not short-lived serverless invocations. |
| Static page served by the same app | Same origin, so there is no CORS layer to configure or get wrong. |

## Levels

| Level | Requirement | Enforced by |
|---|---|---|
| 1 | List slots, book, look up | `GET /slots` computes `available` from confirmed bookings at read time; nothing is stored that can drift. |
| 2 | API key; reject bad input | Middleware compares `X-API-Key` on every route except the page, `/healthz` and `/readyz`; input is trimmed, email lowercased, then validated. |
| 3 | No double-booking; cancel | `UNIQUE (slot_id) WHERE status = 'confirmed'`: concurrent inserts race in the index, one wins, the rest get `23505` → 409. Cancel is a conditional `UPDATE`. |
| 4 | Idempotent retries; paginate | `Idempotency-Key` reserved with `INSERT … ON CONFLICT DO NOTHING`, replayed via `SELECT … FOR UPDATE`. Keyset cursor on `(created_at, id)`. |
| 5 | 5 attempts / email / minute | Attempts table counted inside the booking transaction under `pg_advisory_xact_lock(hashtext(email))`; 429 with `Retry-After`. |

## Local setup

Requires Node 20+ and Postgres 13+ (for built-in `gen_random_uuid()`).

```bash
createdb ilera
cp .env.example .env    # then edit
npm install
npm start               # creates tables on boot, listens on PORT
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. SSL is enabled automatically for Neon/Render/AWS hosts. |
| `API_KEY` | Value every API request must send as `X-API-Key`. |
| `RESET_TOKEN` | Secret that `POST /reset` must also send as `X-Reset-Token`. Unset means `/reset` is disabled (404). Leave it unset in production. |
| `PORT` | Defaults to 3000. |

```bash
BASE_URL=http://localhost:3000 API_KEY=… RESET_TOKEN=… npm run seed       # small demo set (wipes bookings)
npm test                                                   # unit tests, no database
BASE_URL=http://localhost:3000 API_KEY=… RESET_TOKEN=… ./test/check.sh   # API suite, levels 1–5
```

`check.sh` works against any `BASE_URL` whose server has `RESET_TOKEN` set. It needs `curl` and `jq`, resets the data at the start of each level, and accepts `MAX_LEVEL=n` to stop early.

**Demo slots top themselves up.** On every boot, and at most every 10 minutes before `GET /slots`, the server makes sure each demo doctor has a 30-minute slot for every weekday, 09:00–17:00 Lagos time, over the next 14 days. It only inserts: it never changes or deletes a slot, so bookings are untouched, and it skips slots that have already started or that already exist for that doctor and time. Calling `/reset` (which `check.sh` and the seed both do) pauses the top-up until the next restart, so `GET /slots` returns exactly the slots that were loaded. On Render's free tier the next wake from sleep restores the demo; anywhere else, restart the server.

`GET /healthz` is liveness (the process is up, no database query). `GET /readyz` is readiness (`SELECT 1` succeeds). Each request logs one JSON line with a request id, also returned as `X-Request-Id`.

## Design decisions

- **Partial unique index, not check-then-insert.** Reading "is this slot free?" and then inserting leaves a gap where two requests both see free. The index makes the database reject the second insert atomically. A savepoint around the insert keeps the transaction usable after the violation, so the 409 can still be recorded and committed.
- **Rate limit before validation.** The limit counts *attempts*, failed ones included, so it runs before input validation. Otherwise a client could make unlimited 400/404/409 requests. Idempotency runs before the rate limit so a legitimate retry replays its answer without spending an attempt.
- **Idempotency reservation.** The first request inserts a placeholder row for its key (`ON CONFLICT DO NOTHING`). A concurrent retry finds the row and blocks on `SELECT … FOR UPDATE` until the first commits, then replays the stored status and body. Five simultaneous retries produce one booking and five identical responses. A different body under the same key gets 422.
- **Expected failures are cached too.** 400, 404 and 409 are stored alongside 201, so a retry sees the same answer as the original, not a fresh evaluation against data that has since changed. 422 and 429 delete the reservation instead, so the key isn't left stuck.
- **Advisory lock on the per-email count.** Two simultaneous requests could both count 4 recent attempts and both proceed. `pg_advisory_xact_lock(hashtext(email))` serialises requests for one email for the length of the transaction, so the count and the insert happen as one step.
- **Microsecond cursor with an id tiebreaker.** Postgres stores microseconds; JavaScript dates hold milliseconds. A cursor truncated to milliseconds sorts *before* the row it came from, so that row would appear again on the next page. The cursor carries the full `to_char(…'US')` timestamp, and comparing `(created_at, id)` as a pair keeps the order total even when timestamps tie.
- **Slot top-up is insert-only and locked against `/reset`.** Slot ids are deterministic (`james-2026-12-01-0900`), so `INSERT … ON CONFLICT DO NOTHING` makes repeat runs no-ops. The top-up and `/reset` share an advisory lock, and the top-up checks the pause flag only after taking it, so a run that is already in progress can't add slots after a reset has deleted them.
- **Raw timestamp echo.** `start`/`end` are returned exactly as sent to `/reset` (stored as text beside the parsed `timestamptz` used for ordering and the started check), so clients get back the strings they sent.

## Deliberate constraints

- **Rate limiting is per email only.** The spec defines the limit per email and requires other emails to be unaffected. A per-IP limit would reject a legitimate test suite that books with many emails from one address, so there isn't one. In production it would be a second layer, behind a config flag.
- **`/slots` returns every slot.** The spec requires the full list, including past and booked slots. Pagination would break that contract; at real scale it would be an opt-in query parameter.
- **`/reset` has its own secret.** It wipes every booking, and the API key is public (see below), so it also requires `X-Reset-Token`. With `RESET_TOKEN` unset it returns 404, the same as a route that doesn't exist.
- **The API key is visible in the page's JavaScript.** The page calls the API directly, so it needs the key. A production build would give the page a short-lived signed session cookie and keep `X-API-Key` for machine clients. That wasn't done here because the spec requires every route to return 401 without a key, and a second authentication path needs more review than this scope allowed.

## Next steps

- Metrics and distributed tracing. Structured request logs with request ids are in place; aggregation and dashboards are not.
- Input length caps on name, email and slot id.
- Abuse prevention at the IP layer (see above), most likely at the edge rather than in the app.
