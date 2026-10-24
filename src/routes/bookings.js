const express = require('express');
const { connect, query } = require('../db');
const { normaliseBooking, isValidEmail, validateBooking } = require('../lib/validate');
const { bookingHash } = require('../lib/hash');
const { encodeCursor, decodeCursor } = require('../lib/cursor');
const serialize = require('../lib/serialize');
const { log, errorFields } = require('../lib/log');

const router = express.Router();

const UNIQUE_VIOLATION = '23505';
// Outcomes a retry with the same key must see again, verbatim.
const CACHEABLE_STATUSES = new Set([201, 400, 404, 409]);
// Outcomes that must free the key: leaving a status_code=0 reservation would wedge it forever.
const RELEASE_STATUSES = new Set([422, 429]);
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const CLEANUP_PROBABILITY = 0.05;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_RESERVE_TRIES = 3;

// Claims the key, or returns what an earlier request with the same key already decided.
// Returns { reserved } to continue, or { result } to stop with that response.
async function claimIdempotencyKey(client, key, hash) {
  for (let i = 0; i < MAX_RESERVE_TRIES; i++) {
    const ins = await client.query(
      `INSERT INTO idempotency_keys (key, body_hash, status_code, response_body)
       VALUES ($1, $2, 0, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, hash]
    );
    if (ins.rowCount > 0) return { reserved: true };

    // FOR UPDATE waits for an in-flight holder to commit, so we see its final answer.
    const { rows } = await client.query(
      'SELECT body_hash, status_code, response_body FROM idempotency_keys WHERE key = $1 FOR UPDATE',
      [key]
    );
    // The holder released the key (422/429) before we could read it: try to claim it again.
    if (rows.length === 0) continue;

    const stored = rows[0];
    if (stored.body_hash !== hash) {
      return { result: { status: 422, body: { error: 'idempotency key reused with a different body' } } };
    }
    // status_code 0 can't survive a commit, but if seen we hold its row lock, so it's ours to finish.
    if (stored.status_code === 0) return { reserved: true };
    return { result: { status: stored.status_code, body: replayBody(stored), replay: true } };
  }
  throw new Error(`could not claim idempotency key after ${MAX_RESERVE_TRIES} tries`);
}

// JSONB reorders object keys; rebuild bookings so a replay is byte-identical to the original.
function replayBody(stored) {
  return stored.status_code === 201 ? serialize.booking(stored.response_body) : stored.response_body;
}

// Returns a 429 result when the email is over the limit, otherwise records this attempt.
async function checkRateLimit(client, email) {
  // Serialises requests for one email so two can't both read n = 4 and slip through.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            ceil(extract(epoch FROM min(attempted_at) + make_interval(secs => $2) - clock_timestamp()))::int AS retry_after
     FROM rate_limit_attempts
     WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_LIMIT_WINDOW_SECONDS]
  );
  if (rows[0].n >= RATE_LIMIT_MAX) {
    return {
      status: 429,
      body: { error: 'too many booking attempts' },
      headers: { 'Retry-After': String(Math.max(1, rows[0].retry_after || 0)) },
    };
  }
  await client.query('INSERT INTO rate_limit_attempts (email) VALUES ($1)', [email]);
  return null;
}

async function insertBooking(client, input) {
  const error = validateBooking(input);
  if (error) return { status: 400, body: { error } };

  const slotRes = await client.query(
    'SELECT id, starts_at <= now() AS started FROM slots WHERE id = $1',
    [input.slot_id]
  );
  if (slotRes.rowCount === 0) return { status: 404, body: { error: 'slot not found' } };
  if (slotRes.rows[0].started) return { status: 400, body: { error: 'slot has already started' } };

  // The partial unique index decides races; the savepoint keeps the transaction usable
  // after a unique violation so finish() can still record the 409 and commit.
  await client.query('SAVEPOINT ins');
  try {
    const { rows } = await client.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'confirmed') RETURNING *`,
      [input.slot_id, input.name, input.email]
    );
    return { status: 201, body: serialize.booking(rows[0]) };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    await client.query('ROLLBACK TO SAVEPOINT ins');
    return { status: 409, body: { error: 'slot already booked' } };
  }
}

// Records the outcome against the idempotency key before the caller commits.
async function finish(client, idem, result) {
  if (!idem.key) return result;
  if (CACHEABLE_STATUSES.has(result.status)) {
    await client.query(
      `UPDATE idempotency_keys SET body_hash = $2, status_code = $3, response_body = $4 WHERE key = $1`,
      [idem.key, idem.hash, result.status, JSON.stringify(result.body)]
    );
  } else if (idem.reserved && RELEASE_STATUSES.has(result.status)) {
    await client.query('DELETE FROM idempotency_keys WHERE key = $1', [idem.key]);
  }
  return result;
}

// PRD section 5. Order matters: idempotency before the rate limit so honest retries aren't
// punished; rate limit before validation so failed attempts still count.
async function createBooking(client, input, key) {
  const idem = { key, hash: null, reserved: false };
  if (key) {
    idem.hash = bookingHash(input);
    const claim = await claimIdempotencyKey(client, key, idem.hash);
    if (claim.result) return claim.result.replay ? claim.result : finish(client, idem, claim.result);
    idem.reserved = claim.reserved;
  }

  if (input.email && isValidEmail(input.email)) {
    const limited = await checkRateLimit(client, input.email);
    if (limited) return finish(client, idem, limited);
  }

  return finish(client, idem, await insertBooking(client, input));
}

function pruneRateLimitAttempts() {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  query(`DELETE FROM rate_limit_attempts WHERE attempted_at < now() - interval '5 minutes'`)
    .catch((err) => log('error', 'rate limit cleanup failed', errorFields(err)));
}

router.post('/bookings', async (req, res, next) => {
  const input = normaliseBooking(req.body);
  const rawKey = req.get('Idempotency-Key');
  const key = rawKey && rawKey.trim() ? rawKey : null;
  pruneRateLimitAttempts();

  let client;
  try {
    client = await connect();
  } catch (err) {
    return next(err);
  }
  let broken = null;
  try {
    await client.query('BEGIN');
    let result;
    try {
      result = await createBooking(client, input, key);
      // Expected outcomes commit: the rate-limit attempt and idempotency record must persist.
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr) => { broken = rollbackErr; });
      throw err;
    }
    if (result.headers) res.set(result.headers);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  } finally {
    // A client whose ROLLBACK failed is in an unknown state; destroy it rather than reuse it.
    client.release(broken || undefined);
  }
});

function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? n : null;
}

router.get('/bookings', async (req, res, next) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'email is required' });

  const limit = parseLimit(req.query.limit);
  if (limit === null) return res.status(400).json({ error: 'invalid limit' });

  let cursor = null;
  if (req.query.cursor !== undefined) {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ error: 'invalid cursor' });
  }

  try {
    // cursor_ts keeps microseconds; see src/lib/cursor.js.
    const { rows } = await query(
      `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
       FROM bookings
       WHERE email = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
       ORDER BY created_at ASC, id ASC
       LIMIT $4`,
      [email, cursor && cursor.ts, cursor && cursor.id, limit + 1]
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit ? encodeCursor(last.cursor_ts, last.id) : null;
    res.json({ bookings: page.map(serialize.booking), next_cursor: nextCursor });
  } catch (err) {
    next(err);
  }
});

router.get('/bookings/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'booking not found' });
    res.json(serialize.booking(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.delete('/bookings/:id', async (req, res, next) => {
  try {
    // Conditional UPDATE makes cancel atomic; only on a miss do we look up why.
    const { rows } = await query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [req.params.id]
    );
    if (rows.length > 0) return res.json(serialize.booking(rows[0]));

    const existing = await query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'booking not found' });
    res.status(409).json({ error: 'booking already cancelled' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
