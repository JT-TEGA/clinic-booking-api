// Keyset cursor for GET /bookings: base64url("<created_at ISO>|<id>").
// The timestamp keeps Postgres' microseconds: a millisecond ISO string would sort
// before the row it came from and repeat that row on the next page.
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function encodeCursor(ts, id) {
  return Buffer.from(`${ts}|${id}`).toString('base64url');
}

// Returns { ts, id }, or null when the cursor isn't one we issued.
function decodeCursor(raw) {
  if (typeof raw !== 'string' || !BASE64URL_RE.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep < 0) return null;
  const ts = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!CURSOR_TS_RE.test(ts) || Number.isNaN(Date.parse(ts)) || !id) return null;
  return { ts, id };
}

module.exports = { encodeCursor, decodeCursor };
