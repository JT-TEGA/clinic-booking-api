const express = require('express');
const { withClient } = require('../db');

const router = express.Router();

function isValidSlot(s) {
  return (
    s && typeof s === 'object' &&
    typeof s.id === 'string' && s.id !== '' &&
    typeof s.provider === 'string' &&
    typeof s.start === 'string' && !Number.isNaN(Date.parse(s.start)) &&
    typeof s.end === 'string' && !Number.isNaN(Date.parse(s.end))
  );
}

router.post('/reset', async (req, res, next) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });
  if (!slots.every(isValidSlot)) return res.status(400).json({ error: 'invalid slot' });
  if (new Set(slots.map((s) => s.id)).size !== slots.length) {
    return res.status(400).json({ error: 'duplicate slot id' });
  }

  try {
    await withClient(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM bookings');
        await client.query('DELETE FROM slots');
        await client.query('DELETE FROM idempotency_keys');
        await client.query('DELETE FROM rate_limit_attempts');
        // start_raw/end_raw keep the exact strings so GET /slots echoes them unchanged.
        await client.query(
          `INSERT INTO slots (id, provider, starts_at, ends_at, start_raw, end_raw)
           SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[])`,
          [
            slots.map((s) => s.id),
            slots.map((s) => s.provider),
            slots.map((s) => new Date(s.start).toISOString()),
            slots.map((s) => new Date(s.end).toISOString()),
            slots.map((s) => s.start),
            slots.map((s) => s.end),
          ]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
