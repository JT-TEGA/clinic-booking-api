const express = require('express');
const { query, withClient } = require('../db');
const { normaliseBooking, validateBooking } = require('../lib/validate');
const serialize = require('../lib/serialize');

const router = express.Router();

const UNIQUE_VIOLATION = '23505';

// Runs the booking algorithm (PRD section 5) inside an open transaction.
// Returns { status, body, headers } instead of sending, so the caller commits first.
async function createBooking(client, input) {
  const error = validateBooking(input);
  if (error) return { status: 400, body: { error } };

  const slotRes = await client.query(
    'SELECT id, starts_at <= now() AS started FROM slots WHERE id = $1',
    [input.slot_id]
  );
  if (slotRes.rowCount === 0) return { status: 404, body: { error: 'slot not found' } };
  if (slotRes.rows[0].started) return { status: 400, body: { error: 'slot has already started' } };

  // The partial unique index decides races; the savepoint keeps the transaction usable
  // after a unique violation so expected outcomes can still commit.
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

router.post('/bookings', async (req, res, next) => {
  const input = normaliseBooking(req.body);
  try {
    const result = await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const out = await createBooking(client, input);
        // Expected outcomes commit too: later phases record rate-limit and idempotency state here.
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    if (result.headers) res.set(result.headers);
    res.status(result.status).json(result.body);
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
