const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bookingHash } = require('../../src/lib/hash');

const BASE = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

test('bookingHash is a 64-char lowercase hex sha256', () => {
  assert.match(bookingHash(BASE), /^[0-9a-f]{64}$/);
});

test('bookingHash matches sha256 of the canonical JSON', () => {
  const expected = crypto
    .createHash('sha256')
    .update('{"slot_id":"s1","name":"Ada Obi","email":"ada@example.com"}')
    .digest('hex');
  assert.equal(bookingHash(BASE), expected);
});

test('identical input produces an identical hash', () => {
  assert.equal(bookingHash({ ...BASE }), bookingHash({ ...BASE }));
});

test('hash does not depend on the key order of the source object', () => {
  const reordered = { email: 'ada@example.com', name: 'Ada Obi', slot_id: 's1' };
  assert.equal(bookingHash(reordered), bookingHash(BASE));
});

test('hash ignores fields other than slot_id, name and email', () => {
  assert.equal(bookingHash({ ...BASE, extra: 'x' }), bookingHash(BASE));
});

test('changing any field changes the hash', () => {
  const original = bookingHash(BASE);
  for (const [field, value] of [['slot_id', 's2'], ['name', 'Ada  Obi'], ['email', 'ada@example.org']]) {
    assert.notEqual(bookingHash({ ...BASE, [field]: value }), original, field);
  }
});

test('field boundaries are unambiguous', () => {
  // Concatenation without structure would make these collide.
  const a = bookingHash({ slot_id: 'ab', name: 'c', email: 'x@y.co' });
  const b = bookingHash({ slot_id: 'a', name: 'bc', email: 'x@y.co' });
  assert.notEqual(a, b);
});
