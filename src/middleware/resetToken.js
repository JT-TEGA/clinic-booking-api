const crypto = require('crypto');

// POST /reset wipes every booking, so it needs more than X-API-Key, which the public page
// ships to every browser via /config.js. It takes a separate secret in X-Reset-Token.
// With RESET_TOKEN unset the route answers exactly like a route that doesn't exist.
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function resetToken(req, res, next) {
  const expected = process.env.RESET_TOKEN;
  if (!expected) return res.status(404).json({ error: 'not found' });
  const sent = req.get('X-Reset-Token');
  // Hashing first gives equal-length buffers, so the comparison is constant-time.
  if (!sent || !crypto.timingSafeEqual(sha256(sent), sha256(expected))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = { resetToken };
