const test = require('node:test');
const assert = require('node:assert/strict');
const { resetToken } = require('../../src/middleware/resetToken');

// Runs the middleware with the given RESET_TOKEN and request header; returns what it did.
function run(envToken, headerToken) {
  const saved = process.env.RESET_TOKEN;
  if (envToken === undefined) delete process.env.RESET_TOKEN;
  else process.env.RESET_TOKEN = envToken;
  try {
    const out = { status: null, body: null, next: false };
    const req = { get: (name) => (name.toLowerCase() === 'x-reset-token' ? headerToken : undefined) };
    const res = {
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    };
    resetToken(req, res, () => { out.next = true; });
    return out;
  } finally {
    if (saved === undefined) delete process.env.RESET_TOKEN;
    else process.env.RESET_TOKEN = saved;
  }
}

test('without RESET_TOKEN, /reset is a 404 even with a token sent', () => {
  assert.deepEqual(run(undefined, 'anything'), { status: 404, body: { error: 'not found' }, next: false });
  assert.deepEqual(run('', 'anything'), { status: 404, body: { error: 'not found' }, next: false });
});

test('a request without the token is rejected', () => {
  assert.deepEqual(run('s3cret', undefined), { status: 403, body: { error: 'forbidden' }, next: false });
  assert.deepEqual(run('s3cret', ''), { status: 403, body: { error: 'forbidden' }, next: false });
});

test('a wrong token is rejected, including a prefix of the right one', () => {
  assert.equal(run('s3cret', 's3cre').status, 403);
  assert.equal(run('s3cret', 's3cret ').status, 403);
  assert.equal(run('s3cret', 'S3CRET').status, 403);
});

test('the right token passes through', () => {
  assert.deepEqual(run('s3cret', 's3cret'), { status: null, body: null, next: true });
});
