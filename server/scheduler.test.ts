// Smoke test: tsx server/scheduler.test.ts
import assert from 'assert';
import {
  generateSchedule, buildSlots, isOvernight, restOk,
  computeCaps, preferenceStandings, DEMOTED_CLAIM,
  isGrouped, runBounds, nightCapOk, effectiveMaximums,
  recoveryNeed, effectiveMinimums,
  isAway, isBeforeStart, hasRequiredRole,
  heavyAskers, HEAVY_ASKER_STDDEV, summarizeSchedule,
} from './scheduler.js';
import { yearBalance } from '../shared/settlement.js';
import type { Assignment, Db, ScheduleDraft, ShiftType, TimeOff, User, VacationCharge } from '../shared/types.js';

// Vacation days charged per person, from a schedule's dated charges.
const chargedBy = (s: { vacationCharges?: VacationCharge[] }) => {
  const out: Record<string, number> = {};
  for (const c of s.vacationCharges || []) out[c.userId] = (out[c.userId] || 0) + 1;
  return out;
};
const chargesOf = (userId: string, n: number, date: string): VacationCharge[] =>
  Array.from({ length: n }, () => ({ userId, date, cause: 'shortfall' as const }));

const mkUser = (id: string, name: string, extra: Record<string, any> = {}): User => ({
  id, name, roles: ['role-employee'], vacationDays: 10, color: '#888', ...extra,
});
const mkDb = (users: User[], shiftTypes: ShiftType[], timeOff: TimeOff[] = []): Db => ({
  users, roles: [], shiftTypes, timeOff,
  settings: { maxVacationPerDay: 2 },
  schedules: [], trades: [], notifications: [], awayTime: [], holidays: [],
  meta: { rotationCursor: 0 },
});

// Migration helper: the old global `minShifts: N` meant "every included user
// has floor N". Per-user `requiredShifts` is now the floor (and the target),
// so applying N to every user without an explicit requiredShifts reproduces
// the old global behavior. Users that already set requiredShifts keep theirs.
const allMin = (db: Db, n: number): Db => {
  db.users.forEach((u) => { if (u.requiredShifts === undefined) u.requiredShifts = n; });
  return db;
};

const day: ShiftType = { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const eve: ShiftType = { id: 'eve', name: 'Evening', startTime: '16:00', endTime: '00:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const night: ShiftType = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const inv: ShiftType = { id: 'inv', name: 'Inventory', startTime: '18:00', endTime: '22:00', frequency: 'weekly', dayOfWeek: 1, staffRequired: 2 };

// ---- slot expansion: 2026-06-01 is a Monday -> 7 daily + 2 weekly = 9
assert.strictEqual(buildSlots([day, inv], '2026-06-01', '2026-06-07').length, 9);

// ---- overnight detection
assert.ok(isOvernight(night), 'night 22-06 is overnight');
assert.ok(!isOvernight(eve), 'evening ending exactly at midnight is not overnight');
assert.ok(!isOvernight(day), 'day shift is not overnight');

// ---- rest rule primitives
const shiftById = { day, eve, night };
assert.ok(
  !restOk([{ date: '2026-06-01', shiftTypeId: 'night' }] as Assignment[], shiftById, '2026-06-02', day),
  'day shift 2h after a night shift ends must be blocked'
);
assert.ok(
  restOk([{ date: '2026-06-01', shiftTypeId: 'eve' }] as Assignment[], shiftById, '2026-06-02', day),
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
  allMin(db, 2); // every user has a floor of 2 (old global minShifts: 2)
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
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
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-02' });
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
  allMin(db, 3); // both A and B have a floor of 3 (old global minShifts: 3)
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-03' });
  // A's min is 2 (3 - 1 vacation day) and only 3 slots exist; A working 2 of 3 is satisfiable.
  assert.ok(!r.warnings.some((w) => w.startsWith('A has')), `A should meet reduced min: ${JSON.stringify(r.warnings)}`);
  assert.ok(r.warnings.some((w) => w.startsWith('B has')), 'B cannot reach 3 with only 1 slot left — expect warning');
}

// ---- a higher required floor draws the extras (merged: required is the target)
{
  // Old "desired shifts get priority" test. desiredShifts was merged into
  // requiredShifts, so A is now REQUIRED 4 — still reaches 4, just because it
  // is now A's floor/target rather than a soft want. B and C have floor 1.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 4 }), mkUser('b', 'B'), mkUser('c', 'C')],
    [day]
  );
  allMin(db, 1); // B and C floor 1 (old global minShifts: 1); A keeps its 4
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-06' });
  assert.strictEqual(r.counts['a'], 4, `A required 4, got ${r.counts['a']}`);
  assert.strictEqual(r.counts['b'] + r.counts['c'], 2);
}

// ---- overnight shifts distributed evenly
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [night]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-04' });
  assert.strictEqual(r.counts['a'], 2, 'overnights uneven');
  assert.strictEqual(r.counts['b'], 2, 'overnights uneven');
}

// ---- rotation cursor advances and is returned
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.meta.rotationCursor = 1;
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-03' });
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
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-02' });
  assert.ok(r.assignments.some((x) => x.userId === 'b' && x.date === '2026-06-01'), 'preferred-off worker should cover when alone');
  assert.ok(r.warnings.some((w) => w.includes('despite preferring')), 'missing override warning');
}

// ---- per-block roster: excluded people get no shifts and no warnings
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')], [day]);
  allMin(db, 2); // a, b (and the excluded c) all have a floor of 2
  const r = generateSchedule(db, {
    startDate: '2026-06-01', endDate: '2026-06-04', userIds: ['a', 'b'],
  });
  assert.strictEqual(r.counts['c'] || 0, 0, 'excluded user was scheduled');
  assert.ok(!r.warnings.some((w) => w.startsWith('C ')), 'excluded user should not trigger minimum warnings');
  assert.strictEqual(r.counts['a'] + r.counts['b'], 4, 'included users cover all slots');
}

// ===== preference anti-gaming =====

const D = (n: number) => `2026-07-${String(n).padStart(2, '0')}`; // July 2026 dates
const pref = (uid: string, n: number): TimeOff => ({ id: `p-${uid}-${n}`, userId: uid, date: D(n), type: 'preferred' });
const JULY = { startDate: '2026-07-01', endDate: '2026-07-14', userIds: null };

// ---- cap threshold: everyone asks 2, one asks 3 -> untouched (SD floor of 1 day)
{
  const users = [...'abcdefgh'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
  for (const u of users) for (let n = 1; n <= 2; n++) timeOff.push(pref(u.id, n));
  timeOff.push(pref('h', 3)); // H asks one more than everyone
  const db = mkDb(users, [day], timeOff);
  const { caps } = computeCaps(db, JULY);
  assert.deepStrictEqual(caps, {}, 'one extra day must not trigger the cap');
}

// ---- cap threshold: 9 asks vs roster norm ~2 -> capped, requested-order kept
{
  const users = [...'abcdefgh'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
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
  const timeOff: TimeOff[] = [];
  for (let n = 1; n <= 8; n++) timeOff.push(pref('a', n));
  timeOff.push(pref('b', 7), pref('b', 8));
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day], timeOff);
  const r = generateSchedule(db, { startDate: '2026-07-01', endDate: '2026-07-10' });
  for (const d of [D(7), D(8)]) {
    const a = r.assignments.find((x) => x.date === d);
    assert.strictEqual(a!.userId, 'a', `demoted claim (A) must lose to normal preference (B) on ${d}`);
  }
  // Days 9-10: neither prefers; both available; loads decide — no assertion needed.
  // Days 1-6: A's full-strength preference vs B free -> B works all of them.
  for (let n = 1; n <= 6; n++) {
    const a = r.assignments.find((x) => x.date === D(n));
    assert.strictEqual(a!.userId, 'b', `A's protected preferred day ${D(n)} should go to B`);
  }
}

// ---- standing trajectories
{
  const mkBlock = (i: number, asks: Record<string, number>, med: number) => ({
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
  db.schedules = history as unknown as typeof db.schedules;
  const r = generateSchedule(db, { startDate: '2026-07-01', endDate: '2026-07-01' });
  assert.strictEqual(r.assignments[0].userId, 'a', 'lower standing must be overridden first');
}

// ---- generation snapshots raw asks for future standing
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day], [pref('a', 1), pref('a', 2)]);
  const r = generateSchedule(db, { startDate: '2026-07-01', endDate: '2026-07-07' });
  assert.deepStrictEqual(r.preferenceStats.asks, { a: 2, b: 0 });
  assert.strictEqual(r.preferenceStats.median, 1);
}

// ===== shift runs =====

// helper: walk a single shift type's assignments in date order, return run lengths
function runLengths(assignments: Assignment[], shiftTypeId: string) {
  const days = assignments
    .filter((a) => a.shiftTypeId === shiftTypeId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const runs: number[] = [];
  let curUser: string | null = null, len = 0, prevDate: string | null = null;
  for (const a of days) {
    const consecutive = prevDate && new Date(a.date).getTime() - new Date(prevDate).getTime() === 86400000;
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
  const chemo: ShiftType = { id: 'chemo', name: 'Chemo', startTime: '09:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 4 };
  const users = [mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')];
  const db = mkDb(users, [chemo]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-08' });
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
  const chemo: ShiftType = { id: 'chemo', name: 'Chemo', startTime: '09:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 5, maxRun: 7 };
  const users = [...'abcdef'].map((c) => mkUser(c, c.toUpperCase()));
  const db = mkDb(users, [chemo]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-21' });
  const distinct = new Set(r.assignments.map((a) => a.userId)).size;
  assert.ok(distinct >= 3, `21 days of runs ≤7 should touch ≥3 people, not monopolize; got ${distinct}`);
  assert.ok(Math.max(...runLengths(r.assignments, 'chemo')) <= 7, 'runs must respect maxRun 7');
}

// ---- personal night cap (cross-type) via the exported helper
{
  const n1 = { id: 'n1', name: 'N1', startTime: '22:00', endTime: '06:00' } as ShiftType;
  const n2 = { id: 'n2', name: 'N2', startTime: '20:00', endTime: '04:00' } as ShiftType;
  const dayShift = { id: 'd', name: 'D', startTime: '08:00', endTime: '16:00' } as ShiftType;
  const shiftById = { n1, n2, d: dayShift };
  const u = mkUser('a', 'A', { maxConsecutiveNights: 2 });
  const held = [
    { date: '2026-08-01', shiftTypeId: 'n1' },
    { date: '2026-08-02', shiftTypeId: 'n1' },
  ] as Assignment[];
  assert.ok(!nightCapOk(u, held, shiftById, '2026-08-03', n2), 'a different overnight type must still hit the cap');
  assert.ok(!nightCapOk(u, held, shiftById, '2026-08-03', n1), 'same overnight type hits the cap');
  assert.ok(nightCapOk(u, held, shiftById, '2026-08-03', dayShift), 'a day shift is never capped');
  assert.ok(nightCapOk(u, held, shiftById, '2026-08-04', n2), 'a gap day resets the streak');
  assert.ok(nightCapOk(mkUser('b', 'B'), held, shiftById, '2026-08-03', n1), 'no cap set = always ok');
}

// ---- night cap end to end: one capped worker leaves a slot open rather than over-work
{
  const night: ShiftType = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A', { maxConsecutiveNights: 2 })], [night]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-04' });
  // A works nights 1 and 2, must rest night 3 (would be the 3rd in a row), works night 4.
  assert.ok(!r.assignments.some((a) => a.date === '2026-08-03'), 'the 3rd consecutive night must not be assigned');
  assert.strictEqual(r.unfilled.filter((s) => s.date === '2026-08-03').length, 1, 'night 3 should be open');
}

// ===== maximum shifts =====

// ---- effective max resolution: per-user override, else unlimited
{
  const db = { users: [mkUser('a', 'A', { maxShiftsOverride: 2 }), mkUser('b', 'B')] } as Db;
  const maxs = effectiveMaximums(db);
  assert.strictEqual(maxs.get('a'), 2, 'override sets the ceiling');
  assert.strictEqual(maxs.get('b'), Infinity, 'no override = unlimited');
}

// ---- a per-user max is a hard cap; uncoverable slots go open
{
  // Old "block max is a hard cap" test: the global maxShifts: 3 is now a
  // per-user maxShiftsOverride: 3 on everyone.
  const db = mkDb([mkUser('a', 'A', { maxShiftsOverride: 3 }), mkUser('b', 'B', { maxShiftsOverride: 3 })], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10' });
  assert.ok(Object.values(r.counts).every((c) => c <= 3), `nobody may exceed 3: ${JSON.stringify(r.counts)}`);
  assert.strictEqual(r.assignments.length, 6, 'two people × max 3 = 6 assignments');
  assert.strictEqual(r.unfilled.length, 4, 'remaining 4 slots must go open');
}

// ---- a lower per-user override caps that person independently of others
{
  // Old "per-employee override wins over the block max": A override 1, the
  // former block max 3 is now B's own override 3.
  const db = mkDb([mkUser('a', 'A', { maxShiftsOverride: 1 }), mkUser('b', 'B', { maxShiftsOverride: 3 })], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10' });
  assert.strictEqual(r.counts['a'], 1, `A capped at override 1, got ${r.counts['a']}`);
  assert.strictEqual(r.counts['b'], 3, `B capped at override 3, got ${r.counts['b']}`);
}

// ---- a ceiling below the floor lowers the floor (no impossible-minimum warnings)
{
  // Old global minShifts: 5, maxShifts: 2 -> per-user required 5, max 2.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 5, maxShiftsOverride: 2 }),
     mkUser('b', 'B', { requiredShifts: 5, maxShiftsOverride: 2 })],
    [day]
  );
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10' });
  assert.ok(Object.values(r.counts).every((c) => c === 2), `everyone hits exactly the cap: ${JSON.stringify(r.counts)}`);
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), `no min warnings when capped below the floor: ${JSON.stringify(r.warnings)}`);
}

// ---- a high required floor beyond the cap doesn't warn (clamped to the cap)
{
  // Old "desired shifts beyond the cap don't warn": desiredShifts: 6 is merged
  // into requiredShifts: 6, capped by maxShiftsOverride: 2. A reaches the cap
  // and no shortfall warning fires (the floor is clamped to the ceiling).
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 6, maxShiftsOverride: 2 }), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10' });
  assert.strictEqual(r.counts['a'], 2);
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), 'no shortfall warning past the cap');
}

// ===== per-shift-type weights =====

// ---- weight-0 shifts don't count toward minimums (but are still assigned)
{
  const standby: ShiftType = { id: 'sb', name: 'Standby', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, weight: 0 };
  const work: ShiftType = { id: 'wk', name: 'Work', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [work, standby]);
  allMin(db, 2); // both have a floor of 2 counting shifts (old global minShifts: 2)
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-04' });
  assert.strictEqual(r.assignments.length, 8, 'standby slots are still filled');
  assert.strictEqual(r.counts['a'], 2, `counts exclude standby: ${JSON.stringify(r.counts)}`);
  assert.strictEqual(r.counts['b'], 2, `counts exclude standby: ${JSON.stringify(r.counts)}`);
  assert.ok(!r.warnings.some((w) => w.includes('minimum')), 'minimums met by counting shifts only');
}

// ---- weight-0 shifts don't eat the maximum
{
  const standby: ShiftType = { id: 'sb', name: 'Standby', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, weight: 0 };
  const work: ShiftType = { id: 'wk', name: 'Work', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A', { maxShiftsOverride: 1 }), mkUser('b', 'B', { maxShiftsOverride: 1 })], [work, standby]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-04' });
  const standbyAssigned = r.assignments.filter((a) => a.shiftTypeId === 'sb').length;
  assert.strictEqual(standbyAssigned, 4, 'all standby slots fill despite max 1');
  const workAssigned = r.assignments.filter((a) => a.shiftTypeId === 'wk').length;
  assert.strictEqual(workAssigned, 2, 'counting shifts capped at 1 each: 2 of 4 work slots fill');
  assert.strictEqual(r.unfilled.length, 2, 'the other 2 work slots go open');
}

// ---- custom weights steer load balancing
{
  const heavy: ShiftType = { id: 'hv', name: 'Heavy', startTime: '08:00', endTime: '16:00', frequency: 'weekly', dayOfWeek: 1, staffRequired: 1, weight: 3 };
  const light: ShiftType = { id: 'lt', name: 'Light', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  // 2026-06-01 is a Monday: 1 heavy (weight 3) + 7 light (weight 1) over a week.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [heavy, light]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  const heavyUser = r.assignments.find((a) => a.shiftTypeId === 'hv')!.userId;
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
  const t1: ShiftType = { id: 't1', name: 'Top', startTime: '08:00', endTime: '12:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 4 };
  const t2: ShiftType = { id: 't2', name: 'Bottom', startTime: '13:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 4 };
  const filler: ShiftType = { id: 'u0', name: 'Filler', startTime: '18:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };

  const runStats = (assignments: Assignment[], typeId: string) => {
    const runs = runLengths(assignments, typeId);
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    return { runs, mean };
  };

  for (const order of [[t1, t2, filler], [t2, t1, filler]]) {
    const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')], order);
    const r = generateSchedule(db, { startDate: '2026-08-02', endDate: '2026-08-19' });
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
  const W: ShiftType = { id: 'w', name: 'W', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  // B is away days 1-5 so A works a 5-day stretch; A is away day 6 so B covers.
  // Day 7: A has the higher load (5 vs 1) AND owes a recovery day, so rested B
  // wins. (desiredShifts was removed; with no required floor on either, the
  // recovery penalty and load balance decide — recovery still beats A here.)
  const timeOff: TimeOff[] = [];
  for (let n = 1; n <= 5; n++) timeOff.push({ id: `v${n}`, userId: 'b', date: `2026-09-0${n}`, type: 'vacation' });
  timeOff.push({ id: 'va', userId: 'a', date: '2026-09-06', type: 'vacation' });
  const db = mkDb([mkUser('a', 'A', { requiredShifts: null }), mkUser('b', 'B')], [W], timeOff);
  const r = generateSchedule(db, { startDate: '2026-09-01', endDate: '2026-09-07' });
  const day7 = r.assignments.find((x) => x.date === '2026-09-07');
  assert.strictEqual(day7!.userId, 'b', 'rested B must beat early-returning A on day 7');
}

// ---- soft: when only the unrested person exists, the slot still fills (+ warning)
{
  const W: ShiftType = { id: 'w', name: 'W', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const timeOff: TimeOff[] = [];
  for (let n = 1; n <= 7; n++) timeOff.push({ id: `v${n}`, userId: 'b', date: `2026-09-0${n}`, type: 'vacation' });
  timeOff.push({ id: 'va', userId: 'a', date: '2026-09-06', type: 'vacation' });
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [W], timeOff);
  const r = generateSchedule(db, { startDate: '2026-09-01', endDate: '2026-09-07' });
  const day7 = r.assignments.find((x) => x.date === '2026-09-07');
  assert.strictEqual(day7?.userId, 'a', 'coverage beats recovery when nobody else can work');
  assert.ok(
    r.warnings.some((w) => w.includes('only 1 day off after a 5-day stretch')),
    `missing recovery warning: ${JSON.stringify(r.warnings)}`
  );
}

// ---- chaining a different shift type right after a run is discouraged
{
  const G: ShiftType = { id: 'g', name: 'G', startTime: '09:00', endTime: '17:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, minRun: 3, maxRun: 3 };
  const X: ShiftType = { id: 'x', name: 'X', startTime: '18:00', endTime: '22:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B'), mkUser('c', 'C')], [G, X]);
  const r = generateSchedule(db, { startDate: '2026-09-01', endDate: '2026-09-04' });
  // A's G run is days 1-3; A must not be handed the X shift on day 4 with zero
  // days off after a 3-day stretch — a rested teammate takes it instead.
  // (desiredShifts was removed; the recovery penalty alone keeps A off day 4.)
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
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 5 })], [day], [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-03', type: 'vacation' },
  ]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  assert.strictEqual(r.counts['a'], 3, 'works the other 3 days');
  assert.deepStrictEqual(chargedBy(r), { a: 2 }, 'the 2 must-off days are charged');
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), 'covered shortfall does not warn');
}

// ---- uncovered shortfall still warns with charge-aware copy
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  allMin(db, 4); // both required 4 (old global minShifts: 4)
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-04' });
  assert.deepStrictEqual(chargedBy(r), {}, 'no must-offs -> no charges');
  assert.strictEqual(
    r.warnings.filter((w) => w.includes('2 short')).length, 2,
    `both 2 short of 4: ${JSON.stringify(r.warnings)}`
  );
}

// ---- unaffordable must-offs downgrade to strong-but-soft claims
{
  const timeOff: TimeOff[] = [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-03', type: 'vacation' },
    { id: 'm3', userId: 'a', date: '2026-06-04', type: 'vacation' },
    { id: 'mb', userId: 'b', date: '2026-06-03', type: 'vacation' }, // b is hard-off the 3rd
  ];
  const db = mkDb([mkUser('a', 'A', { vacationDays: 1 }), mkUser('b', 'B')], [day], timeOff);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
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

// ---- a downgraded must-off day the person ends up working is never charged
{
  const timeOff: TimeOff[] = [
    { id: 'm1', userId: 'a', date: '2026-12-30', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-12-31', type: 'vacation' },
    { id: 'm3', userId: 'a', date: '2027-01-01', type: 'vacation' },
    { id: 'mb', userId: 'b', date: '2026-12-30', type: 'vacation' }, // b is hard-off the 30th
  ];
  // 2 must-offs in 2026 against a 1-day 2026 balance, and 1 in 2027 with
  // 2027's day already spent -> every one of a's goes soft.
  // a starts on the 30th, so at most 4 of their 5 required are workable and
  // they're scheduled over every downgraded day: still 1 short, but no day
  // they took off caused it, so nothing is charged (it warns instead).
  const db = mkDb([
    mkUser('a', 'A', { vacationDays: 1, requiredShifts: 5, startDate: '2026-12-30' }),
    mkUser('b', 'B', { requiredShifts: 2 }),
  ], [day], timeOff);
  db.schedules.push({
    id: 'prior', startDate: '2027-02-01', endDate: '2027-02-14', createdAt: '', userIds: ['a'],
    assignments: [], unfilled: [], counts: {}, warnings: [],
    vacationCharges: [{ userId: 'a', date: '2027-02-02', cause: 'shortfall' }],
  } as any);
  const r = generateSchedule(db, { startDate: '2026-12-29', endDate: '2027-01-02' });
  const worked = new Set(r.assignments.filter((x) => x.userId === 'a').map((x) => x.date));
  for (const d of ['2026-12-30', '2026-12-31', '2027-01-01'])
    assert.ok(worked.has(d), `a is scheduled over the downgraded ${d}`);
  const dates = (r.vacationCharges || []).filter((c) => c.userId === 'a').map((c) => c.date);
  assert.deepStrictEqual(dates, [], `no charge on a day a worked: ${dates}`);
  assert.ok(r.warnings.some((w) => w.startsWith('A has 4 of 5')), `the shortfall warns instead: ${JSON.stringify(r.warnings)}`);
}

// ===== per-employee required & max shifts (new feature) =====

// ---- (1) per-user requiredShifts drives each person's floor independently
{
  // 7 day-slots over a week; A required 2, B required 4. Each reaches their own
  // floor, and the spare slot doesn't push anyone past their target.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 2 }), mkUser('b', 'B', { requiredShifts: 4 })],
    [day]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  assert.ok(r.counts['a'] >= 2, `A should reach its own floor of 2, got ${r.counts['a']}`);
  assert.ok(r.counts['b'] >= 4, `B should reach its own floor of 4, got ${r.counts['b']}`);
  assert.ok(
    !r.warnings.some((w) => /minimum shifts/.test(w)),
    `both floors are satisfiable: ${JSON.stringify(r.warnings)}`
  );
}

// ---- (2) per-user maxShiftsOverride caps each person independently
{
  // 10 day-slots. A is capped at 2; B has no cap and soaks up the rest.
  const db = mkDb(
    [mkUser('a', 'A', { maxShiftsOverride: 2 }), mkUser('b', 'B')],
    [day]
  );
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10' });
  assert.strictEqual(r.counts['a'], 2, `A must never exceed its max of 2, got ${r.counts['a']}`);
  assert.ok(r.counts['b'] > 2, `uncapped B should go higher than A's cap, got ${r.counts['b']}`);
  assert.strictEqual(r.counts['a'] + r.counts['b'], 10, 'all 10 slots fill (B covers the remainder)');
}

// ---- (3) blank required (null) = 0: no shortfall warning, no vacation charged
{
  // A has a real floor and a must-off; B has blank required and a must-off.
  // Only A should ever be warned/charged; B's null required is 0.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 5 }), mkUser('b', 'B', { requiredShifts: null })],
    [day],
    [
      { id: 'ma', userId: 'a', date: '2026-06-02', type: 'vacation' },
      { id: 'mb', userId: 'b', date: '2026-06-02', type: 'vacation' },
    ]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-03' });
  assert.ok(!r.warnings.some((w) => w.startsWith('B has')), `blank-required B gets no shortfall warning: ${JSON.stringify(r.warnings)}`);
  assert.strictEqual(chargedBy(r)['b'], undefined, 'no vacation charged to a user with no required floor');
}

// ---- (4) requiredShifts > maxShiftsOverride is clamped to the max (no warning)
{
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 8, maxShiftsOverride: 3 }), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-08-01', endDate: '2026-08-10' });
  assert.strictEqual(r.counts['a'], 3, `effective floor clamps to the max of 3, got ${r.counts['a']}`);
  assert.ok(
    !r.warnings.some((w) => w.startsWith('A has')),
    `no warning for failing to reach the impossible required: ${JSON.stringify(r.warnings)}`
  );
}

// ---- (5) vacation charging uses per-user required (vacationCharged map)
{
  // A requires 5 over a 5-day block but files 2 must-off days inside it, so A
  // can only work 3. The 2-day shortfall is charged to vacation.
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 5, vacationDays: 10 })], [day], [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-04', type: 'vacation' },
  ]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  assert.strictEqual(r.counts['a'], 3, 'A works the 3 non-must-off days');
  assert.deepStrictEqual(chargedBy(r), { a: 2 }, 'the 2 must-off shortfall days are charged as vacation');
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), 'charged shortfall does not also warn');
}

// ---- (5b) vacation charge is capped by the per-user max
{
  // A requires 5 but is capped at 3 (effective floor 3); files 4 must-offs over
  // a 7-day block. Works 3, shortfall against the clamped floor of 3 is 0 -> no
  // charge. (Charge follows the clamped required, not the raw 5.)
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 5, maxShiftsOverride: 3, vacationDays: 10 })], [day], [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-03', type: 'vacation' },
    { id: 'm3', userId: 'a', date: '2026-06-05', type: 'vacation' },
  ]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  // 7 days minus 3 must-off = 4 workable, capped at 3 -> A works 3, meets the
  // clamped floor of 3, so nothing is charged.
  assert.strictEqual(r.counts['a'], 3, `A capped at 3, got ${r.counts['a']}`);
  assert.deepStrictEqual(chargedBy(r), {}, 'no charge once the clamped floor is met');
}

// ---- (6) effectiveMaximums / effectiveMinimums
{
  const db = mkDb(
    [mkUser('a', 'A', { maxShiftsOverride: 4, requiredShifts: 3 }),
     mkUser('b', 'B', { maxShiftsOverride: null, requiredShifts: 2 })],
    [day],
    [{ id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' }]
  );
  const maxs = effectiveMaximums(db);
  assert.strictEqual(maxs.get('a'), 4, 'set override returns the number');
  assert.strictEqual(maxs.get('b'), Infinity, 'blank/null override returns Infinity');

  const mins = effectiveMinimums(db, { startDate: '2026-06-01', endDate: '2026-06-07' }, new Set());
  assert.strictEqual(mins.get('a'), 2, "A's required 3 minus 1 must-off day = 2");
  assert.strictEqual(mins.get('b'), 2, "B's required 2 with no must-offs = 2");

  // Downgraded (soft) must-off days don't reduce required.
  const minsSoft = effectiveMinimums(db, { startDate: '2026-06-01', endDate: '2026-06-07' }, new Set(['a|2026-06-02']));
  assert.strictEqual(minsSoft.get('a'), 3, 'a soft must-off day does not subtract');
}

// ---- (8) regression: desiredShifts is no longer consulted
{
  // The removed soft target must not raise a floor or produce a warning. A has
  // a stale desiredShifts: 9 and a blank required; B is a normal teammate.
  const db = mkDb(
    [mkUser('a', 'A', { desiredShifts: 9, requiredShifts: null }), mkUser('b', 'B')],
    [day]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  assert.ok(
    !r.warnings.some((w) => w.startsWith('A has') || w.includes('requested')),
    `desiredShifts must not create any floor/target warning: ${JSON.stringify(r.warnings)}`
  );
}

// ===== start date & away time (new feature) =====

// ---- (1) isBeforeStart boundaries
{
  assert.strictEqual(isBeforeStart(mkUser('a', 'A'), '2026-06-03'), false, 'no startDate is never "before start"');
  assert.strictEqual(isBeforeStart(mkUser('a', 'A', { startDate: '2026-06-10' }), '2026-06-09'), true, 'the day before startDate is before start');
  assert.strictEqual(isBeforeStart(mkUser('a', 'A', { startDate: '2026-06-10' }), '2026-06-10'), false, 'the start date itself is NOT before start (they can work day one)');
  assert.strictEqual(isBeforeStart(mkUser('a', 'A', { startDate: '2026-06-10' }), '2026-06-11'), false, 'a date after startDate is not before start');
  assert.strictEqual(isBeforeStart(mkUser('a', 'A', { startDate: null }), '2026-06-03'), false, 'null startDate is never before start');
}

// ---- (2) isAway boundaries (inclusive)
{
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.awayTime.push({ id: 'aw1', userId: 'a', start: '2026-06-03', end: '2026-06-05' });
  assert.strictEqual(isAway(db, 'a', '2026-06-03'), true, 'the range start is away (inclusive)');
  assert.strictEqual(isAway(db, 'a', '2026-06-05'), true, 'the range end is away (inclusive)');
  assert.strictEqual(isAway(db, 'a', '2026-06-04'), true, 'a date strictly inside the range is away');
  assert.strictEqual(isAway(db, 'a', '2026-06-02'), false, 'the day before the range is not away');
  assert.strictEqual(isAway(db, 'a', '2026-06-06'), false, 'the day after the range is not away');
  assert.strictEqual(isAway(db, 'b', '2026-06-04'), false, "another user's range does not make this user away");
  const empty = mkDb([mkUser('a', 'A')], [day]);
  assert.strictEqual(isAway(empty, 'a', '2026-06-04'), false, 'no awayTime entries -> never away');
}

// ---- (3) start date end-to-end: never scheduled before startDate
{
  // 7 day-slots; A starts mid-block on the 4th, B covers the rest.
  const db = mkDb([mkUser('a', 'A', { startDate: '2026-06-04' }), mkUser('b', 'B')], [day]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  const aDates = r.assignments.filter((x) => x.userId === 'a').map((x) => x.date);
  assert.ok(aDates.every((d) => d >= '2026-06-04'), `A must never be scheduled before their start date: ${aDates}`);
  assert.ok(!aDates.some((d) => d < '2026-06-04'), 'zero pre-start assignments for A');
  assert.ok(aDates.length >= 1, `A should still work on/after their start date: ${aDates}`);
  // Every slot is still covered (B fills the pre-start days).
  assert.strictEqual(r.unfilled.length, 0, 'all slots covered despite a mid-block start date');
}

// ---- (4) away end-to-end + no vacation charge / no allowance reduction
{
  // A is away days 2-4 of a 7-day daily block; B covers those days.
  const db = mkDb([mkUser('a', 'A', { vacationDays: 10 }), mkUser('b', 'B')], [day]);
  db.awayTime.push({ id: 'aw1', userId: 'a', start: '2026-06-02', end: '2026-06-04' });
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  const aDates = r.assignments.filter((x) => x.userId === 'a').map((x) => x.date);
  for (const d of ['2026-06-02', '2026-06-03', '2026-06-04']) {
    assert.ok(!aDates.includes(d), `A must not be scheduled on away day ${d}`);
  }
  assert.strictEqual(chargedBy(r)['a'], undefined, 'away time must NOT charge any vacation');
  assert.strictEqual(
    yearBalance(db, db.users[0], 2026).balance, 10,
    'away time must NOT reduce vacation available (stays at the base vacationDays)'
  );
  assert.strictEqual(r.unfilled.length, 0, 'away days are covered by the available teammate');
}

// ---- (5) a fully-away required worker keeps the full floor (still warns "short")
{
  // A is required 3 but away the ENTIRE block -> ends with 0 counts, no
  // vacation charge, and a shortfall warning (the floor is kept in full).
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 3, vacationDays: 10 }), mkUser('b', 'B')], [day]);
  db.awayTime.push({ id: 'aw1', userId: 'a', start: '2026-06-01', end: '2026-06-07' });
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  assert.strictEqual(r.counts['a'] || 0, 0, 'fully-away A works zero shifts');
  assert.strictEqual(chargedBy(r)['a'], undefined, 'away never charges vacation, even with a required floor');
  assert.ok(
    r.warnings.some((w) => w.startsWith('A has')),
    `fully-away A with a required floor must still produce a shortfall warning: ${JSON.stringify(r.warnings)}`
  );
}

// ---- (6) away + must-off on the same day: away doesn't change must-off charging
{
  // A requires 5 over a 5-day block, files 2 must-off days (vacation type), and
  // one of those days (the 3rd) is ALSO inside an away range. The must-off
  // charging is unchanged: 2 days short -> 2 charged (away neither suppresses
  // nor doubles the must-off's own charge).
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 5, vacationDays: 10 })], [day], [
    { id: 'm1', userId: 'a', date: '2026-06-02', type: 'vacation' },
    { id: 'm2', userId: 'a', date: '2026-06-03', type: 'vacation' },
  ]);
  db.awayTime.push({ id: 'aw1', userId: 'a', start: '2026-06-03', end: '2026-06-03' });
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  const aDates = r.assignments.filter((x) => x.userId === 'a').map((x) => x.date);
  assert.ok(!aDates.includes('2026-06-02') && !aDates.includes('2026-06-03'), 'must-off / away days are not worked');
  assert.strictEqual(r.counts['a'], 3, 'A works the other 3 days');
  assert.deepStrictEqual(
    chargedBy(r), { a: 2 },
    'must-off charging is exactly what the 2 must-offs alone produce; away does not change it'
  );
}

// ---- (7) other employees still get scheduled around an away/pre-start teammate
{
  // A is away the whole block and B has a mid-block start date; C is always
  // available and must cover everything that A and pre-start B cannot — slots
  // are not left needlessly open when someone can cover.
  const db = mkDb(
    [mkUser('a', 'A'), mkUser('b', 'B', { startDate: '2026-06-05' }), mkUser('c', 'C')],
    [day]
  );
  db.awayTime.push({ id: 'aw1', userId: 'a', start: '2026-06-01', end: '2026-06-07' });
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  assert.strictEqual(r.counts['a'] || 0, 0, 'fully-away A works nothing');
  const bDates = r.assignments.filter((x) => x.userId === 'b').map((x) => x.date);
  assert.ok(bDates.every((d) => d >= '2026-06-05'), `B never works before their start date: ${bDates}`);
  assert.strictEqual(r.unfilled.length, 0, 'every slot is covered — none left needlessly open');
  // Days 1-4 (B not yet started, A away) can only go to C; B may pick up some of
  // days 5-7 once available. So C covers at least the 4 pre-start days.
  assert.ok(r.counts['c'] >= 4, `C must cover the 4 days only it can work, got ${r.counts['c']}`);
  assert.strictEqual(r.counts['b'] + r.counts['c'], 7, 'B (from its start date) and C together cover all 7 slots');
}

// ===== custom employee roles (new feature) =====

// ---- hasRequiredRole boundaries
{
  const plain = mkUser('a', 'A');                                  // ['role-employee']
  const mgr = mkUser('m', 'M', { roles: ['role-employee', 'role-mgr'] });
  assert.strictEqual(hasRequiredRole(plain, { allowedRoles: [] }), true, 'empty allowedRoles = anyone');
  assert.strictEqual(hasRequiredRole(plain, {}), true, 'absent allowedRoles = anyone');
  assert.strictEqual(hasRequiredRole(mgr, { allowedRoles: ['role-mgr'] }), true, 'a role-holder is allowed');
  assert.strictEqual(hasRequiredRole(plain, { allowedRoles: ['role-mgr'] }), false, 'a non-holder is blocked');
  assert.strictEqual(hasRequiredRole({ ...plain, roles: [] }, { allowedRoles: ['role-mgr'] }), false, 'no roles = blocked when restricted');
}

const mgrShift: ShiftType = { id: 'mgr', name: 'Manager', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, allowedRoles: ['role-mgr'] };

// ---- a role-restricted shift only goes to employees who hold the role
{
  const db = mkDb(
    [mkUser('m', 'M', { roles: ['role-employee', 'role-mgr'] }), mkUser('e', 'E')],
    [mgrShift]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-03' });
  assert.ok(r.assignments.length > 0, 'manager shifts are filled');
  assert.ok(r.assignments.every((a) => a.userId === 'm'), `only the role-holder fills it: ${JSON.stringify(r.counts)}`);
  assert.ok(!r.assignments.some((a) => a.userId === 'e'), 'a non-holder is never assigned a role-restricted shift');
  assert.strictEqual(r.unfilled.length, 0, 'the role-holder covers every day');
}

// ---- empty allowedRoles is open to everyone (regression)
{
  const open: ShiftType = { ...mgrShift, id: 'open', allowedRoles: [] };
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [open]);
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-04' });
  assert.strictEqual(r.unfilled.length, 0, 'an unrestricted shift fills');
  assert.ok(r.assignments.every((a) => a.userId === 'a' || a.userId === 'b'), 'anyone may fill an unrestricted shift');
}

// ---- a role-restricted shift with no eligible employee goes unfilled (no crash)
{
  const db = mkDb([mkUser('e', 'E')], [mgrShift]); // nobody holds role-mgr
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-02' });
  assert.strictEqual(r.assignments.length, 0, 'no eligible employee -> nothing assigned');
  assert.strictEqual(r.unfilled.length, 2, 'both days go open');
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes('open shift')), `open-shift warning expected: ${JSON.stringify(r.warnings)}`);
}

// ---- the repair pass never donates a role-restricted shift to an ineligible under-min user
{
  const db = mkDb(
    [mkUser('m', 'M', { roles: ['role-employee', 'role-mgr'] }), mkUser('e', 'E', { requiredShifts: 2 })],
    [mgrShift]
  );
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  assert.strictEqual(r.counts['e'] || 0, 0, 'ineligible E gets nothing even though it is under its minimum');
  assert.ok(r.warnings.some((w) => w.includes('E has')), `E is reported short (floor kept): ${JSON.stringify(r.warnings)}`);
}

// ===== holidays (new feature) =====

// Holidays now carry a recurrence rule. These scheduler tests pin specific
// calendar dates, so a one-off recurrence is the faithful fixture shape.
const oneOff = (id: string, name: string, date: string, workable: boolean) =>
  ({ id, name, workable, recurrence: { type: 'one-off' as const, date } });

// ---- (1) a non-workable (closed) holiday produces NO slots at all
{
  // 5-day daily block; the 3rd is a closed holiday. That date should have
  // neither an assignment nor an unfilled slot — the slot must not exist.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.holidays = [oneOff('h1', 'Closed Day', '2026-06-03', false)];
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  assert.ok(
    !r.assignments.some((x) => x.date === '2026-06-03'),
    'a closed holiday must have no assignments'
  );
  assert.ok(
    !r.unfilled.some((x) => x.date === '2026-06-03'),
    'a closed holiday must not even produce an (unfilled) slot'
  );
  // The 4 other days are all covered.
  assert.strictEqual(r.assignments.length, 4, 'the other 4 days are staffed');
  for (const d of ['2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05']) {
    assert.ok(r.assignments.some((x) => x.date === d), `non-holiday day ${d} is staffed`);
  }
}

// ---- (2) a workable holiday IS staffed
{
  // Same setup as (1) but the holiday is workable -> the date is assigned.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.holidays = [oneOff('h1', 'Open Day', '2026-06-03', true)];
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  assert.ok(
    r.assignments.some((x) => x.date === '2026-06-03'),
    'a workable holiday must be staffed'
  );
  assert.strictEqual(r.assignments.length, 5, 'all 5 days (incl. the workable holiday) are staffed');
}

// ---- (3) holiday fairness within one run: two workable holidays go to two people
{
  // 2 employees, daily staffRequired 1, a long block with two workable holidays
  // and plenty of ordinary days so totals don't force the split. The two holiday
  // dates must be worked by two DIFFERENT employees.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.holidays = [
    oneOff('h1', 'Holiday One', '2026-06-05', true),
    oneOff('h2', 'Holiday Two', '2026-06-12', true),
  ];
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-14' });
  const h1 = r.assignments.find((x) => x.date === '2026-06-05');
  const h2 = r.assignments.find((x) => x.date === '2026-06-12');
  assert.ok(h1 && h2, 'both workable holidays are staffed');
  assert.notStrictEqual(
    h1!.userId, h2!.userId,
    `two workable holidays should be shared between two people (got ${h1!.userId} and ${h2!.userId})`
  );
}

// ---- (4) holiday fairness across runs: a seeded prior schedule steers the next
{
  // A prior schedule (same calendar year) has A working the only holiday in it.
  // Generating a NEW block with one workable holiday should hand it to B.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.holidays = [
    oneOff('h1', 'Past Holiday', '2026-05-04', true),
    oneOff('h2', 'Next Holiday', '2026-06-04', true),
  ];
  // Prior schedule: A worked the 2026-05-04 holiday. (year = startDate.slice(0,4))
  db.schedules = [{
    id: 's-prior', createdAt: '2026-05-01T00:00:00Z',
    startDate: '2026-05-01', endDate: '2026-05-07',
    userIds: ['a', 'b'],
    assignments: [{ date: '2026-05-04', shiftTypeId: 'day', userId: 'a' }],
    unfilled: [], counts: { a: 1, b: 0 }, warnings: [],
  }] as unknown as typeof db.schedules;
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  const hol = r.assignments.find((x) => x.date === '2026-06-04');
  assert.ok(hol, 'the new workable holiday is staffed');
  assert.strictEqual(
    hol!.userId, 'b',
    'the holiday should go to B, who has no prior holiday history this year'
  );
}

// ---- (5) a must-have-off (vacation) beats holiday fairness
{
  // B is the fairness-preferred pick (A already worked a prior holiday), but B
  // files a must-off on the new holiday -> A must work it instead.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day], [
    { id: 'm1', userId: 'b', date: '2026-06-04', type: 'vacation' },
  ]);
  db.holidays = [
    oneOff('h1', 'Past Holiday', '2026-05-04', true),
    oneOff('h2', 'Next Holiday', '2026-06-04', true),
  ];
  db.schedules = [{
    id: 's-prior', createdAt: '2026-05-01T00:00:00Z',
    startDate: '2026-05-01', endDate: '2026-05-07',
    userIds: ['a', 'b'],
    assignments: [{ date: '2026-05-04', shiftTypeId: 'day', userId: 'a' }],
    unfilled: [], counts: { a: 1, b: 0 }, warnings: [],
  }] as unknown as typeof db.schedules;
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  const hol = r.assignments.find((x) => x.date === '2026-06-04');
  assert.ok(hol, 'the workable holiday is still staffed');
  assert.strictEqual(
    hol!.userId, 'a',
    "B's must-have-off beats fairness; A covers the holiday despite prior history"
  );
}

// ---- (6) gating: holiday history must not skew NON-holiday days
{
  // One workable holiday plus ordinary days. We compare two runs that differ
  // ONLY in seeded holiday history (A worked a prior holiday in the second run).
  // The fairness signal is gated to holiday dates, so per-user TOTALS on
  // non-holiday days must be identical between the two runs — only the holiday
  // date's owner may differ.
  const mkRun = (withHistory: boolean) => {
    const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
    db.holidays = [
      oneOff('hp', 'Past', '2026-05-04', true),
      oneOff('hn', 'Next', '2026-06-04', true),
    ];
    if (withHistory) {
      db.schedules = [{
        id: 's-prior', createdAt: '2026-05-01T00:00:00Z',
        startDate: '2026-05-01', endDate: '2026-05-07', userIds: ['a', 'b'],
        assignments: [{ date: '2026-05-04', shiftTypeId: 'day', userId: 'a' }],
        unfilled: [], counts: { a: 1, b: 0 }, warnings: [],
      }] as unknown as typeof db.schedules;
    }
    return generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-07' });
  };
  const base = mkRun(false);
  const hist = mkRun(true);
  // Tally assignments per user on NON-holiday dates only.
  const nonHolTotals = (r: ReturnType<typeof generateSchedule>) => {
    const out: Record<string, number> = { a: 0, b: 0 };
    for (const x of r.assignments) if (x.date !== '2026-06-04') out[x.userId]++;
    return out;
  };
  assert.deepStrictEqual(
    nonHolTotals(hist), nonHolTotals(base),
    'introducing holiday history must not change non-holiday-day totals'
  );
  // And the gated signal *does* move the holiday's owner toward B.
  const holOwner = hist.assignments.find((x) => x.date === '2026-06-04')!.userId;
  assert.strictEqual(holOwner, 'b', 'with history, the holiday goes to the fairer pick (B)');
}

// ---- (7) below-required prioritization with reqN >= 2 levels up evenly
{
  // holidaysRequiredPerYear = 2, two employees, three workable holidays. Work
  // should level up evenly: nobody reaches 2 holidays while the other is still
  // at 0 (the "still below required" tier keeps both climbing together).
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.settings.holidaysRequiredPerYear = 2;
  db.holidays = [
    oneOff('h1', 'H1', '2026-06-03', true),
    oneOff('h2', 'H2', '2026-06-09', true),
    oneOff('h3', 'H3', '2026-06-15', true),
  ];
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-18' });
  const holUsers = ['2026-06-03', '2026-06-09', '2026-06-15'].map(
    (d) => r.assignments.find((x) => x.date === d)!.userId
  );
  const worked: Record<string, number> = { a: 0, b: 0 };
  for (const u of holUsers) worked[u]++;
  // With 3 holidays and 2 people, the only even split is 2/1 (or 1/2). The
  // invariant: nobody hits the required 2 while the other is still at 0.
  assert.ok(
    !((worked.a >= 2 && worked.b === 0) || (worked.b >= 2 && worked.a === 0)),
    `holidays should level up evenly, not stack on one person: ${JSON.stringify(worked)}`
  );
  // Concretely the first two distinct holidays must go to two different people.
  assert.notStrictEqual(holUsers[0], holUsers[1], 'the first two holidays are shared before anyone repeats');
}

// ---- (8) a RECURRING holiday rule resolves into the generated range
{
  // A yearly holiday on June 3 (no explicit year) must be honored when a 2026
  // block spans it: non-workable -> the date has no slot.
  const db = mkDb([mkUser('a', 'A'), mkUser('b', 'B')], [day]);
  db.holidays = [{ id: 'hy', name: 'Founders Day', workable: false, recurrence: { type: 'yearly', month: 6, day: 3 } }];
  const r = generateSchedule(db, { startDate: '2026-06-01', endDate: '2026-06-05' });
  assert.ok(!r.assignments.some((x) => x.date === '2026-06-03'), 'a recurring closed holiday suppresses that date');
  assert.ok(!r.unfilled.some((x) => x.date === '2026-06-03'), 'a recurring closed holiday produces no slot');
  assert.strictEqual(r.assignments.length, 4, 'the other 4 days are staffed');
}

// ===== charge-aware rework: heavy askers =====

// October 2026 helpers for the charge-aware fixtures (July's D/pref belong to
// the anti-gaming section above).
const O = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;
const OCT = { startDate: '2026-10-01', endDate: '2026-10-14', userIds: null };
const oPref = (uid: string, n: number): TimeOff => ({ id: `op-${uid}-${n}`, userId: uid, date: O(n), type: 'preferred' });
const oMust = (uid: string, n: number): TimeOff => ({ id: `om-${uid}-${n}`, userId: uid, date: O(n), type: 'vacation' });

// ---- the tuning knob is exported and set to 2 standard deviations
assert.strictEqual(HEAVY_ASKER_STDDEV, 2, 'heavy-asker threshold constant must be 2σ');

// ---- uniform roster: nobody is a heavy asker
{
  // Everyone asks for 2 preferred days. For each user the others' mean is 2
  // with sd 0 (floored to 1), so the threshold is 2 + 2*1 = 4 — nobody clears it.
  const users = [...'abcd'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
  for (const u of users) for (let n = 1; n <= 2; n++) timeOff.push(oPref(u.id, n));
  const heavy = heavyAskers(mkDb(users, [day], timeOff), OCT);
  assert.ok(heavy instanceof Set, 'heavyAskers returns a Set');
  assert.strictEqual(heavy.size, 0, `uniform 2-ask roster has no heavy askers: ${[...heavy]}`);
}

// ---- one extreme over-asker is flagged, and only them
{
  // a asks 9; b, c, d ask 1. For a: others' mean 1, sd 0 -> floored to 1 ->
  // threshold 1 + 2*1 = 3, and 9 > 3. For b: the others include a's 9, so
  // mean ≈ 3.67 and sd ≈ 3.77 -> threshold ≈ 11.2; b's 1 is far below.
  const users = [...'abcd'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
  for (let n = 1; n <= 9; n++) timeOff.push(oPref('a', n));
  for (const id of ['b', 'c', 'd']) timeOff.push(oPref(id, 1));
  const heavy = heavyAskers(mkDb(users, [day], timeOff), OCT);
  assert.deepStrictEqual([...heavy], ['a'], `only the 9-ask outlier is heavy: ${[...heavy]}`);
}

// SD-floor / k-tunability fixture: a asks 3; b, c, d ask 2 each.
const mkQuietRoster = () => {
  const users = [...'abcd'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
  for (let n = 1; n <= 3; n++) timeOff.push(oPref('a', n));
  for (const id of ['b', 'c', 'd']) for (let n = 1; n <= 2; n++) timeOff.push(oPref(id, n));
  return mkDb(users, [day], timeOff);
};

// ---- SD floor: mean+1 on a quiet roster is NOT heavy at the default 2σ
{
  // For a the others' sd is 0, but the floor of 1 day makes the threshold
  // 2 + 2*1 = 4, so a's 3 (one over the norm) stays modest.
  assert.strictEqual(
    heavyAskers(mkQuietRoster(), OCT).size, 0,
    'one ask above a quiet roster must not be heavy (SD floor)'
  );
}

// ---- k is tunable: k=0 flags the top asker, a large k flags nobody
{
  // Same fixture. k=0: a's threshold is the others' mean 2, and 3 > 2 -> heavy
  // (b's 2 sits below the 2.33 mean of [3,2,2], so only a flips). k=10:
  // threshold 2 + 10*1 = 12 -> the set empties. Pins the "easily tunable" knob.
  const db = mkQuietRoster();
  assert.deepStrictEqual([...heavyAskers(db, OCT, 0)], ['a'], 'k=0 must flag the top asker');
  assert.strictEqual(heavyAskers(db, OCT, 10).size, 0, 'k=10 must flag nobody');
}

// ---- range scoping: asks outside [startDate, endDate] don't count
{
  // a has 1 October ask plus 8 September asks; b, c, d have 1 October ask.
  // Scored over October, everyone ties at 1 -> empty. Scored over September,
  // a's 8 vs 0,0,0 -> heavy — proving the September asks were real but scoped out.
  const users = [...'abcd'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
  for (const u of users) timeOff.push(oPref(u.id, 1));
  for (let n = 1; n <= 8; n++) {
    timeOff.push({ id: `sep-a-${n}`, userId: 'a', date: `2026-09-${String(n).padStart(2, '0')}`, type: 'preferred' });
  }
  const db = mkDb(users, [day], timeOff);
  assert.strictEqual(heavyAskers(db, OCT).size, 0, 'out-of-range asks must not count');
  assert.deepStrictEqual(
    [...heavyAskers(db, { startDate: '2026-09-01', endDate: '2026-09-14', userIds: null })],
    ['a'],
    'the same asks DO count inside their own range'
  );
}

// ---- must-off (vacation-type) requests never count toward heaviness
{
  // a files 9 must-offs plus 1 preferred; b, c, d file 1 preferred each. Only
  // PREFERRED asks feed the statistic, so everyone ties at 1 -> empty set.
  const users = [...'abcd'].map((c) => mkUser(c, c.toUpperCase()));
  const timeOff: TimeOff[] = [];
  for (const u of users) timeOff.push(oPref(u.id, 1));
  for (let n = 2; n <= 10; n++) timeOff.push(oMust('a', n));
  assert.strictEqual(
    heavyAskers(mkDb(users, [day], timeOff), OCT).size, 0,
    'vacation-type (must-off) requests must not make someone a heavy asker'
  );
}

// ===== charge-aware rework: charge avoidance =====

// ---- an avoidable charge is eliminated: the at-risk person reaches full required
{
  // 7-day block, one daily slot. A requires 4 but is must-off days 1-3,
  // leaving exactly 4 schedulable days (4-7); B (required 3) is free all week.
  // Without charge awareness A could drift below 4 and settle the gap from
  // vacation; the rework must hand A all 4 of its remaining days: A works 4,
  // B covers days 1-3, nothing goes open, and nobody is charged.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 4 }), mkUser('b', 'B', { requiredShifts: 3 })],
    [day],
    [oMust('a', 1), oMust('a', 2), oMust('a', 3)]
  );
  const r = generateSchedule(db, { startDate: O(1), endDate: O(7) });
  assert.strictEqual(r.counts['a'], 4, `A must reach its full required 4, got ${r.counts['a']}`);
  assert.deepStrictEqual(chargedBy(r), {}, `no vacation may be charged: ${JSON.stringify(chargedBy(r))}`);
  assert.strictEqual(r.unfilled.length, 0, 'coverage stays intact while avoiding the charge');
  assert.ok(!r.warnings.some((w) => w.includes('charged')), 'no charge diagnostics when nothing is charged');
}

// ---- a rescue must never create a NEW charge: a whole donor is never drained
{
  // 5-day block, one daily slot. D (required 3, must-off day 5, balance 5) can
  // work days 1-4; A (required 3, must-off days 1-2, balance 5) can work days
  // 3-5. Five slots cannot cover six owed shifts, so exactly one person ends
  // short. Greedy: D takes days 1-2 alone, A (under its reduced minimum) wins
  // day 3, D wins day 4 on tighter slack (its last schedulable day), A works
  // day 5 -> A is short 1. The only rescue would pull day 4 from D, leaving D
  // at 2 of 3 with a must-off and balance of its own — a brand-new charge. The
  // chain must decline: D stays whole and uncharged; A keeps the single
  // competition-forced charge.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 3, vacationDays: 5 }),
     mkUser('d', 'D', { requiredShifts: 3, vacationDays: 5 })],
    [day],
    [oMust('a', 1), oMust('a', 2), oMust('d', 5)]
  );
  const r = generateSchedule(db, { startDate: O(1), endDate: O(5) });
  assert.strictEqual(r.counts['d'], 3, `donor D must keep its full required count, got ${r.counts['d']}`);
  assert.strictEqual(chargedBy(r)['d'], undefined, 'a rescue must never charge a previously-whole donor');
  assert.deepStrictEqual(chargedBy(r), { a: 1 }, `only A's competitive charge remains: ${JSON.stringify(chargedBy(r))}`);
  assert.strictEqual(r.unfilled.length, 0, 'full coverage');
}

// ---- modest protection: the charge REMAINS rather than override a protected day
{
  // 6-day block, one daily slot. A (required 3, balance 9) is must-off days
  // 1-2 and away day 6 -> schedulable only days 3-5. B (required 1) is away
  // days 1-4 and prefers day 6 off; C (required 3) also prefers day 6 off.
  // Each asks once, so neither is heavy — C's claim on day 6 is a protected
  // modest preference (and so is B's).
  //   Greedy: C alone covers days 1-2, wins day 4 while under its minimum of
  //   3, B takes day 5 (its only... actually its first schedulable day it can
  //   win) and day 6 resolves the B/C claim tie by load -> A ends with 2 of 3.
  //   A's three schedulable days hold one slot each and C still owes 3 total,
  //   so completing A forces someone onto the protected day 6 beyond the slot
  //   B already holds — every rescue permutation dead-ends on the protected
  //   claim. Per the ladder (modest preferred-off > charge avoidance) the
  //   charge must survive and C must keep its preferred day off.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 3, vacationDays: 9 }),
     mkUser('b', 'B', { requiredShifts: 1 }),
     mkUser('c', 'C', { requiredShifts: 3 })],
    [day],
    [oMust('a', 1), oMust('a', 2), oPref('b', 6), oPref('c', 6)]
  );
  db.awayTime.push({ id: 'aw-a', userId: 'a', start: O(6), end: O(6) });
  db.awayTime.push({ id: 'aw-b', userId: 'b', start: O(1), end: O(4) });
  assert.strictEqual(
    heavyAskers(db, { startDate: O(1), endDate: O(6), userIds: null }).size, 0,
    'fixture sanity: both askers must be modest'
  );
  const r = generateSchedule(db, { startDate: O(1), endDate: O(6) });
  assert.deepStrictEqual(
    chargedBy(r), { a: 1 },
    `A's charge must remain rather than override a protected preferred day: ${JSON.stringify(chargedBy(r))}`
  );
  assert.ok(
    !r.assignments.some((x) => x.userId === 'c' && x.date === O(6)),
    "modest C keeps their preferred day off — never consumed for someone else's rescue"
  );
  assert.strictEqual(r.unfilled.length, 0, 'protection never costs coverage');
  assert.ok(
    (r.counts['b'] || 0) >= 1 && (r.counts['c'] || 0) >= 3,
    `no bystander pushed below their requirement: ${JSON.stringify(r.counts)}`
  );
  assert.ok(
    r.warnings.some((w) => w.includes('unresolvable without overriding protected preferred days')),
    `the surviving charge is explained as protection-bound: ${JSON.stringify(r.warnings)}`
  );
}

// Heavy-consumption / determinism fixture: same rescue topology as above but
// with B not asking and C a heavy asker. A (required 3, balance 9) is must-off
// days 1-2 and away day 6; B requires 1; C (required 2) is away days 2-4 and
// prefers day 6 — plus three asks parked on its own away days (2-4), which
// cannot influence the greedy layout but lift C's ask count to 4 vs 0,0:
// threshold 0 + 2*max(0,1) = 2, so C is heavy (yet under computeCaps' 4σ cap
// of 4, so no demotion muddies the claims).
//   Greedy: C covers day 1, B day 2, A wins days 3-4, C day 5 (under minimum),
//   day 6 goes to B (claim 0 beats C's 1.0) -> A short 1 with predicted
//   charge 1. Rescue: A pulls day 5 from C (unprotected), C is left short and
//   backfills from B's day 6 — consumable BECAUSE C is heavy — and B (required
//   1, still holding day 2) stays whole. Result: no charge, C works one of its
//   own (heavy) preferred days, coverage intact.
const mkHeavyRescueDb = () => {
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 3, vacationDays: 9 }),
     mkUser('b', 'B', { requiredShifts: 1 }),
     mkUser('c', 'C', { requiredShifts: 2 })],
    [day],
    [oMust('a', 1), oMust('a', 2), oPref('c', 6), oPref('c', 2), oPref('c', 3), oPref('c', 4)]
  );
  db.awayTime.push({ id: 'aw-a', userId: 'a', start: O(6), end: O(6) });
  db.awayTime.push({ id: 'aw-c', userId: 'c', start: O(2), end: O(4) });
  return db;
};

// ---- heavy consumption: a heavy asker's preferred day IS consumable for a rescue
{
  const db = mkHeavyRescueDb();
  assert.ok(
    heavyAskers(db, { startDate: O(1), endDate: O(6), userIds: null }).has('c'),
    'fixture sanity: C must be a heavy asker'
  );
  const r = generateSchedule(db, { startDate: O(1), endDate: O(6) });
  assert.deepStrictEqual(chargedBy(r), {}, `the rescue must clear A's charge: ${JSON.stringify(chargedBy(r))}`);
  assert.strictEqual(r.counts['a'], 3, `rescued A reaches full required, got ${r.counts['a']}`);
  assert.ok(
    r.assignments.some((x) => x.userId === 'c' && x.date === O(6)),
    "heavy C is scheduled onto (one of) their preferred days to complete the rescue"
  );
  assert.ok(
    (r.counts['b'] || 0) >= 1 && (r.counts['c'] || 0) >= 2,
    `no chain participant left below their requirement: ${JSON.stringify(r.counts)}`
  );
  assert.strictEqual(r.unfilled.length, 0, 'coverage intact through the chain');
  assert.ok(
    r.warnings.some((w) => w.includes('C was scheduled on ' + O(6))),
    'the consumed preferred day is still surfaced as an override warning'
  );
}

// ---- self-rescue: an at-risk person works their OWN preferred-off day
{
  // 3-day block. A (required 2, balance 10) is must-off day 1 and prefers day
  // 3 off — its only path to 2 shifts runs through its own preferred day. B
  // (required 1) could take day 3 instead, which would leave A short and
  // charged. A's own predicted charge outranks A's own preference: A works
  // days 2 AND 3, uncharged.
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 2 }), mkUser('b', 'B', { requiredShifts: 1 })],
    [day],
    [oMust('a', 1), oPref('a', 3)]
  );
  const r = generateSchedule(db, { startDate: O(1), endDate: O(3) });
  assert.ok(
    r.assignments.some((x) => x.userId === 'a' && x.date === O(3)),
    'A must work its own preferred day rather than be charged'
  );
  assert.strictEqual(r.counts['a'], 2, `A reaches full required, got ${r.counts['a']}`);
  assert.deepStrictEqual(chargedBy(r), {}, 'self-rescue leaves nothing charged');
  assert.ok(
    r.warnings.some((w) => w.includes('A was scheduled on ' + O(3))),
    'the self-overridden preference is still reported'
  );
}

// ---- settlement numerics are unchanged by the rework (unavoidable charge)
{
  // Replicates the classic settlement shape (see the June fixtures above):
  // lone A requires 5 across a 5-day block but is must-off 2 of them. Nobody
  // exists to rescue A and only 3 days are workable, so the settled charge is
  // still exactly min(shortfall 2, mustOff 2, balance 10) = 2 — byte-for-byte
  // the same map as before the rework.
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 5 })], [day], [oMust('a', 2), oMust('a', 3)]);
  const r = generateSchedule(db, { startDate: O(1), endDate: O(5) });
  assert.strictEqual(r.counts['a'], 3, 'A works the other 3 days');
  assert.deepStrictEqual(chargedBy(r), { a: 2 }, `settlement formula untouched: ${JSON.stringify(chargedBy(r))}`);
  assert.ok(!r.warnings.some((w) => w.includes('minimum shifts')), 'covered shortfall still does not warn');
  // ...and the new diagnostic explains it as structurally unavoidable.
  const w = r.warnings.find((x) => x.includes('charged'));
  assert.ok(w, `a charge diagnostic must accompany the charge: ${JSON.stringify(r.warnings)}`);
  assert.ok(
    w!.includes('2 unavoidable (only 3 schedulable days for 5 required)'),
    `unavoidable part with day counts: ${w}`
  );
  assert.ok(!w!.includes('unresolvable'), `the zero unresolved part is omitted: ${w}`);
}

// ---- determinism: a rescue-triggering fixture generates identically twice
{
  const run = () => generateSchedule(mkHeavyRescueDb(), { startDate: O(1), endDate: O(6) });
  const r1 = run();
  const r2 = run();
  assert.deepStrictEqual(r1.assignments, r2.assignments, 'same inputs -> same assignments');
  assert.deepStrictEqual(chargedBy(r1), chargedBy(r2), 'same inputs -> same charges');
  assert.deepStrictEqual(r1.counts, r2.counts, 'same inputs -> same counts');
  assert.deepStrictEqual(r1.warnings, r2.warnings, 'same inputs -> same warnings');
}

// ===== charge-aware rework: diagnostics (summarizeSchedule) =====

// ---- unavoidable-only: too few schedulable days, no protection wording
{
  // A requires 5 but only days 1, 4, 5 are schedulable (must-off 2-3): the
  // whole 2-day charge is structurally unavoidable, so the warning carries
  // only the unavoidable part — the zero "unresolvable" part is omitted.
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 5 })], [day], [oMust('a', 2), oMust('a', 3)]);
  const draft: ScheduleDraft = {
    startDate: O(1), endDate: O(5), userIds: ['a'],
    assignments: [
      { date: O(1), shiftTypeId: 'day', userId: 'a' },
      { date: O(4), shiftTypeId: 'day', userId: 'a' },
      { date: O(5), shiftTypeId: 'day', userId: 'a' },
    ],
    unfilled: [], vacationCharges: chargesOf("a", 2, O(1)),
  };
  const { warnings } = summarizeSchedule(db, draft);
  const w = warnings.find((x) => x.includes('charged'));
  assert.ok(w, `expected a charge diagnostic: ${JSON.stringify(warnings)}`);
  assert.ok(w!.includes('charged 2 vacation days:'), `plural "days" for a 2-day charge: ${w}`);
  assert.ok(
    w!.includes('2 unavoidable (only 3 schedulable days for 5 required)'),
    `unavoidable wording with the day math: ${w}`
  );
  assert.ok(!w!.includes('unresolvable'), `no unresolvable part when the charge is fully unavoidable: ${w}`);
}

// ---- unresolved-only: enough schedulable days -> protection wording only
{
  // A requires 3 with 4 schedulable days (only day 1 is must-off), works 2 and
  // is charged 1: the days were there, so nothing is "unavoidable" — the whole
  // charge is reported as unresolvable without overriding protected days.
  const db = mkDb([mkUser('a', 'A', { requiredShifts: 3 })], [day], [oMust('a', 1)]);
  const draft: ScheduleDraft = {
    startDate: O(1), endDate: O(5), userIds: ['a'],
    assignments: [
      { date: O(2), shiftTypeId: 'day', userId: 'a' },
      { date: O(4), shiftTypeId: 'day', userId: 'a' },
    ],
    unfilled: [], vacationCharges: chargesOf("a", 1, O(1)),
  };
  const { warnings } = summarizeSchedule(db, draft);
  const w = warnings.find((x) => x.includes('charged'));
  assert.ok(w, `expected a charge diagnostic: ${JSON.stringify(warnings)}`);
  assert.ok(
    w!.includes('1 unresolvable without overriding protected preferred days'),
    `unresolved wording: ${w}`
  );
  assert.ok(!w!.includes('unavoidable'), `no unavoidable part when enough days existed: ${w}`);
}

// ---- pluralization: a 1-day charge and a 1-day count use the singular
{
  // A requires 2 with days 1-2 must-off across a 3-day block: 1 schedulable
  // day, charge 1 -> "charged 1 vacation day:" and "only 1 schedulable day".
  const db = mkDb(
    [mkUser('a', 'A', { requiredShifts: 2, vacationDays: 5 })],
    [day],
    [oMust('a', 1), oMust('a', 2)]
  );
  const draft: ScheduleDraft = {
    startDate: O(1), endDate: O(3), userIds: ['a'],
    assignments: [{ date: O(3), shiftTypeId: 'day', userId: 'a' }],
    unfilled: [], vacationCharges: chargesOf("a", 1, O(1)),
  };
  const { warnings } = summarizeSchedule(db, draft);
  const w = warnings.find((x) => x.includes('charged'));
  assert.ok(w, `expected a charge diagnostic: ${JSON.stringify(warnings)}`);
  assert.ok(w!.includes('charged 1 vacation day:'), `singular "day" for a 1-day charge: ${w}`);
  assert.ok(w!.includes('only 1 schedulable day for 2 required'), `singular schedulable "day": ${w}`);
}

// ===== per-day vacation years: a schedule spanning New Year =====
// 28 Dec 2026 - 10 Jan 2027 (14 days), one daily shift, must-off 30 Dec and 3 Jan.
{
  const must = [
    { id: 'm1', userId: 'a', date: '2026-12-30', type: 'vacation' as const },
    { id: 'm2', userId: 'a', date: '2027-01-03', type: 'vacation' as const },
  ];
  const block = { startDate: '2026-12-28', endDate: '2027-01-10' };
  const priorCharges = (dates: string[]) => ({
    id: 'prior', startDate: '2027-02-01', endDate: '2027-02-14', createdAt: '', userIds: ['a'],
    assignments: [], unfilled: [], counts: {}, warnings: [],
    vacationCharges: dates.map((date) => ({ userId: 'a', date, cause: 'shortfall' as const })),
  });

  // ---- a shortfall charges the earliest must-off day, dated on that day
  {
    // B covers the must-off days; A is required 13 and can work only 12 -> shortfall 1.
    const db = mkDb([mkUser('a', 'A', { requiredShifts: 13 }), mkUser('b', 'B')], [day], must);
    const r = generateSchedule(db, block);
    const aDates = r.assignments.filter((x) => x.userId === 'a').map((x) => x.date);
    assert.ok(!aDates.includes('2026-12-30') && !aDates.includes('2027-01-03'), `must-offs honoured: ${aDates}`);
    assert.deepStrictEqual(r.vacationCharges, [{ userId: 'a', date: '2026-12-30', cause: 'shortfall' }],
      'charged on 30 Dec, so it counts toward 2026');
  }
  // ---- a shortfall of 2 charges one day to each year
  {
    const db = mkDb([mkUser('a', 'A', { requiredShifts: 14 }), mkUser('b', 'B')], [day], must);
    const r = generateSchedule(db, block);
    assert.deepStrictEqual(r.vacationCharges, [
      { userId: 'a', date: '2026-12-30', cause: 'shortfall' },
      { userId: 'a', date: '2027-01-03', cause: 'shortfall' },
    ]);
    db.schedules.push({ id: 's', createdAt: '', ...block, ...r } as any);
    assert.strictEqual(yearBalance(db, db.users[0], 2026).balance, 9, '2026: 10 - 1');
    assert.strictEqual(yearBalance(db, db.users[0], 2027).balance, 9, '2027: 10 - 1');
  }
  // ---- affordability is checked per vacation year
  {
    // Allowance 1 a year, plus 1 elected into 2026; 2027's day is already
    // spent. 2027 (0) can't cover 3 Jan, so only that must-off softens and
    // A (alone) works it. 2026 (2) covers 30 Dec, which stays hard: it goes
    // unfilled and its shortfall is charged to 2026.
    const db = mkDb([mkUser('a', 'A', { requiredShifts: 14, vacationDays: 1 })], [day], must);
    db.schedules.push({ ...priorCharges(['2027-02-02']), extraElections: { a: { vacationByYear: { 2026: 1 }, incentive: 0 } } } as any);
    assert.deepStrictEqual([2026, 2027].map((y) => yearBalance(db, db.users[0], y).balance), [2, 0]);
    const r = generateSchedule(db, block);
    const aDates = r.assignments.filter((x) => x.userId === 'a').map((x) => x.date);
    assert.ok(aDates.includes('2027-01-03'), `the unaffordable 2027 must-off is softened and worked: ${aDates}`);
    assert.ok(!aDates.includes('2026-12-30'), `the affordable 2026 must-off stays hard: ${aDates}`);
    assert.deepStrictEqual(r.vacationCharges, [{ userId: 'a', date: '2026-12-30', cause: 'shortfall' }],
      'only the day actually taken off is charged, to 2026');
  }
  {
    // Both years can cover their own must-off day: nothing softens.
    const db = mkDb([mkUser('a', 'A', { requiredShifts: 14, vacationDays: 1 })], [day], must);
    const r = generateSchedule(db, block);
    const aDates = r.assignments.filter((x) => x.userId === 'a').map((x) => x.date);
    assert.ok(!aDates.includes('2026-12-30') && !aDates.includes('2027-01-03'), `must-offs honoured: ${aDates}`);
    assert.strictEqual(r.vacationCharges.length, 2);
  }
}

console.log('All scheduler tests passed.');
