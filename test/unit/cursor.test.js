const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeCursor, decodeCursor } = require('../../src/lib/cursor');

const ID = '3f0c6c1e-8a51-4c9b-9a3e-2b8f4c1d7e90';
const b64 = (text) => Buffer.from(text).toString('base64url');

test('encodeCursor produces base64url of "<ts>|<id>"', () => {
  const cursor = encodeCursor('2026-10-23T08:00:00.123456Z', ID);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(cursor, 'base64url').toString('utf8'), `2026-10-23T08:00:00.123456Z|${ID}`);
});

test('encode then decode round-trips exactly', () => {
  const ts = '2026-10-23T08:00:00.500000Z';
  assert.deepEqual(decodeCursor(encodeCursor(ts, ID)), { ts, id: ID });
});

test('round-trip keeps full microsecond precision', () => {
  // Two bookings 1µs apart: truncating to milliseconds would make the cursor sort
  // before the row it came from, and that row would repeat on the next page.
  const ts = '2026-10-23T08:00:00.123457Z';
  const decoded = decodeCursor(encodeCursor(ts, ID));
  assert.equal(decoded.ts, ts);
  assert.equal(decoded.ts.split('.')[1], '123457Z');
  assert.notEqual(decoded.ts, new Date(ts).toISOString(), 'must not be the millisecond JS form');
});

test('ids containing a pipe survive the round-trip', () => {
  const ts = '2026-10-23T08:00:00.000001Z';
  assert.deepEqual(decodeCursor(encodeCursor(ts, 'a|b')), { ts, id: 'a|b' });
});

test('timestamps without a fractional part are accepted', () => {
  const ts = '2026-10-23T08:00:00Z';
  assert.deepEqual(decodeCursor(encodeCursor(ts, ID)), { ts, id: ID });
});

test('malformed base64 is rejected', () => {
  for (const raw of ['@@garbage@@', 'abc def', 'abc+/==', 'a=b', '', '%%%']) {
    assert.equal(decodeCursor(raw), null, JSON.stringify(raw));
  }
});

test('non-string input is rejected', () => {
  for (const raw of [undefined, null, 42, ['abc'], { ts: 'x' }]) {
    assert.equal(decodeCursor(raw), null, String(raw));
  }
});

test('well-formed base64 without the "<ts>|<id>" shape is rejected', () => {
  const cases = {
    'no pipe': b64('hello'),
    'empty id': b64('2026-10-23T08:00:00.123456Z|'),
    'empty timestamp': b64(`|${ID}`),
    'not a timestamp': b64(`yesterday|${ID}`),
    'missing Z': b64(`2026-10-23T08:00:00.123456|${ID}`),
    'offset instead of Z': b64(`2026-10-23T08:00:00.123456+01:00|${ID}`),
    'more than 6 fractional digits': b64(`2026-10-23T08:00:00.1234567Z|${ID}`),
    'date only': b64(`2026-10-23|${ID}`),
    'impossible month': b64(`2026-13-23T08:00:00Z|${ID}`),
  };
  for (const [why, raw] of Object.entries(cases)) {
    assert.match(raw, /^[A-Za-z0-9_-]+$/, `${why}: fixture should be valid base64url`);
    assert.equal(decodeCursor(raw), null, why);
  }
});
