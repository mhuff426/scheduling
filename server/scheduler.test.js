// Smoke test: node server/scheduler.test.js
import assert from 'assert';
import {
  generateSchedule, buildSlots, isOvernight, restOk,
  computeCaps, preferenceStandings, DEMOTED_CLAIM,
  isGrouped, runBounds, nightCapOk, effectiveMaximums, weightOf,
  recoveryNeed,
} from './scheduler.js';

const mkUser = (id, name, extra = {}) => ({
  id, name, role: 'employee', vacationDays: 10, color: '#888', ...extra,
});
const mkDb = (users, shiftTypes, timeOff = []) => ({
  users, shiftTypes, timeOff,
  settings: { maxVacationPerDay: 2, overnightWeight: 1.5 },
  meta: { rotationCursor: 0 },
});

const day = { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const eve = { id: 'eve', name: 'Evening', startTime: '16:00', endTime: '00:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const night = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const inv = { id: 'inv', name: 'Inventory', startTime: '18:00', endTime: '22:00', frequency: 'weekly', dayOfWeek: 1, staffRequired: 2 };

// ---- slot expansion: 2026-06-01 is a Monday -> 7 daily + 2 weekly = 9
assert.strictEqual(buildSlots([day, inv], '2026-06-01', '2026-06-07').length, 9);

// ---- overnight detection
assert.ok(isOvernight(night), 'night 22-06 is overnight');
assert.ok(!isOvernight(eve), 'evening ending exactly at midnight is not overnight');
assert.ok(!isOvernight(day), 'day shift is not overnight');

// ---- rest rule primitives
const shiftById = { day, eve, night };
assert.ok(
  !restOk([{ date: '2026-06-01', shiftTypeId: 'night' }], shiftById, '2026-06-02', day),
  'day shift 2h after a night shift ends must be blocked'
);
assert.ok(
  restOk([{ date: '2026-06-01', shiftTypeId: 'eve' }], shiftById, '2026-06-02', day),
  'evening ends midnight; 8am start is exactly 8h rest — allowed'
);

// ---- hard constraints + basic fairness
{
  const db = mkDb(
    [mkUser('a', 'Alice'), mkUser('b', 'Bob'), mkUser('c', 'Cara')],
    [day, inv],
    [
      { id: 't1', userId: 'a', date: '2026-06-01', type: 'vacation' },
      { id: 't2', userId: 'b', date: '2026-06-03', type: 'preferred' },
    ]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07', minShifts: 2 });
  assert.ok(!r.assignments.some((x) => x.userId === 'a' && x.date === '2026-06-01'), 'vacation scheduled over');
  const seen = new Set();
  for (const x of r.assignments) {
    const k = `${x.userId}|${x.date}`;
    assert.ok(!seen.has(k), `double-booked: ${k}`);
    seen.add(k);
  }
  assert.ok(!r.assignments.some((x) => x.userId === 'b' && x.date === '2026-06-03'), 'preferred-off used despite coverage');
  // Alice's vacation day reduces her minimum from 2 to 1.
  assert.ok(r.counts['a'] >= 1 && r.counts['b'] >= 2 && r.counts['c'] >= 2, `minimums: ${JSON.stringify(r.counts)}`);
}

// ---- rest rule end-to-end: night worker can't take next morning's day shift
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [night, day]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-02', minShifts: 0 });
  for (const a of r.assignments.filter((x) => x.shiftTypeId === 'day')) {
    const prevNight = r.assignments.find(
      (x) => x.shiftTypeId === 'night' && x.userId === a.userId &&
        new Date(x.date + 'T00:00:00').getTime() === new Date(a.date + 'T00:00:00').getTime() - 86400000
    );
    assert.ok(!prevNight, `${a.userId} works day shift on ${a.date} right after a night shift`);
  }
  // With per-day slot ordering the scheduler finds the fully-covered split
  // (one person keeps nights, the other keeps days) — nothing goes open and
  // the rest rule still holds (asserted above).
  assert.strictEqual(r.unfilled.length, 0, `expected full coverage, got ${r.unfilled.length} open`);
}

// ---- vacation reduces personal minimum (explicit warning check)
{
  const db = mkDb(
    [mkUser('a', 'A'), mkUser('b', 'B')],
    [day],
    [{ id: 't1', userId: 'a', date: '2026-06-01', type: 'vacation' }]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-03', minShifts: 3 });
  // A's min is 2 (3 - 1 vacation day) and only 3 slots exist; A working 2 of 3 is satisfiable.
  assert.ok(!r.warnings.some((w) => w.startsWith('A has')), `A should meet reduced min: ${JSON.stringify(r.warnings)}`);
  assert.ok(r.warnings.some((w) => w.startsWith('B has')), 'B cannot reach 3 with only 1 slot left — expect warning');
}

// ---- desired shifts get priority for extras
{
  const db = mkDb(
    [mkUser('a', 'A', { desiredShifts: 4 }), mkUser('b', 'B'), mkUser('c', 'C')],
    [day]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-06', minShifts: 1 });
  assert.strictEqual(r.counts['a'], 4, `A wanted 4, got ${r.counts['a']}`);
  assert.strictEqual(r.counts['b'] + r.counts['c'], 2);
}

// ---- overnight shifts distributed evenly
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [night]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-04', minShifts: 0 });
  assert.strictEqual(r.counts['a'], 2, 'overnights uneven');
  assert.strictEqual(r.counts['b'], 2, 'overnights uneven');
}

// ---- rotation cursor advances and is returned
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.meta.rotationCursor = 1;
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-03', minShifts: 0 });
  assert.strictEqual(typeof r.nextRotationCursor, 'number');
  assert.strictEqual(r.nextRotationCursor, (1 + 3) % 2);
}

// ---- forced preference override still covered + warned
{
  const db = mkDb(
    [mkUser('a', 'A'), mkUser('b', 'B')],
    [day],
    [
      { id: 't1', userId: 'a', date: '2026-06-01', type: 'vacation' },
      { id: 't2', userId: 'b', date: '2026-06-01', type: 'preferred' },
    ]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-02', minShifts: 0 });
  assert.ok(r.assignments.some((x) => x.userId === 'b' && x.date === '2026-06-01'), 'preferred-off worker should cover when alone');
  assert.ok(r.warnings.some((w) => w.includes('despite preferring')), 'missing override warning');
}

// ---- per-block roster: excluded people get no shifts and no warnings
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')], [day]);
  const r = generateSchedule(db, {
    startDate: '2026-06-01', endDate: '2026-06-04', minShifts: 2, userIds: ['a', 'b'],
  });
  assert.strictEqual(r.counts['c'] || 0, 0, 'excluded user was scheduled');
  assert.ok(!r.warnings.some((w) => w.startsWith('C ')), 'excluded user should not trigger minimum warnings');
  assert.strictEqual(r.counts['a'] + r.counts['b'], 4, 'included users cover all slots');
}

// ===== preference anti-gaming =====

const D = (n) => `2026-07-${String(n).padStart(2, '0')}`; // July 2026 dates
const pref = (uid, n) => ({ id: `p-${uid}-${n}`, userId: uid, date: D(n), type: 'preferred' });
const JULY = { startDate: '2026-07-01', endDate: '2026-07-14', userIds: null };

// ---- cap threshold: everyone asks 2, one asks 3 -> untouched (SD floor of 1 day)
{
  const users = [...'abcdefgh'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff = [];
  for (const u of users) for (let n = 1; n <= 2; n++) timeOff.push(pref(u.id, n));
  timeOff.push(pref('h', 3)); // H asks one more than everyone
  const db = mkDb(users, [day], timeOff);
  const { caps } = computeCaps(db, JULY);
  assert.deepStrictEqual(caps, {}, 'one extra day must not trigger the cap');
}

// ---- cap threshold: 9 asks vs roster norm ~2 -> capped, requested-order kept
{
  const users = [...'abcdefgh'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff = [];
  for (const u of users.slice(0, 7)) for (let n = 1; n <= 2; n++) timeOff.push(pref(u.id, n));
  for (let n = 1; n <= 9; n++) timeOff.push(pref('h', n)); // requested in order: days 1..9
  const db = mkDb(users, [day], timeOff);
  const { caps, warnings } = computeCaps(db, JULY);
  assert.ok(caps.h !== undefined, '9 asks against norm 2 must be capped');
  assert.ok(caps.h >= 5 && caps.h <= 6, `cap ≈ floor(1.71 + 4) — got ${caps.h}`);
  assert.ok(warnings.some((w) => w.includes('H asked for 9 preferred days')), 'missing cap warning');
}

// ---- demoted days: still avoided when coverage is free, but lose to any normal preference
{
  // A asks 8 of 10 days (cap 6 -> days 7,8 demoted); B asks days 7,8 normally.
  const timeOff = [];
  for (let n = 1; n <= 8; n++) timeOff.push(pref('a', n));
  timeOff.push(pref('b', 7), pref('b', 8));
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day], timeOff);
  const r = generateSchedule(db, { startDate: '2026-07-01', endDate: '2026-07-10', minShifts: 0 });
  for (const d of [D(7), D(8)]) {
    const a = r.assignments.find((x) => x.date === d);
    assert.strictEqual(a.userId, 'a', `demoted claim (A) must lose to normal preference (B) on ${d}`);
  }
  // Days 9-10: neither prefers; both available; loads decide — no assertion needed.
  // Days 1-6: A's full-strength preference vs B free -> B works all of them.
  for (let n = 1; n <= 6; n++) {
    const a = r.assignments.find((x) => x.date === D(n));
    assert.strictEqual(a.userId, 'b', `A's protected preferred day ${D(n)} should go to B`);
  }
}

// ---- standing trajectories
{
  const mkBlock = (i, asks, med) => ({
    id: `s${i}`, createdAt: `2026-0${i}-01T00:00:00Z`,
    preferenceStats: { asks, median: med },
  });
  const users = [mkUser('a', 'A')];
  // chronic doubler: ratio 2 (signal 0.5) for 3 blocks -> 1.0 -> .85 -> .745 -> .6715
  let db = { users, schedules: [1, 2, 3].map((i) => mkBlock(i, { a: 4 }, 2)) };
  assert.ok(Math.abs(preferenceStandings(db).a - 0.6715) < 1e-9, `chronic: ${preferenceStandings(db).a}`);
  // one spike then two normal blocks -> .85 -> .895 -> .9265
  db = { users, schedules: [mkBlock(1, { a: 4 }, 2), mkBlock(2, { a: 2 }, 2), mkBlock(3, { a: 2 }, 2)] };
  assert.ok(Math.abs(preferenceStandings(db).a - 0.9265) < 1e-9, `spike: ${preferenceStandings(db).a}`);
  // never asks -> climbs to the 1.25 ceiling
  db = { users, schedules: [1, 2, 3].map((i) => mkBlock(i, { a: 0 }, 2)) };
  assert.strictEqual(preferenceStandings(db).a, 1.25, 'saint should hit the ceiling');
  // median floor: roster median 0, asking 2 is neutral
  db = { users, schedules: [mkBlock(1, { a: 2 }, 0)] };
  assert.strictEqual(preferenceStandings(db).a, 1.0, 'asking 2 on a quiet roster must be neutral');
  // self-healing: deleting history restores neutrality
  db = { users, schedules: [] };
  assert.strictEqual(preferenceStandings(db).a, 1.0);
}

// ---- standing changes who wins a contested day
{
  // Both A and B prefer day 1 off; A has low standing from history, B neutral.
  const history = [1, 2, 3].map((i) => ({
    id: `s${i}`, createdAt: `2026-0${i}-01T00:00:00Z`,
    preferenceStats: { asks: { a: 6, b: 2 }, median: 2 },
  }));
  const db = mkDb(
    [mkUser('a', 'A'), mkUser('b', 'B')],
    [day],
    [pref('a', 1), pref('b', 1)]
  );
  db.schedules = history;
  const r = generateSchedule(db, { startDate: '2026-07-01', endDate: '2026-07-01', minShifts: 0 });
  assert.strictEqual(r.assignments[0].userId, 'a', 'lower standing must be overridden first');
}

// ---- generation snapshots raw asks for future standing
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day], [pref('a', 1), pref('a', 2)]);
  const r = generateSchedule(db, { startDate: '2026-07-01', endDate: '2026-07-07', minShifts: 0 });
  assert.deepStrictEqual(r.preferenceStats.asks, { a: 2, b: 0 });
  assert.strictEqual(r.preferenceStats.median, 1);
}

// ===== shift runs =====

// helper: walk a single shift type's assignments in date order, return run lengths
function runLengths(assignments, shiftTypeId) {
  const days = assignments
    .filter((a) => a.shiftTypeId === shiftTypeId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const runs = [];
  let curUser = null, len = 0, prevDate = null;
  for (const a of days) {
    const consecutive = prevDate && new Date(a.date) - new Date(prevDate) === 86400000;
    if (a.userId === curUser && consecutive) len++;
    else { if (len) runs.push(len); curUser = a.userId; len = 1; }
    prevDate = a.date;
  }
  if (len) runs.push(len);
  return runs;
}

// ---- grouping config detection
assert.ok(!isGrouped({ minRun: 1, maxRun: null }), 'no run config = not grouped');
assert.ok(isGrouped({ minRun: 5, maxRun: 7 }), 'range = grouped');
assert.ok(isGrouped({ minRun: 1, maxRun: 4 }), 'max only = grouped');
assert.deepStrictEqual(runBounds({ minRun: 3, maxRun: 4 }), { min: 3, max: 4 });
assert.deepStrictEqual(runBounds({ minRun: 5, maxRun: null }), { min: 5, max: Infinity });

// ---- runs form and cap at maxRun, then rotate to a fresh person
{
  const chemo = { id: 'chemo', name: 'Chemo', startTime: '09:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 4 };
  const users = [mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')];
  const db = mkDb(users, [chemo]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-08', minShifts: 0 });
  const runs = runLengths(r.assignments, 'chemo');
  assert.ok(Math.max(...runs) <= 4, `no run may exceed maxRun 4; got ${runs}`);
  assert.ok(runs.some((x) => x >= 3), `at least one run should reach minRun 3; got ${runs}`);
  // first four days are one person (run climbs to the cap before switching)
  const first4 = r.assignments.filter((a) => a.date <= '2026-08-04').map((a) => a.userId);
  assert.strictEqual(new Set(first4).size, 1, `first run should be one person; got ${first4}`);
  // 8 days, cap 4 -> at least two people share the type
  assert.ok(new Set(r.assignments.map((a) => a.userId)).size >= 2, 'work must rotate off the first person');
}

// ---- wide rotation: a long block spreads a grouped type across many people
{
  const chemo = { id: 'chemo', name: 'Chemo', startTime: '09:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 5, maxRun: 7 };
  const users = [...'abcdef'].map((c) => mkUser(c, c.toUpperCase()));
  const db = mkDb(users, [chemo]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-21', minShifts: 0 });
  const distinct = new Set(r.assignments.map((a) => a.userId)).size;
  assert.ok(distinct >= 3, `21 days of runs ≤7 should touch ≥3 people, not monopolize; got ${distinct}`);
  assert.ok(Math.max(...runLengths(r.assignments, 'chemo')) <= 7, 'runs must respect maxRun 7');
}

// ---- personal night cap (cross-type) via the exported helper
{
  const n1 = { id: 'n1', name: 'N1', startTime: '22:00', endTime: '06:00' };
  const n2 = { id: 'n2', name: 'N2', startTime: '20:00', endTime: '04:00' };
  const dayShift = { id: 'd', name: 'D', startTime: '08:00', endTime: '16:00' };
  const shiftById = { n1, n2, d: dayShift };
  const u = mkUser('a', 'A', { maxConsecutiveNights: 2 });
  const held = [
    { date: '2026-08-01', shiftTypeId: 'n1' },
    { date: '2026-08-02', shiftTypeId: 'n1' },
  ];
  assert.ok(!nightCapOk(u, held, shiftById, '2026-08-03', n2), 'a different overnight type must still hit the cap');
  assert.ok(!nightCapOk(u, held, shiftById, '2026-08-03', n1), 'same overnight type hits the cap');
  assert.ok(nightCapOk(u, held, shiftById, '2026-08-03', dayShift), 'a day shift is never capped');
  assert.ok(nightCapOk(u, held, shiftById, '2026-08-04', n2), 'a gap day resets the streak');
  assert.ok(nightCapOk(mkUser('b', 'B'), held, shiftById, '2026-08-03', n1), 'no cap set = always ok');
}

// ---- night cap end to end: one capped worker leaves a slot open rather than over-work
{
  const night = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A', { maxConsecutiveNights: 2 })], [night]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-04', minShifts: 0 });
  // A works nights 1 and 2, must rest night 3 (would be the 3rd in a row), works night 4.
  assert.ok(!r.assignments.some((a) => a.date === '2026-08-03'), 'the 3rd consecutive night must not be assigned');
  assert.strictEqual(r.unfilled.filter((s) => s.date === '2026-08-03').length, 1, 'night 3 should be open');
}

// ===== maximum shifts =====

// ---- effective max resolution: override > block max > unlimited
{
  const db = { users: [mkUser('a', 'A', { maxShiftsOverride: 2 }), mkUser('b', 'B')] };
  const withBlock = effectiveMaximums(db, { maxShifts: 5 });
  assert.strictEqual(withBlock.get('a'), 2, 'override beats block max');
  assert.strictEqual(withBlock.get('b'), 5, 'no override falls back to block max');
  const noBlock = effectiveMaximums(db, { maxShifts: null });
  assert.strictEqual(noBlock.get('a'), 2);
  assert.strictEqual(noBlock.get('b'), Infinity, 'no cap anywhere = unlimited');
}

// ---- block max is a hard cap; uncoverable slots go open
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10', minShifts: 0, maxShifts: 3 });
  assert.ok(Object.values(r.counts).every((c) => c <= 3), `nobody may exceed 3: ${JSON.stringify(r.counts)}`);
  assert.strictEqual(r.assignments.length, 6, 'two people × max 3 = 6 assignments');
  assert.strictEqual(r.unfilled.length, 4, 'remaining 4 slots must go open');
}

// ---- per-employee override wins over the block max
{
  const db = mkDb([mkUser('a', 'A', { maxShiftsOverride: 1 }), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10', minShifts: 0, maxShifts: 3 });
  assert.strictEqual(r.counts['a'], 1, `A capped at override 1, got ${r.counts['a']}`);
  assert.strictEqual(r.counts['b'], 3, `B capped at block max 3, got ${r.counts['b']}`);
}

// ---- a ceiling below the floor lowers the floor (no impossible-minimum warnings)
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10', minShifts: 5, maxShifts: 2 });
  assert.ok(Object.values(r.counts).every((c) => c === 2), `everyone hits exactly the cap: ${JSON.stringify(r.counts)}`);
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), `no min warnings when capped below the floor: ${JSON.stringify(r.warnings)}`);
}

// ---- desired shifts beyond the cap don't warn
{
  const db = mkDb([mkUser('a', 'A', { desiredShifts: 6 }), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10', minShifts: 0, maxShifts: 2 });
  assert.strictEqual(r.counts['a'], 2);
  assert.ok(!r.warnings.some((w) => w.includes('requested')), 'no desired-shifts warning past the cap');
}

// ===== per-shift-type weights =====

// ---- weight resolution: explicit (incl. 0) wins; overnight default; plain 1
{
  const settings = { overnightWeight: 1.5 };
  assert.strictEqual(weightOf({ ...night, weight: 2 }, settings), 2, 'explicit weight wins');
  assert.strictEqual(weightOf({ ...day, weight: 0 }, settings), 0, 'explicit 0 allowed');
  assert.strictEqual(weightOf(night, settings), 1.5, 'overnight falls back to overnight default');
  assert.strictEqual(weightOf(day, settings), 1, 'plain shift defaults to 1');
  // Regression: a stored weight of null (the edit form's "automatic") must NOT
  // be read as 0 — Number(null) is 0.
  assert.strictEqual(weightOf({ ...day, weight: null }, settings), 1, 'null weight = automatic, not standby');
  assert.strictEqual(weightOf({ ...night, weight: null }, settings), 1.5, 'null weight on overnight = auto default');
  assert.strictEqual(weightOf({ ...day, weight: '' }, settings), 1, 'empty-string weight = automatic');
}

// ---- weight-0 shifts don't count toward minimums (but are still assigned)
{
  const standby = { id: 'sb', name: 'Standby', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, weight: 0 };
  const work = { id: 'wk', name: 'Work', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [work, standby]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-04', minShifts: 2 });
  assert.strictEqual(r.assignments.length, 8, 'standby slots are still filled');
  assert.strictEqual(r.counts['a'], 2, `counts exclude standby: ${JSON.stringify(r.counts)}`);
  assert.strictEqual(r.counts['b'], 2, `counts exclude standby: ${JSON.stringify(r.counts)}`);
  assert.ok(!r.warnings.some((w) => w.includes('minimum')), 'minimums met by counting shifts only');
}

// ---- weight-0 shifts don't eat the maximum
{
  const standby = { id: 'sb', name: 'Standby', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, weight: 0 };
  const work = { id: 'wk', name: 'Work', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [work, standby]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-04', minShifts: 0, maxShifts: 1 });
  const standbyAssigned = r.assignments.filter((a) => a.shiftTypeId === 'sb').length;
  assert.strictEqual(standbyAssigned, 4, 'all standby slots fill despite max 1');
  const workAssigned = r.assignments.filter((a) => a.shiftTypeId === 'wk').length;
  assert.strictEqual(workAssigned, 2, 'counting shifts capped at 1 each: 2 of 4 work slots fill');
  assert.strictEqual(r.unfilled.length, 2, 'the other 2 work slots go open');
}

// ---- custom weights steer load balancing
{
  const heavy = { id: 'hv', name: 'Heavy', startTime: '08:00', endTime: '16:00', frequency: 'weekly', dayOfWeek: 1, staffRequired: 1, weight: 3 };
  const light = { id: 'lt', name: 'Light', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  // 2026-06-01 is a Monday: 1 heavy (weight 3) + 7 light (weight 1) over a week.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [heavy, light]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07', minShifts: 0 });
  const heavyUser = r.assignments.find((a) => a.shiftTypeId === 'hv').userId;
  const lightOfHeavyUser = r.assignments.filter((a) => a.shiftTypeId === 'lt' && a.userId === heavyUser).length;
  const lightOfOther = 7 - lightOfHeavyUser;
  assert.ok(
    lightOfOther - lightOfHeavyUser >= 2,
    `heavy-shift holder should get fewer light shifts (got ${lightOfHeavyUser} vs ${lightOfOther})`
  );
}

// ===== run fairness across shift-type list positions =====

// Two grouped types + one ungrouped filler, 3 people, 18 days. Under static
// list-order processing, the top type poaches the bottom type's run-holder
// whenever it starts a fresh run, fragmenting the bottom type's runs. With
// per-day urgency ordering, runs of BOTH types should only ever end at the
// run cap (or the end of the block), regardless of list position.
{
  const t1 = { id: 't1', name: 'Top', startTime: '08:00', endTime: '12:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 4 };
  const t2 = { id: 't2', name: 'Bottom', startTime: '13:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 4 };
  const filler = { id: 'u0', name: 'Filler', startTime: '18:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };

  const runStats = (assignments, typeId) => {
    const runs = runLengths(assignments, typeId);
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    return { runs, mean };
  };

  for (const order of [[t1, t2, filler], [t2, t1, filler]]) {
    const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')], order);
    const r = generateSchedule(db, { startDate: '2026-08-02', endDate: '2026-08-19', minShifts: 0 });
    for (const typeId of ['t1', 't2']) {
      const { runs } = runStats(r.assignments, typeId);
      // Every run except the final (block-truncated) one must reach minRun —
      // i.e., runs end at the cap, never because another type stole the holder.
      const body = runs.slice(0, -1);
      assert.ok(
        body.every((len) => len >= 3),
        `${typeId} fragmented with order [${order.map((s) => s.id)}]: runs ${runs}`
      );
      assert.ok(runs.every((len) => len <= 4), `${typeId} exceeded maxRun: ${runs}`);
    }
    // Both types should look statistically alike: same total days, and mean
    // run lengths within a day of each other.
    const s1 = runStats(r.assignments, 't1');
    const s2 = runStats(r.assignments, 't2');
    assert.ok(
      Math.abs(s1.mean - s2.mean) <= 1,
      `run quality differs by list position: t1 mean ${s1.mean}, t2 mean ${s2.mean}`
    );
  }
}

// ===== post-run recovery days =====

assert.strictEqual(recoveryNeed(1), 0, 'single day needs no recovery');
assert.strictEqual(recoveryNeed(2), 1);
assert.strictEqual(recoveryNeed(4), 1);
assert.strictEqual(recoveryNeed(5), 2);
assert.strictEqual(recoveryNeed(9), 2);

// ---- returning after 1 day off from a 5-day stretch loses to a rested person
{
  const W = { id: 'w', name: 'W', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  // B is away days 1-5 so A works a 5-day stretch; A is away day 6 so B covers.
  // Day 7: A would win on desired-shifts priority, but owes 1 more recovery day.
  const timeOff = [];
  for (let n = 1; n <= 5; n++) timeOff.push({ id: `v${n}`, userId: 'b', date: `2026-09-0${n}`, type: 'vacation' });
  timeOff.push({ id: 'va', userId: 'a', date: '2026-09-06', type: 'vacation' });
  const db = mkDb([mkUser('a', 'A', { desiredShifts: 7 }), mkUser('b', 'B')], [W], timeOff);
  const r = generateSchedule(db, { startDate: '2026-09-01', endDate: '2026-09-07', minShifts: 0 });
  const day7 = r.assignments.find((x) => x.date === '2026-09-07');
  assert.strictEqual(day7.userId, 'b', 'rested B must beat early-returning A on day 7');
}

// ---- soft: when only the unrested person exists, the slot still fills (+ warning)
{
  const W = { id: 'w', name: 'W', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const timeOff = [];
  for (let n = 1; n <= 7; n++) timeOff.push({ id: `v${n}`, userId: 'b', date: `2026-09-0${n}`, type: 'vacation' });
  timeOff.push({ id: 'va', userId: 'a', date: '2026-09-06', type: 'vacation' });
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [W], timeOff);
  const r = generateSchedule(db, { startDate: '2026-09-01', endDate: '2026-09-07', minShifts: 0 });
  const day7 = r.assignments.find((x) => x.date === '2026-09-07');
  assert.strictEqual(day7?.userId, 'a', 'coverage beats recovery when nobody else can work');
  assert.ok(
    r.warnings.some((w) => w.includes('only 1 day off after a 5-day stretch')),
    `missing recovery warning: ${JSON.stringify(r.warnings)}`
  );
}

// ---- chaining a different shift type right after a run is discouraged
{
  const G = { id: 'g', name: 'G', startTime: '09:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 3 };
  const X = { id: 'x', name: 'X', startTime: '18:00', endTime: '22:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A', { desiredShifts: 9 }), mkUser('b', 'B'), mkUser('c', 'C')], [G, X]);
  const r = generateSchedule(db, { startDate: '2026-09-01', endDate: '2026-09-04', minShifts: 0 });
  // A's G run is days 1-3; despite wanting many shifts, A must not be handed
  // the X shift on day 4 with zero days off after a 3-day stretch.
  const aRun = r.assignments.filter((x) => x.userId === 'a' && x.shiftTypeId === 'g').map((x) => x.date);
  assert.deepStrictEqual(aRun, ['2026-09-01', '2026-09-02', '2026-09-03'], `A's run: ${aRun}`);
  assert.ok(
    !r.assignments.some((x) => x.userId === 'a' && x.date === '2026-09-04'),
    'A must rest on day 4, not chain onto another shift type'
  );
}

// ===== vacation settlement =====

// ---- shortfall caused by must-offs is charged as vacation, not warned
{
  const db = mkDb([mkUser('a', 'A')], [day], [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-03', type: 'vacation' },
  ]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05', minShifts: 5 });
  assert.strictEqual(r.counts['a'], 3, 'works the other 3 days');
  assert.deepStrictEqual(r.vacationCharged, { a: 2 }, 'the 2 must-off days are charged');
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), 'covered shortfall does not warn');
}

// ---- uncovered shortfall still warns with charge-aware copy
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-04', minShifts: 4 });
  assert.deepStrictEqual(r.vacationCharged, {}, 'no must-offs -> no charges');
  assert.strictEqual(
    r.warnings.filter((w) => w.includes('2 short')).length, 2,
    `both 2 short of 4: ${JSON.stringify(r.warnings)}`
  );
}

// ---- unaffordable must-offs downgrade to strong-but-soft claims
{
  const timeOff = [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-03', type: 'vacation' },
    { id: 'm3', userId: 'a', date: '2026-06-04', type: 'vacation' },
    { id: 'mb', userId: 'b', date: '2026-06-03', type: 'vacation' }, // b is hard-off the 3rd
  ];
  const db = mkDb([mkUser('a', 'A', { vacationDays: 1 }), mkUser('b', 'B')], [day], timeOff);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05', minShifts: 0 });
  // a asked for 3 must-offs with only 1 vacation day available -> all soft.
  // b covers the 2nd and 4th, but on the 3rd b is hard-off, so coverage
  // schedules a over their downgraded day.
  assert.ok(
    r.assignments.some((x) => x.userId === 'a' && x.date === '2026-06-03'),
    'coverage overrides a downgraded must-off day'
  );
  assert.ok(
    !r.assignments.some((x) => x.userId === 'a' && x.date === '2026-06-02') &&
    !r.assignments.some((x) => x.userId === 'a' && x.date === '2026-06-04'),
    'downgraded days still honored when someone else can cover'
  );
  assert.strictEqual(r.unfilled.length, 0, 'nothing goes open');
}

console.log('All scheduler tests passed.');
