const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseBooking, isValidEmail, validateBooking } = require('../../src/lib/validate');

const VALID = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

test('normaliseBooking trims slot_id and name', () => {
  const out = normaliseBooking({ slot_id: '  s1 \t', name: '\n Ada Obi  ', email: 'ada@example.com' });
  assert.equal(out.slot_id, 's1');
  assert.equal(out.name, 'Ada Obi');
});

test('normaliseBooking keeps inner whitespace and case of the name', () => {
  assert.equal(normaliseBooking({ name: '  Ada  Obi ' }).name, 'Ada  Obi');
});

test('normaliseBooking trims and lowercases email', () => {
  assert.equal(normaliseBooking({ email: '  ADA@Example.COM ' }).email, 'ada@example.com');
});

test('normaliseBooking treats non-string values as empty', () => {
  for (const value of [123, 0, true, null, undefined, ['s1'], { id: 's1' }]) {
    assert.deepEqual(
      normaliseBooking({ slot_id: value, name: value, email: value }),
      { slot_id: '', name: '', email: '' },
      `value ${JSON.stringify(value)}`
    );
  }
});

test('normaliseBooking tolerates a missing or non-object body', () => {
  const empty = { slot_id: '', name: '', email: '' };
  assert.deepEqual(normaliseBooking(undefined), empty);
  assert.deepEqual(normaliseBooking(null), empty);
  assert.deepEqual(normaliseBooking('slot_id=s1'), empty);
});

test('normaliseBooking returns exactly slot_id, name and email', () => {
  const out = normaliseBooking({ ...VALID, status: 'cancelled', id: 'x' });
  assert.deepEqual(Object.keys(out), ['slot_id', 'name', 'email']);
});

test('validateBooking accepts a complete, valid booking', () => {
  assert.equal(validateBooking(VALID), null);
});

test('validateBooking rejects each empty field', () => {
  for (const field of ['slot_id', 'name', 'email']) {
    const message = validateBooking({ ...VALID, [field]: '' });
    assert.equal(typeof message, 'string', field);
    assert.match(message, new RegExp(field), field);
  }
});

test('validateBooking rejects whitespace-only fields once normalised', () => {
  for (const field of ['slot_id', 'name', 'email']) {
    const input = normaliseBooking({ ...VALID, [field]: ' \t\n ' });
    assert.notEqual(validateBooking(input), null, field);
  }
});

test('validateBooking rejects an invalid email', () => {
  assert.equal(validateBooking({ ...VALID, email: 'notanemail' }), 'email is invalid');
});

test('isValidEmail accepts normal addresses', () => {
  for (const email of ['ada@example.com', 'ada.obi+clinic@mail.example.co.uk', 'a1@b.ng']) {
    assert.equal(isValidEmail(email), true, email);
  }
});

test('isValidEmail rejects malformed addresses', () => {
  const bad = {
    'no @ at all': 'notanemail',
    'no dot in the domain': 'ada@example',
    'space in the local part': 'ada obi@example.com',
    'space in the domain': 'ada@exa mple.com',
    'empty local part': '@example.com',
    'two @ signs': 'ada@obi@example.com',
    empty: '',
  };
  for (const [why, email] of Object.entries(bad)) {
    assert.equal(isValidEmail(email), false, why);
  }
});
