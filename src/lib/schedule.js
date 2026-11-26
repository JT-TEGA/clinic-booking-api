// The demo clinic's timetable: which slots should exist, as plain data. No database here.
// Lagos is UTC+1 all year (no DST), so Lagos clock times are a fixed offset from UTC.

const DOCTORS = ['Dr Tega Ukpe', 'Dr James Hope', 'Dr Adrian Alas'];
const OPEN_HOUR = 9; // first slot 09:00 Lagos
const CLOSE_HOUR = 17; // last slot 16:30–17:00 Lagos
const SLOT_MINUTES = 30;
const WINDOW_DAYS = 14;

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// 00:00 Lagos time on the Lagos calendar date containing ms, as a UTC timestamp.
function lagosDayStart(ms) {
  const lagos = new Date(ms + LAGOS_OFFSET_MS);
  return Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - LAGOS_OFFSET_MS;
}

function isWeekday(dayStartMs) {
  const dow = new Date(dayStartMs + LAGOS_OFFSET_MS).getUTCDay();
  return dow !== 0 && dow !== 6;
}

function iso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// "Dr James Hope" at 2026-10-26 08:00Z -> "james-2026-10-26-0900" (Lagos clock time in the id).
// Deterministic, so the same slot always gets the same id and inserts can skip it on conflict.
function slotId(doctor, startMs) {
  const name = doctor.replace(/^Dr\s+/, '').split(/\s+/)[0].toLowerCase();
  const lagos = new Date(startMs + LAGOS_OFFSET_MS).toISOString();
  return `${name}-${lagos.slice(0, 10)}-${lagos.slice(11, 13)}${lagos.slice(14, 16)}`;
}

function makeSlot(doctor, startMs) {
  return {
    id: slotId(doctor, startMs),
    provider: doctor,
    start: iso(startMs),
    end: iso(startMs + SLOT_MINUTES * MINUTE_MS),
  };
}

// Every clinic-hours slot for every doctor from today (Lagos) through the next `days` calendar
// days, skipping weekends and anything that has already started at nowMs.
function windowSlots(nowMs = Date.now(), days = WINDOW_DAYS) {
  const slots = [];
  const today = lagosDayStart(nowMs);
  for (let d = 0; d < days; d++) {
    const day = today + d * DAY_MS;
    if (!isWeekday(day)) continue;
    for (const doctor of DOCTORS) {
      for (let m = OPEN_HOUR * 60; m + SLOT_MINUTES <= CLOSE_HOUR * 60; m += SLOT_MINUTES) {
        const start = day + m * MINUTE_MS;
        if (start > nowMs) slots.push(makeSlot(doctor, start));
      }
    }
  }
  return slots;
}

module.exports = {
  DOCTORS,
  OPEN_HOUR,
  CLOSE_HOUR,
  SLOT_MINUTES,
  WINDOW_DAYS,
  DAY_MS,
  lagosDayStart,
  slotId,
  makeSlot,
  windowSlots,
};
