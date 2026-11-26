const test = require('node:test');
const assert = require('node:assert/strict');
const { DOCTORS, windowSlots, slotId } = require('../../src/lib/schedule');

const HOUR_MS = 60 * 60 * 1000;
// Monday 30 Nov 2026, 08:00 Lagos (07:00Z): before the clinic opens.
const MONDAY_EARLY = Date.parse('2026-11-30T07:00:00Z');

function lagosParts(iso) {
  const lagos = new Date(Date.parse(iso) + HOUR_MS);
  return { dow: lagos.getUTCDay(), minutes: lagos.getUTCHours() * 60 + lagos.getUTCMinutes() };
}

test('a full window is 10 weekdays x 3 doctors x 16 half-hour slots', () => {
  assert.equal(windowSlots(MONDAY_EARLY).length, 10 * DOCTORS.length * 16);
});

test('every slot is a weekday, 30 minutes long, between 09:00 and 17:00 Lagos', () => {
  for (const s of windowSlots(MONDAY_EARLY)) {
    const start = lagosParts(s.start);
    const end = lagosParts(s.end);
    assert.ok(start.dow >= 1 && start.dow <= 5, `${s.id} is on a weekend`);
    assert.ok(start.minutes >= 9 * 60, `${s.id} starts before 09:00`);
    assert.ok(end.minutes <= 17 * 60, `${s.id} ends after 17:00`);
    assert.equal(Date.parse(s.end) - Date.parse(s.start), 30 * 60 * 1000);
  }
});

test('every doctor has slots on every weekday of the 14 days', () => {
  const slots = windowSlots(MONDAY_EARLY);
  for (const doctor of DOCTORS) {
    const days = new Set(slots.filter((s) => s.provider === doctor).map((s) => s.id.slice(-15, -5)));
    assert.deepEqual([...days], [
      '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04',
      '2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11',
    ]);
  }
});

test('ids are unique and use the seed format (Lagos clock time)', () => {
  const slots = windowSlots(MONDAY_EARLY);
  assert.equal(new Set(slots.map((s) => s.id)).size, slots.length);
  const first = slots.find((s) => s.provider === 'Dr James Hope');
  assert.deepEqual(first, {
    id: 'james-2026-11-30-0900',
    provider: 'Dr James Hope',
    start: '2026-11-30T08:00:00Z',
    end: '2026-11-30T08:30:00Z',
  });
  assert.equal(slotId('Dr Adrian Alas', Date.parse('2026-11-30T15:30:00Z')), 'adrian-2026-11-30-1630');
});

test('slots that have already started are skipped', () => {
  // Monday 12:15 Lagos: 09:00–12:00 have started; 12:30–16:30 (9 slots) are left today.
  const now = Date.parse('2026-11-30T11:15:00Z');
  const slots = windowSlots(now);
  assert.ok(slots.every((s) => Date.parse(s.start) > now));
  const today = slots.filter((s) => s.id.includes('2026-11-30'));
  assert.equal(today.length, 9 * DOCTORS.length);
  assert.equal(slots.length, 9 * DOCTORS.length + 9 * DOCTORS.length * 16);
});

test('a slot starting exactly now is skipped', () => {
  const now = Date.parse('2026-11-30T08:00:00Z'); // 09:00 Lagos
  assert.ok(!windowSlots(now).some((s) => s.start === '2026-11-30T08:00:00Z'));
});

test('the Lagos date decides "today", not the UTC date', () => {
  // Sunday 23:30Z is already Monday 00:30 in Lagos, so Monday is day one of the window.
  const slots = windowSlots(Date.parse('2026-11-29T23:30:00Z'));
  assert.equal(slots[0].id, 'tega-2026-11-30-0900');
  assert.equal(slots.length, 10 * DOCTORS.length * 16);
});

test('on a weekend the window starts on Monday', () => {
  const slots = windowSlots(Date.parse('2026-11-28T10:00:00Z')); // Saturday
  assert.equal(slots[0].id, 'tega-2026-11-30-0900');
  // Sat..Fri week after next: 10 weekdays.
  assert.equal(slots.length, 10 * DOCTORS.length * 16);
});
