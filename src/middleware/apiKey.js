function apiKey(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const expected = process.env.API_KEY;
  if (!expected || req.get('X-API-Key') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = { apiKey };
