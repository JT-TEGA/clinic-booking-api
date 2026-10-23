const express = require('express');
const { query } = require('../db');
const serialize = require('../lib/serialize');

const router = express.Router();

router.get('/slots', async (req, res, next) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  try {
    // available is computed from confirmed bookings, never stored, so it can't drift.
    const { rows } = await query(
      `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
       WHERE ($1::text IS NULL OR s.provider = $1)
       ORDER BY s.starts_at ASC, s.id ASC`,
      [provider]
    );
    res.json({ slots: rows.map(serialize.slot) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
