// Keeps the demo bookable: makes sure every doctor has slots for the next 14 days of clinic hours.
// Insert-only (never updates or deletes), so booked and hand-loaded slots are never touched.
const db = require('./db');
const { windowSlots } = require('./lib/schedule');
const { log, errorFields } = require('./lib/log');

// GET /slots tops up at most this often; startup always runs.
const REQUEST_INTERVAL_MS = 10 * 60 * 1000;

// Shared with POST /reset so a top-up can't land between a reset's DELETE and its COMMIT.
// Two-int key form: a separate key space from the per-email hashtext() locks in bookings.
const LOCK_SQL = 'SELECT pg_advisory_xact_lock(4242, 1)';

// ON CONFLICT (id) makes re-runs no-ops; the NOT EXISTS also skips a slot loaded under a
// different id for the same doctor and time. starts_at > now() is a second past-slot guard.
const INSERT_SQL = `
  INSERT INTO slots (id, provider, starts_at, ends_at, start_raw, end_raw)
  SELECT v.id, v.provider, v.starts_at, v.ends_at, v.start_raw, v.end_raw
  FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[])
    AS v(id, provider, starts_at, ends_at, start_raw, end_raw)
  WHERE v.starts_at > now()
    AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.provider = v.provider AND s.starts_at = v.starts_at)
  ON CONFLICT (id) DO NOTHING`;

function createSlotTopUp({ withClient = db.withClient, now = Date.now, minIntervalMs = REQUEST_INTERVAL_MS } = {}) {
  // Set by POST /reset: whoever called it wants exactly those slots, so stop adding more
  // until the next restart (on Render's free tier, the next wake from sleep).
  let paused = false;
  let lastAttemptAt = -Infinity;
  let inFlight = null;

  async function insertWindow() {
    const slots = windowSlots(now());
    if (slots.length === 0) return 0;
    return withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(LOCK_SQL);
        // Checked after taking the lock: a reset that started while we waited wins.
        if (paused) {
          await client.query('ROLLBACK');
          return 0;
        }
        const res = await client.query(INSERT_SQL, [
          slots.map((s) => s.id),
          slots.map((s) => s.provider),
          slots.map((s) => s.start),
          slots.map((s) => s.end),
          slots.map((s) => s.start),
          slots.map((s) => s.end),
        ]);
        await client.query('COMMIT');
        return res.rowCount;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  // Concurrent callers share one run.
  function run() {
    if (!inFlight) {
      lastAttemptAt = now();
      inFlight = insertWindow().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  // Startup: always runs. Resolves to the number of slots inserted; rejects on database errors.
  async function topUp() {
    const inserted = await run();
    log('info', 'slot top-up', { inserted });
    return inserted;
  }

  // Before GET /slots: throttled, and never throws, so a failed top-up can't fail the listing.
  async function maybeTopUp() {
    if (paused) return;
    if (!inFlight && now() - lastAttemptAt < minIntervalMs) return;
    try {
      const inserted = await run();
      if (inserted > 0) log('info', 'slot top-up', { inserted });
    } catch (err) {
      log('error', 'slot top-up failed', errorFields(err));
    }
  }

  function pause() {
    if (!paused) log('info', 'slot top-up paused until restart', { reason: 'reset' });
    paused = true;
  }

  // Call inside the reset transaction, after BEGIN.
  function lock(client) {
    return client.query(LOCK_SQL);
  }

  return { topUp, maybeTopUp, pause, lock };
}

module.exports = { createSlotTopUp, slotTopUp: createSlotTopUp() };
