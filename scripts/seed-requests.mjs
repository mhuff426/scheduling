// Seeds a year of plausible time-off requests (July 2026 – June 2027) for the
// current roster, via the live API so every real validation rule applies
// (per-day vacation cap, yearly allowances, duplicate checks).
//
// Run with the dev server up:  node scripts/seed-requests.mjs
//
// - Ensures the roster has a second admin (adds "Dana Whitfield" if needed).
// - Clears ALL existing time-off requests first.
// - Vacations come in trip-shaped clusters (2-6 consecutive days, 2-3 per
//   calendar year per person). Preferred days are scattered, often hugging a
//   trip ("extend the weekend").
// - One configured over-asker requests a pile of preferred days every month;
//   one ascetic asks for almost none.

const API = 'http://localhost:3001/api';
const GREEDY_NAME = 'Matt';   // prefix match — the preferred-day over-asker
const ASCETIC_NAME = 'Sharan'; // prefix match — barely asks

// Deterministic RNG so reruns produce the same dataset.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260701);
const rand = (a, b) => a + Math.floor(rng() * (b - a + 1));

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

async function req(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const state = (await req('GET', '/state')).data;

// --- roster: ensure 2 admins ---
const admins = state.users.filter((u) => u.role === 'admin');
if (admins.length < 2) {
  const r = await req('POST', '/users', { name: 'Dana Whitfield (Manager)', role: 'admin', vacationDays: 15 });
  console.log(`Added second admin: ${r.data.name}`);
}

// --- wipe existing requests ---
for (const t of state.timeOff) await req('DELETE', `/timeoff/${t.id}`);
console.log(`Cleared ${state.timeOff.length} existing time-off entries.`);

const users = (await req('GET', '/state')).data.users;
const greedy = users.find((u) => u.name.startsWith(GREEDY_NAME));
const ascetic = users.find((u) => u.name.startsWith(ASCETIC_NAME));

// --- generate requests ---
// Window: 2026-07-01 .. 2027-06-30. Vacation allowances are per calendar year.
const YEAR_WINDOWS = {
  2026: ['2026-07-01', '2026-12-31'],
  2027: ['2027-01-01', '2027-06-30'],
};

const requests = []; // { userId, date, type }
const summarySeed = {};

for (const u of users) {
  const taken = new Set(); // dates this user already has a request on
  const trips = [];

  // Vacation trips per calendar year, within allowance.
  for (const [year, [winStart, winEnd]] of Object.entries(YEAR_WINDOWS)) {
    let budget = Math.min(u.vacationDays, rand(5, Math.max(6, u.vacationDays - 2)));
    const span = daysBetween(winStart, winEnd);
    let guard = 0;
    while (budget > 0 && guard++ < 50) {
      const len = Math.min(budget, rand(2, 6));
      const start = addDays(winStart, rand(0, span - len));
      const dates = Array.from({ length: len }, (_, i) => addDays(start, i));
      if (dates.some((d) => taken.has(d))) continue; // overlap — retry
      dates.forEach((d) => taken.add(d));
      trips.push({ start, end: dates[len - 1] });
      for (const d of dates) requests.push({ userId: u.id, date: d, type: 'vacation' });
      budget -= len;
    }
  }

  // Preferred days.
  let prefCount;
  if (u === greedy) prefCount = rand(65, 85);       // the over-asker
  else if (u === ascetic) prefCount = rand(2, 4);   // the ascetic
  else prefCount = rand(14, 26);                    // normal flexibility

  let placed = 0, guard = 0;
  while (placed < prefCount && guard++ < prefCount * 20) {
    let date;
    if (trips.length && rng() < 0.35) {
      // hug a trip: the day before it starts or after it ends
      const t = trips[Math.floor(rng() * trips.length)];
      date = rng() < 0.5 ? addDays(t.start, -1) : addDays(t.end, 1);
    } else {
      date = addDays('2026-07-01', rand(0, 364));
    }
    if (date < '2026-07-01' || date > '2027-06-30' || taken.has(date)) continue;
    taken.add(date);
    requests.push({ userId: u.id, date, type: 'preferred' });
    placed++;
  }
  summarySeed[u.id] = { name: u.name, role: u.role, allowance: u.vacationDays };
}

// Shuffle so per-day vacation-cap contests aren't always won by the same user.
for (let i = requests.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [requests[i], requests[j]] = [requests[j], requests[i]];
}

// --- post everything through the real API ---
const tally = {}; // userId -> { vac26, vac27, pref, rejected }
for (const r of requests) {
  const t = (tally[r.userId] ??= { vac26: 0, vac27: 0, pref: 0, rejected: 0 });
  const res = await req('POST', '/timeoff', r);
  if (!res.ok) { t.rejected++; continue; }
  if (r.type === 'preferred') t.pref++;
  else if (r.date < '2027-01-01') t.vac26++;
  else t.vac27++;
}

console.log('\nSeeded time-off (Jul 2026 – Jun 2027):');
console.log('user                            role      allow  vac26  vac27  pref  rejected');
for (const [id, s] of Object.entries(summarySeed)) {
  const t = tally[id] || { vac26: 0, vac27: 0, pref: 0, rejected: 0 };
  console.log(
    `${s.name.padEnd(32)}${s.role.padEnd(10)}${String(s.allowance).padEnd(7)}${String(t.vac26).padEnd(7)}${String(t.vac27).padEnd(7)}${String(t.pref).padEnd(6)}${t.rejected}`
  );
}
const total = (await req('GET', '/state')).data.timeOff.length;
console.log(`\nTotal time-off entries now in the system: ${total}`);
