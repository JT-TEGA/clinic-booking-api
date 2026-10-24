# PRD — Ìlera Clinic Booking (Koya Cohort 4, Task 1)

> Master document for Claude Code. Self-contained: everything needed to build, test and ship is here.
> Build in the phases in section 9. **Do one phase per session, run its check, commit, then stop.**
> Supersedes `BUILD_PROMPT.md`. `SPEC.md` may also be in the repo; this file agrees with it.

---

## 1. What we are building

A clinic needs:
1. An **API** that lets patients list appointment slots, book one, look up and cancel bookings.
2. A **web page** that uses the API: see available slots, book one, see the confirmation, and manage your bookings.

Both are deployed at a public HTTPS URL. Koya runs an automated grading script against the API using our API key, checking exact status codes level by level. **API correctness is the grade. The page is the demo.**

Fictional brand used on the page: **Ìlera Clinic** ("ìlera" is Yoruba for health), Lekki, Lagos. Demo doctors: Tega Ukpe (General Practice), James Hope (Paediatrics), Adrian alas (Dermatology). The API itself stores only a `provider` string — titles/specialties live in the frontend only.

### Levels (all five are in scope)
| Level | Requirement |
|---|---|
| 1 | List slots, book one, look up a booking |
| 2 | API key required on every request; bad booking input rejected |
| 3 | No double-booking, even for simultaneous requests; bookings can be cancelled |
| 4 | Retried requests never create duplicates (Idempotency-Key); paginate a person's bookings |
| 5 | Rate limit: max 5 booking attempts per email per minute |

### Non-goals
User accounts, login, admin panel, email sending, payments, editing bookings. Do not build these.

---

## 2. Stack (fixed — do not substitute)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20 | Long-running process, simple deploy |
| Server | Express 4 | Minimal, well known |
| DB | Postgres via `pg`, raw SQL, no ORM | Partial unique index solves Level 3 outright |
| DB host | Neon (Frankfurt) | Free, doesn't sleep |
| App host | Render Web Service, free, Frankfurt | Long-running Node, HTTPS included |
| Frontend | Plain HTML + CSS + vanilla JS in `public/`, served by the same Express app | Same origin = zero CORS work |
| Fonts | Google Fonts | |
| Local env | `dotenv` | |

Only runtime dependencies: `express`, `pg`, `dotenv`. Nothing else unless a phase says so.

---

## 3. Repo layout

```
server.js                 boot: env, migrate, static, routes, error handlers, listen
src/db.js                 pg Pool (+ SSL for Neon), query helper, withTransaction helper
src/schema.sql            idempotent DDL
src/migrate.js            runs schema.sql at boot
src/middleware/apiKey.js
src/lib/validate.js       normalise + validate booking input
src/lib/hash.js           canonical body hash
src/lib/serialize.js      row -> Booking JSON, row -> Slot JSON
src/routes/reset.js
src/routes/slots.js
src/routes/bookings.js
public/index.html
public/theme.css          ALL design tokens (colours, fonts, radii, shadows) — the only file the Pinterest theme touches
public/style.css          layout + components, uses only tokens from theme.css
public/app.js
scripts/seed.js           fills a deployment with realistic future slots via POST /reset
test/check.sh             level-by-level verification with curl + jq
.env.example
.gitignore                node_modules, .env
package.json              "start": "node server.js", "seed": "node scripts/seed.js", engines node >=20
README.md
```

---

## 4. API contract (exact — the grader checks this)

### Global rules
- JSON in, JSON out.
- **Every** API route requires header `X-API-Key` equal to env `API_KEY`. Missing/wrong → `401`.
- Exempt from the key check: `OPTIONS` requests, `GET /healthz`, and static frontend files (`/`, `/index.html`, `/app.js`, `/style.css`, `/theme.css`, `/config.js`). Mount `express.static` and `/config.js` **before** the key middleware.
- Every error body is exactly `{"error": "<message>"}`.
- Malformed JSON body → `400`.
- Unexpected errors → `500 {"error":"internal error"}`, stack logged.

### Schema (`src/schema.sql`, all `IF NOT EXISTS`)
```sql
CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  provider   TEXT        NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  start_raw  TEXT        NOT NULL,
  end_raw    TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id         TEXT PRIMARY KEY,
  slot_id    TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  email      TEXT        NOT NULL,
  status     TEXT        NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- LEVEL 3: the whole double-booking guarantee. Never SELECT-then-INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_page ON bookings (email, created_at, id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  body_hash     TEXT        NOT NULL,
  status_code   INT         NOT NULL,
  response_body JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  email        TEXT        NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS rl_lookup ON rate_limit_attempts (email, attempted_at);
```
- Never name a column `start` or `end`.
- `created_at` uses `clock_timestamp()` (not `now()`), so bookings created in one transaction batch still get distinct, ordered times.
- `gen_random_uuid()` is built in on Postgres 13+ (Neon is fine).
- `available` is **computed**, never stored.

### Shapes
```jsonc
// Slot as returned by GET /slots
{"id":"s1","provider":"Tega Ukpe","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z","available":true}
// Booking
{"id":"<uuid>","slot_id":"s1","name":"Ada Obi","email":"ada@example.com","status":"confirmed","created_at":"2026-10-23T00:07:43.429Z"}
// Error
{"error":"slot not found"}
```
`start`/`end` echo the raw strings sent to `/reset`. `created_at` is `new Date(row.created_at).toISOString()`.

### Endpoints

**`POST /reset`** — Level 1
Body `{"slots":[{id,provider,start,end},...]}`. One transaction: delete all bookings, slots, idempotency_keys, rate_limit_attempts; insert every slot (past slots allowed). → `200 {"ok":true}`. Missing/non-array `slots` → `400`.

**`GET /slots`** — Level 1
Optional `?provider=` exact, case-sensitive.
```sql
SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
       NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
FROM slots s
WHERE ($1::text IS NULL OR s.provider = $1)
ORDER BY s.starts_at ASC, s.id ASC;
```
Returns all slots incl. past and booked. → `200 {"slots":[...]}`.

**`POST /bookings`** — Levels 1–5. See section 5; this is the critical path.

**`GET /bookings`** — Level 4
- `email` required (missing/empty → `400`), lowercased + trimmed before matching.
- `limit`: default 10; must be an integer string 1–50 (`/^\d+$/` then range). `0`, `51`, `abc`, `1.5`, `-1` → `400 {"error":"invalid limit"}`.
- `cursor`: optional; `base64url("<created_at ISO>|<id>")`. Undecodable/malformed → `400 {"error":"invalid cursor"}`.
- Includes cancelled bookings. Oldest first.
```sql
SELECT * FROM bookings
WHERE email = $1
  AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
ORDER BY created_at ASC, id ASC
LIMIT $4;   -- pass limit + 1
```
If `limit + 1` rows came back: drop the extra, `next_cursor` = cursor of the last returned row; else `next_cursor: null`.
→ `200 {"bookings":[...], "next_cursor": string|null}`.

**`GET /bookings/:id`** — Level 1 → `200` Booking | `404 {"error":"booking not found"}`.

**`DELETE /bookings/:id`** — Level 3
`UPDATE bookings SET status='cancelled' WHERE id=$1 AND status='confirmed' RETURNING *`.
Row → `200` Booking. No row → `SELECT` by id: missing → `404`; exists → `409 {"error":"booking already cancelled"}`.

**`GET /healthz`** — no auth → `200 {"ok":true}`. Keep-alive target.

**`GET /config.js`** — no auth → `window.API_KEY=<JSON-encoded env API_KEY>;` with content type `application/javascript`.

---

## 5. POST /bookings — exact algorithm

Whole request in **one transaction** on one client. Expected outcomes (400/404/409/422/429) **COMMIT** — the rate-limit attempt and idempotency record must persist. Only unexpected errors `ROLLBACK`.

1. `BEGIN`.
2. **Normalise.** Non-string → `""`. `slot_id = trim`, `name = trim`, `email = trim().toLowerCase()`.
3. **Idempotency** (only if header `Idempotency-Key` present and non-empty). `hash = sha256(JSON.stringify({slot_id, name, email}))` on normalised values, keys in that order.
   ```sql
   INSERT INTO idempotency_keys (key, body_hash, status_code, response_body)
   VALUES ($1, $2, 0, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key;
   ```
   - Row returned → `reserved = true`, continue.
   - No row → `SELECT body_hash, status_code, response_body FROM idempotency_keys WHERE key=$1 FOR UPDATE` (blocks until any in-flight holder commits).
     - `body_hash` differs → finish `422 {"error":"idempotency key reused with a different body"}`.
     - Same hash, `status_code <> 0` → COMMIT and replay stored status + stored body verbatim. Done.
4. **Rate limit** (only if `email` non-empty and matches the email regex):
   ```sql
   SELECT count(*)::int AS n, min(attempted_at) AS oldest
   FROM rate_limit_attempts
   WHERE email=$1 AND attempted_at > clock_timestamp() - interval '60 seconds';
   ```
   `n >= 5` → header `Retry-After: max(1, ceil((oldest + 60s − now) in seconds))`, finish `429 {"error":"too many booking attempts"}`. Do **not** record this attempt.
   Else `INSERT INTO rate_limit_attempts (email) VALUES ($1)`.
   To stop two simultaneous requests for one email both reading `n = 4`, take `SELECT pg_advisory_xact_lock(hashtext($1))` on the email before counting.
5. **Validate.** Any of `slot_id`, `name`, `email` empty, or email fails `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` → `400`.
6. **Slot exists?** `SELECT * FROM slots WHERE id=$1` → none → `404 {"error":"slot not found"}`.
7. **Started?** `starts_at <= now()` → `400 {"error":"slot has already started"}`.
8. **Insert** with a savepoint so a unique violation doesn't abort the transaction:
   ```sql
   SAVEPOINT ins;
   INSERT INTO bookings (id, slot_id, name, email, status)
   VALUES (gen_random_uuid()::text, $1, $2, $3, 'confirmed') RETURNING *;
   ```
   Error code `23505` → `ROLLBACK TO SAVEPOINT ins`, finish `409 {"error":"slot already booked"}`.
9. Finish `201` with the Booking.

**`finish(status, body, headers)`**, before COMMIT:
- Key sent and status ∈ {201, 400, 404, 409} → `UPDATE idempotency_keys SET body_hash=$2, status_code=$3, response_body=$4 WHERE key=$1`.
- Key sent, `reserved`, status ∈ {422, 429} → `DELETE FROM idempotency_keys WHERE key=$1` (an unfinished `status_code=0` row would wedge the key forever).
- `COMMIT`, send.

Housekeeping each call (outside the main logic is fine): `DELETE FROM rate_limit_attempts WHERE attempted_at < now() - interval '5 minutes'`.

Why this order: rate limit sits **above** validation because "failed attempts included" means a 400/404/409 still uses up an attempt. Idempotency sits **above** the rate limit so a legitimate retry isn't punished.

### Status code map
| Code | When |
|---|---|
| 200 | GET /slots, GET /bookings, GET /bookings/:id, DELETE /bookings/:id, POST /reset |
| 201 | Booking created |
| 400 | Bad/missing/empty field, bad email, slot already started, invalid limit/cursor, bad JSON |
| 401 | Missing/wrong X-API-Key |
| 404 | Slot not found (POST), booking not found (GET/DELETE) |
| 409 | Slot already booked; booking already cancelled |
| 422 | Idempotency-Key reused with different body |
| 429 | 6th+ attempt per email per minute, with Retry-After |

---

## 6. `src/db.js` details

```js
const needsSsl = /neon\.tech|render\.com|amazonaws\.com/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});
```
Export `query(text, params)` and `withClient(fn)` (gets a client, always releases it).
Server must `listen(process.env.PORT || 3000, '0.0.0.0')`.

---

## 7. Web page

### 7.1 Experience
One page (`index.html`), two tabs in the header: **Book** and **My bookings**. The Book tab is a 3-step flow with a visible stepper ("1 Choose · 2 Details · 3 Confirmed").

**Step 1 — Choose a time**
- Fetch `GET /slots` on load. Skeleton cards while loading.
- Show only **future** slots (filter client-side on `start > now`); past slots are never shown to patients.
- Each slot is a card: doctor name, specialty (looked up in a small map in `app.js`; unknown provider → no specialty line), day + date ("Thu, 10 Dec"), time range ("9:00 – 9:30 AM") in the viewer's local timezone via `Intl.DateTimeFormat`.
- `available:false` → card shown muted with a "Booked" tag, not clickable.
- Click an available card → selected state → "Continue" button enabled → step 2.
- Empty state: "No open appointments right now. Check back soon." with a Refresh button.
- Fetch error → inline error banner with Retry.

**Step 2 — Your details**
- Summary of the chosen slot at the top with a "Change" link back to step 1.
- Fields: Full name, Email. Labels above inputs, not placeholders as labels.
- Client-side checks mirror the server (non-empty after trim, email regex) with inline field errors. The server is still the source of truth.
- Submit button "Confirm booking" → loading state, disabled while in flight.
- Generate `Idempotency-Key = crypto.randomUUID()` when the user reaches step 2. Reuse it if the request fails due to a **network error** (offer "Try again"); generate a new one when the user changes slot or details.
- Server responses:
  - `201` → step 3.
  - `409` → "Someone just booked this slot. Please pick another time." → back to step 1, slots refreshed.
  - `404` → "That slot no longer exists." → back to step 1, refreshed.
  - `400` → show the server's `error` message.
  - `429` → "Too many attempts. Try again in N seconds." with a live countdown from `Retry-After`; button disabled until it hits 0.
  - Anything else → generic "Something went wrong. Please try again."

**Step 3 — Confirmed**
- Large success mark, "You're booked, {first name}."
- Details card: doctor, specialty, date, time, email, status pill, booking reference (the id, shortened to the first 8 chars with a Copy button that copies the full id).
- Buttons: "Book another appointment" (reset flow) and "View my bookings" (switch tab, pre-filled with this email, auto-search).

**My bookings tab**
- Email input + "Find bookings". Remember the last email in `localStorage` (wrapped in try/catch).
- `GET /bookings?email=…&limit=5`. List oldest first, matching the API.
- Each row: doctor, date/time (join with the slots list by `slot_id`; if the slot isn't found, show the slot id), status pill (Confirmed / Cancelled), Cancel button on confirmed ones.
- Cancel → inline confirm inside the row ("Cancel this appointment? Yes / Keep it"). **Never use `window.confirm`/`alert`.** On `200` the pill flips to Cancelled and the slot list refreshes.
- "Load more" button while `next_cursor` is non-null; appends the next page.
- Empty state: "No bookings for this email yet."

### 7.2 Technical rules
- `public/index.html` loads `/config.js` then `/app.js`. All fetches go through one helper `api(method, path, body, extraHeaders)` that adds `X-API-Key: window.API_KEY` and `Content-Type`, parses JSON, and returns `{status, data, headers}`.
- No frameworks, no build step. Vanilla JS, ES modules not required.
- Mobile first. Works at 360px wide with 16px side padding; no horizontal scroll. Desktop max content width ~720px for the flow.
- Accessibility: real `<button>`s, `<label for>`, visible focus rings, `aria-live="polite"` region for errors and confirmations, colour is never the only signal (status pills include text), touch targets ≥ 44px.
- Respect `prefers-reduced-motion` (disable transitions).
- Dark mode via `@media (prefers-color-scheme: dark)` in `theme.css`.

### 7.3 Visual design
**All colours, fonts, radii, shadows and spacing live as CSS custom properties in `public/theme.css`.** `style.css` uses only `var(--…)`. Swapping the theme = editing one file.

> **Theme source: Pinterest board from Tega — pending.** Until it arrives, use the default below. When it arrives, only `theme.css` and the font `<link>` in `index.html` change.

Default direction — calm, warm, editorial clinic:
```css
:root {
  --bg: #F7F4EE;          /* warm paper */
  --surface: #FFFFFF;
  --surface-muted: #EFEBE3;
  --text: #1F2421;
  --text-muted: #5E6660;
  --brand: #2F5D50;       /* deep sage */
  --brand-contrast: #FFFFFF;
  --accent: #C9826B;      /* terracotta, used sparingly */
  --success: #2F7D57;
  --danger: #B3412F;
  --border: #E2DDD3;
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "Inter", system-ui, sans-serif;
  --radius-sm: 10px; --radius-md: 16px; --radius-lg: 24px;
  --shadow-card: 0 1px 2px rgba(31,36,33,.06), 0 8px 24px rgba(31,36,33,.06);
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141816; --surface: #1C211F; --surface-muted: #232926;
    --text: #EDEAE4; --text-muted: #A6ADA8; --brand: #7FB3A2; --brand-contrast: #0F1412;
    --accent: #E0A08A; --border: #2E3532;
  }
}
```
Layout feel: generous whitespace, large serif headline in the hero ("Book a visit at Ìlera Clinic"), cards with soft shadows and large radius, one primary colour for actions, small-caps or uppercase micro-labels for dates. No stock photos, no emoji, no gradients on text.

---

## 8. Tooling

### `scripts/seed.js`
Usage: `BASE_URL=… API_KEY=… npm run seed`. POSTs `/reset` with ~18 slots: the three demo doctors × the next 3 weekdays × two 30-minute slots in the morning (09:00, 09:30 Lagos time = 08:00, 08:30Z) — plus one slot that has already ended (yesterday) to prove past slots are hidden on the page. Generates ISO strings with `Z`. Prints how many slots were created.

### `test/check.sh`
Bash, needs only `curl` + `jq`. Env: `BASE_URL`, `API_KEY`, optional `MAX_LEVEL` (default 5) to stop after a level. Prints `PASS`/`FAIL <reason>` per assertion and a summary; exits non-zero on any failure. Each level section starts by calling `/reset` with its own fixture.
**Every assertion uses its own unique email** (e.g. `l2-emptyname-$RANDOM@test.com`) unless it is deliberately testing the rate limit — otherwise the 5-per-minute limit turns later 400s into 429s.

- **L1**: reset 3 future + 1 past slot → 200; `/slots` returns 4 in start order, all available; `?provider=` filter works; book → 201 `confirmed`; slot now `available:false`; `GET /bookings/{id}` → 200 same body; unknown id → 404.
- **L2**: every route with no key and with a wrong key → 401 (incl. `/reset`); empty name, whitespace name, missing email, `notanemail` → 400; unknown slot → 404; past slot → 400; `"  ADA@Example.COM "` is stored as `ada@example.com` with trimmed name.
- **L3**: 20 concurrent POSTs (`&` + `wait`, each a different email) at one slot → exactly one 201, nineteen 409; DELETE winner → 200 `cancelled`; slot available again; rebook it → 201; DELETE a cancelled booking → 409; DELETE unknown → 404.
- **L4**: same key + same body twice → same status, same id, only one booking for that email; same key + different body → 422; same key fired 5× concurrently → all identical, one booking; 5 bookings for one email (5 different slots — never more than 5, or the Level 5 limit kicks in) with `limit=2` → pages of 2/2/1 with last `next_cursor:null`, no duplicates, oldest first; email lookup ignores case; `limit=0|51|abc` → 400; garbage cursor → 400.
- **L5**: 5 attempts with one email (unknown slot → 404s) then a 6th valid one → 429 with integer `Retry-After` ≥ 1; a different email still → 201.

---

## 9. Build phases

Each phase ends with a check. Do not start the next until the check passes. Commit at the end of each phase with a clear message.

| Phase | Scope | Done when |
|---|---|---|
| 1. Foundation | package.json, server.js, db.js, schema + migrate, apiKey middleware, healthz, config.js, error handlers, .env.example, .gitignore | `npm start` boots on local Postgres; `/healthz` 200; `/slots` without key 401 |
| 2. Levels 1–3 | reset, slots, GET/DELETE booking, POST /bookings steps 1–2 and 5–9 (no idempotency, no rate limit yet), `test/check.sh` complete for all levels | `MAX_LEVEL=3 ./test/check.sh` all PASS |
| 3. Levels 4–5 | idempotency, rate limit, GET /bookings pagination | `./test/check.sh` all PASS, run twice in a row |
| 4. Web page | everything in section 7, default theme | Manual run-through below passes at 375px and 1280px |
| 5. Seed + README | scripts/seed.js, README | `npm run seed` fills the page |
| 6. Deploy | Neon + Render + keep-alive (Tega does this by hand) | live `check.sh` all PASS |
| 7. Theme | apply Pinterest theme to `theme.css` only | page matches the board, check.sh still PASS |

**Phase 4 manual run-through:** load page → see future slots only → pick one → submit empty → see field errors → submit valid → confirmation shows correct doctor/time → Book another → that slot shows Booked → My bookings with the same email in different case → booking listed → Cancel → Keep it → Cancel → Yes → pill flips → Book tab shows the slot open again. Open two tabs, book the same slot in both → second gets the friendly 409 and is sent back to step 1.

---

## 10. README.md (Phase 5)

Short: what it is; live URL placeholder; stack; a table of levels → how each is enforced (one line each); local setup; env vars; `npm run seed`; `./test/check.sh`; "Decisions & tradeoffs": partial unique index, rate limit above validation, idempotency reservation with `ON CONFLICT DO NOTHING` + `FOR UPDATE`, advisory lock for the per-email counter, raw timestamp echo, browser-visible API key (a real system would proxy through a session-authenticated backend).

---

## 11. Ground rules for Claude Code

- Follow section 4 and 5 literally. If something seems odd (e.g. past slots are `available:true`), keep it — the grader expects it.
- No extra dependencies, no TypeScript, no ORM, no frontend framework.
- Never commit `.env`. Before every commit run `git status` and confirm.
- Keep functions small; comment *why*, not *what*, on the non-obvious parts (index, check order, savepoint, advisory lock).
- At the end of each phase: report what was built, the check output, and anything you were unsure about.
