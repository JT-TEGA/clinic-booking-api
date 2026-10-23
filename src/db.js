const { Pool } = require('pg');

// Hosted Postgres (Neon/Render/RDS) requires TLS; local Postgres usually doesn't speak it.
const needsSsl = /neon\.tech|render\.com|amazonaws\.com/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('pg pool error', err));

// A stuck query (e.g. waiting on a lock) should fail the request, not hold a pool slot forever.
// Set once per new connection and awaited, so it never races the caller's first query.
async function connect() {
  const client = await pool.connect();
  if (!client.statementTimeoutSet) {
    try {
      await client.query('SET statement_timeout = 10000');
    } catch (err) {
      client.release(err);
      throw err;
    }
    client.statementTimeoutSet = true;
  }
  return client;
}

async function query(text, params) {
  const client = await connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Hands fn a dedicated client so a whole request can run in one transaction.
async function withClient(fn) {
  const client = await connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, connect, query, withClient };
