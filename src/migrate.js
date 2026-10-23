const fs = require('fs');
const path = require('path');
const { query } = require('./db');

// schema.sql is all IF NOT EXISTS, so running it on every boot is safe.
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
}

module.exports = { migrate };
