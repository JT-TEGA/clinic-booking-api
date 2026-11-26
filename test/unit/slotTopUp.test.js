const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlotTopUp } = require('../../src/slotTopUp');

const MONDAY_EARLY = Date.parse('2026-11-30T07:00:00Z');
const INTERVAL = 10 * 60 * 1000;

// A fake pg client that records each statement. hooks[kind] can replace a statement's behaviour.
function fakeDb(hooks = {}) {
  const calls = [];
  const kindOf = (sql) => (sql.includes('pg_advisory_xact_lock') ? 'lock' : sql.trim().startsWith('INSERT') ? 'insert' : sql.trim());
  const client = {
    async query(sql, params) {
      const kind = kindOf(sql);
      calls.push({ kind, params });
      if (hooks[kind]) return hooks[kind](params);
      return { rowCount: kind === 'insert' ? params[0].length : 0 };
    },
  };
  return { calls, kinds: () => calls.map((c) => c.kind), withClient: (fn) => fn(client) };
}

// Keeps the module's info lines out of the test output.
async function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

test('topUp inserts the window inside a locked transaction', async () => {
  const db = fakeDb();
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => MONDAY_EARLY });
  const inserted = await quietly(() => topUp.topUp());
  assert.equal(inserted, 480);
  assert.deepEqual(db.kinds(), ['BEGIN', 'lock', 'insert', 'COMMIT']);
  const [ids, providers, starts, ends, startRaw, endRaw] = db.calls[2].params;
  assert.equal(ids.length, 480);
  assert.equal(providers.length, 480);
  assert.deepEqual(startRaw, starts);
  assert.deepEqual(endRaw, ends);
});

test('maybeTopUp runs at most once per interval', async () => {
  const db = fakeDb();
  let now = MONDAY_EARLY;
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => now, minIntervalMs: INTERVAL });
  await quietly(async () => {
    await topUp.maybeTopUp();
    now += INTERVAL - 1;
    await topUp.maybeTopUp();
  });
  assert.equal(db.kinds().filter((k) => k === 'insert').length, 1);

  now += 1;
  await quietly(() => topUp.maybeTopUp());
  assert.equal(db.kinds().filter((k) => k === 'insert').length, 2);
});

test('the startup run counts toward the request interval', async () => {
  const db = fakeDb();
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => MONDAY_EARLY });
  await quietly(async () => {
    await topUp.topUp();
    await topUp.maybeTopUp();
  });
  assert.equal(db.kinds().filter((k) => k === 'insert').length, 1);
});

test('concurrent requests share one run', async () => {
  const db = fakeDb();
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => MONDAY_EARLY });
  await quietly(() => Promise.all([topUp.maybeTopUp(), topUp.maybeTopUp(), topUp.maybeTopUp()]));
  assert.equal(db.kinds().filter((k) => k === 'insert').length, 1);
});

test('after pause, maybeTopUp never touches the database', async () => {
  const db = fakeDb();
  let now = MONDAY_EARLY;
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => now, minIntervalMs: INTERVAL });
  await quietly(async () => {
    topUp.pause();
    await topUp.maybeTopUp();
    now += 10 * INTERVAL;
    await topUp.maybeTopUp();
  });
  assert.deepEqual(db.calls, []);
});

test('a run waiting on the lock when a reset starts inserts nothing', async () => {
  let releaseLock;
  const lockTaken = new Promise((resolve) => { releaseLock = resolve; });
  const db = fakeDb({ lock: () => lockTaken.then(() => ({ rowCount: 1 })) });
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => MONDAY_EARLY });

  const running = quietly(() => topUp.maybeTopUp());
  await new Promise((resolve) => setImmediate(resolve));
  await quietly(() => topUp.pause());
  releaseLock();
  await running;

  assert.deepEqual(db.kinds(), ['BEGIN', 'lock', 'ROLLBACK']);
});

test('maybeTopUp swallows database errors and rolls back', async () => {
  const db = fakeDb({ insert: () => { throw new Error('boom'); } });
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => MONDAY_EARLY });
  await quietly(() => topUp.maybeTopUp());
  assert.deepEqual(db.kinds(), ['BEGIN', 'lock', 'insert', 'ROLLBACK']);
});

test('topUp surfaces database errors to the caller', async () => {
  const db = fakeDb({ insert: () => { throw new Error('boom'); } });
  const topUp = createSlotTopUp({ withClient: db.withClient, now: () => MONDAY_EARLY });
  await assert.rejects(quietly(() => topUp.topUp()), /boom/);
});
