const crypto = require('crypto');

// Key order is fixed so the same normalised request always hashes the same.
function bookingHash({ slot_id, name, email }) {
  return crypto.createHash('sha256').update(JSON.stringify({ slot_id, name, email })).digest('hex');
}

module.exports = { bookingHash };
