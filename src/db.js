const { Pool } = require('pg');

// Hosted Postgres (Neon/Render/RDS) requires TLS; local Postgres usually doesn't speak it.
const needsSsl = /neon\.tech|render\.com|amazonaws\.com/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => console.error('pg pool error', err));

function query(text, params) {
  return pool.query(text, params);
}

// Hands fn a dedicated client so a whole request can run in one transaction.
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withClient };
