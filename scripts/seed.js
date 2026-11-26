// Fills a deployment with realistic slots via POST /reset (this wipes existing bookings).
// Usage: BASE_URL=http://localhost:3000 API_KEY=... RESET_TOKEN=... npm run seed

const { DOCTORS, DAY_MS, lagosDayStart, makeSlot } = require('../src/lib/schedule');

// A small set that fits in one /reset body. The server's automatic top-up fills in the rest
// of the 14-day window on its next restart, reusing these ids, so nothing is duplicated.
const WEEKDAYS_AHEAD = 5;
const START_TIMES_LAGOS = [[9, 0], [9, 30]];

function nextWeekdays(count) {
  const days = [];
  for (let day = lagosDayStart(Date.now()) + DAY_MS; days.length < count; day += DAY_MS) {
    const dow = new Date(day + 12 * 60 * 60 * 1000).getUTCDay(); // midday Lagos, safely on the right date
    if (dow !== 0 && dow !== 6) days.push(day);
  }
  return days;
}

function buildSlots() {
  const slots = [];
  for (const day of nextWeekdays(WEEKDAYS_AHEAD)) {
    for (const doctor of DOCTORS) {
      for (const [hour, minute] of START_TIMES_LAGOS) {
        slots.push(makeSlot(doctor, day + (hour * 60 + minute) * 60 * 1000));
      }
    }
  }
  // Already ended, to prove the page hides past slots.
  const [hour, minute] = START_TIMES_LAGOS[0];
  slots.push(makeSlot(DOCTORS[0], lagosDayStart(Date.now()) - DAY_MS + (hour * 60 + minute) * 60 * 1000));
  return slots;
}

async function main() {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.API_KEY;
  const resetToken = process.env.RESET_TOKEN;
  if (!baseUrl || !apiKey || !resetToken) {
    console.error('Usage: BASE_URL=https://... API_KEY=... RESET_TOKEN=... npm run seed');
    process.exit(1);
  }

  const slots = buildSlots();
  const res = await fetch(`${baseUrl}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-Reset-Token': resetToken },
    body: JSON.stringify({ slots }),
  });
  const body = await res.text();
  if (res.status !== 200) {
    console.error(`Seed failed: POST /reset returned ${res.status} ${body}`);
    process.exit(1);
  }

  const past = slots.filter((s) => Date.parse(s.end) <= Date.now()).length;
  console.log(`Created ${slots.length} slots at ${baseUrl} (${slots.length - past} upcoming, ${past} already ended).`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
