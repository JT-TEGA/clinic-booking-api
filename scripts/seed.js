// Fills a deployment with realistic slots via POST /reset (this wipes existing bookings).
// Usage: BASE_URL=http://localhost:3000 API_KEY=... npm run seed

const DOCTORS = ['Tega Ukpe', 'James Hope', 'Adrian alas'];
const WEEKDAYS_AHEAD = 5;
const SLOT_MINUTES = 30;
// Lagos is UTC+1 all year (no DST), so 09:00 and 09:30 local are 08:00Z and 08:30Z.
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const START_TIMES_UTC = [[8, 0], [8, 30]];
const DAY_MS = 24 * 60 * 60 * 1000;

// 00:00Z on today's calendar date in Lagos.
function lagosToday() {
  const lagosNow = new Date(Date.now() + LAGOS_OFFSET_MS);
  return Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), lagosNow.getUTCDate());
}

function nextWeekdays(count) {
  const days = [];
  for (let day = lagosToday() + DAY_MS; days.length < count; day += DAY_MS) {
    const dow = new Date(day).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(day);
  }
  return days;
}

function iso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// "James Hope" at 2026-10-26 08:00Z -> "james-2026-10-26-0900" (Lagos clock time in the id).
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
    end: iso(startMs + SLOT_MINUTES * 60 * 1000),
  };
}

function buildSlots() {
  const slots = [];
  for (const day of nextWeekdays(WEEKDAYS_AHEAD)) {
    for (const doctor of DOCTORS) {
      for (const [hour, minute] of START_TIMES_UTC) {
        slots.push(makeSlot(doctor, day + (hour * 60 + minute) * 60 * 1000));
      }
    }
  }
  // Already ended, to prove the page hides past slots.
  const [hour, minute] = START_TIMES_UTC[0];
  slots.push(makeSlot(DOCTORS[0], lagosToday() - DAY_MS + (hour * 60 + minute) * 60 * 1000));
  return slots;
}

async function main() {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.API_KEY;
  if (!baseUrl || !apiKey) {
    console.error('Usage: BASE_URL=https://... API_KEY=... npm run seed');
    process.exit(1);
  }

  const slots = buildSlots();
  const res = await fetch(`${baseUrl}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
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
