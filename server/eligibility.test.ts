// Smoke test: tsx server/eligibility.test.ts
import assert from 'assert';
import {
  checkEligibility, GENERATOR_POLICY, ADMIN_REASSIGN_POLICY, TRADE_POLICY,
  scheduleHeldShifts, indexedHeldShifts, scheduleEligibility, needsConfirmation,
} from './eligibility.js';
import type { DayFacts, EligibilityPolicy, HeldShifts } from './eligibility.js';
import type { Assignment, Db, Schedule, ShiftType, User, VacationCharge } from '../shared/types.js';

const day: ShiftType = { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const mgr: ShiftType = { ...day, id: 'mgr', name: 'Manager', allowedRoles: ['role-mgr'] };
const shiftTypes: Record<string, ShiftType> = { day, mgr };

const mkUser = (extra: Partial<User> = {}): User => ({
  id: 'b', name: 'Ben', roles: ['role-employee'], vacationDays: 10, color: '#888', ...extra,
});
const A = (userId: string, date: string, shiftTypeId: string): Assignment => ({ userId, date, shiftTypeId });
const noFacts: DayFacts = { mustOff: () => null, isAway: () => false };

const POLICIES: [string, EligibilityPolicy][] = [
  ['generator', GENERATOR_POLICY], ['admin reassign', ADMIN_REASSIGN_POLICY], ['trade', TRADE_POLICY],
];

function check({
  person = mkUser(), date = '2099-01-10', shiftType = day, assignments = [] as Assignment[],
  facts = noFacts, policy = TRADE_POLICY as EligibilityPolicy, held = undefined as HeldShifts | undefined,
} = {}) {
  return checkEligibility({
    person, date, shiftType, shiftTypes, facts, policy,
    held: held ?? scheduleHeldShifts(assignments, person.id, shiftTypes),
  });
}

// ---- role: a person without an allowed role is blocked, under every policy ----
for (const [name, policy] of POLICIES) {
  const r = check({ shiftType: mgr, policy });
  assert.deepStrictEqual(r, { eligible: false, reason: "Ben doesn't have a role allowed for that shift." }, name);
}

// ---- an allowed role (or an unrestricted shift) is eligible with no warnings ----
for (const [name, policy] of POLICIES) {
  assert.deepStrictEqual(check({ policy }), { eligible: true, warnings: [] }, name);
  assert.deepStrictEqual(check({ policy, shiftType: mgr, person: mkUser({ roles: ['role-mgr'] }) }), { eligible: true, warnings: [] }, name);
}

// ---- must-off days: the generator and admin reassign block an affordable one
// and may schedule over an unaffordable one, with no warning; trades warn the
// person taking the shift about either, naming the day ----
const mustOffOn = (affordable: boolean): DayFacts => ({
  mustOff: (d) => (d === '2099-01-10' ? { affordable } : null), isAway: () => false,
});
const onVacation = { eligible: false, reason: 'Ben is on vacation that day.' };
for (const policy of [GENERATOR_POLICY, ADMIN_REASSIGN_POLICY]) {
  assert.deepStrictEqual(check({ policy, facts: mustOffOn(true) }), onVacation, `${policy.name}: affordable must-off blocks`);
}
for (const [name, policy] of POLICIES) {
  assert.deepStrictEqual(check({ policy, facts: mustOffOn(true), date: '2099-01-11' }), { eligible: true, warnings: [] }, `${name}: other days are fine`);
}
assert.deepStrictEqual(check({ policy: GENERATOR_POLICY, facts: mustOffOn(false) }), { eligible: true, warnings: [] }, 'generator: unaffordable must-off allowed');
assert.deepStrictEqual(check({ policy: ADMIN_REASSIGN_POLICY, facts: mustOffOn(false) }), { eligible: true, warnings: [] }, 'admin: unaffordable must-off allowed');
for (const affordable of [true, false]) {
  assert.deepStrictEqual(
    check({ policy: TRADE_POLICY, facts: mustOffOn(affordable) }),
    { eligible: true, warnings: [{ kind: 'must-off day', message: "2099-01-10 is one of Ben's must-off days." }] },
    `trade: ${affordable ? 'affordable' : 'unaffordable'} must-off warns`
  );
}
// A must-off warning doesn't hide a hard rule that also breaks.
assert.deepStrictEqual(
  check({ policy: TRADE_POLICY, facts: { ...mustOffOn(true), isAway: () => true } }),
  { eligible: false, reason: 'Ben is on away time that day.' }, 'trade: hard rule still blocks on a must-off day'
);

// ---- started: the start date itself is workable, the day before isn't ----
for (const [name, policy] of POLICIES) {
  const person = mkUser({ startDate: '2099-01-10' });
  assert.deepStrictEqual(check({ policy, person, date: '2099-01-09' }), { eligible: false, reason: "Ben hasn't started yet (starts 2099-01-10)." }, name);
  assert.strictEqual(check({ policy, person, date: '2099-01-10' }).eligible, true, name);
}

// ---- away time blocks ----
for (const [name, policy] of POLICIES) {
  const facts: DayFacts = { mustOff: () => null, isAway: (d) => d === '2099-01-10' };
  assert.deepStrictEqual(check({ policy, facts }), { eligible: false, reason: 'Ben is on away time that day.' }, name);
  assert.strictEqual(check({ policy, facts, date: '2099-01-11' }).eligible, true, name);
}

// ---- one shift a day, and 8 hours of rest, judged on the shifts held ----
const night: ShiftType = { ...day, id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00' };
const eve: ShiftType = { ...day, id: 'eve', name: 'Evening', startTime: '17:00', endTime: '21:00' };
shiftTypes.night = night;
shiftTypes.eve = eve;
for (const [name, policy] of POLICIES) {
  assert.deepStrictEqual(
    check({ policy, shiftType: eve, assignments: [A('b', '2099-01-10', 'day')] }),
    { eligible: false, reason: 'Ben already works a shift that day.' }, name
  );
  // Night on the 9th ends 06:00 on the 10th: a 08:00 day shift leaves 2h.
  assert.deepStrictEqual(
    check({ policy, assignments: [A('b', '2099-01-09', 'night')] }),
    { eligible: false, reason: 'Ben would have less than 8 hours of rest around that shift.' }, name
  );
  // Someone else's shifts don't count.
  assert.strictEqual(check({ policy, assignments: [A('a', '2099-01-10', 'day'), A('a', '2099-01-09', 'night')] }).eligible, true, name);
}

// ---- shifts being given up are left out of the held shifts ----
{
  const mine = A('b', '2099-01-10', 'eve');
  const held = scheduleHeldShifts([mine, A('b', '2099-01-09', 'night')], 'b', shiftTypes, [mine]);
  assert.deepStrictEqual(
    check({ held }), { eligible: false, reason: 'Ben would have less than 8 hours of rest around that shift.' },
    'giving up the eve shift frees the day, but the night before still breaks rest'
  );
  const held2 = scheduleHeldShifts([mine], 'b', shiftTypes, [mine]);
  assert.strictEqual(check({ held: held2 }).eligible, true, 'a same-day swap is judged without the shift given up');
}

// ---- consecutive-night limit: the generator blocks, admin is warned, trades ignore it ----
{
  const person = mkUser({ maxConsecutiveNights: 2 });
  const twoNights = [A('b', '2099-01-08', 'night'), A('b', '2099-01-09', 'night')];
  const pastLimit = 'Ben would exceed their 2-night limit on consecutive overnight shifts.';
  assert.deepStrictEqual(
    check({ policy: GENERATOR_POLICY, person, date: '2099-01-10', shiftType: night, assignments: twoNights }),
    { eligible: false, reason: pastLimit }, 'generator'
  );
  assert.deepStrictEqual(
    check({ policy: TRADE_POLICY, person, date: '2099-01-10', shiftType: night, assignments: twoNights }),
    { eligible: true, warnings: [] }, 'trade'
  );
  assert.deepStrictEqual(
    check({ policy: ADMIN_REASSIGN_POLICY, person, date: '2099-01-10', shiftType: night, assignments: twoNights }),
    { eligible: true, warnings: [{ kind: 'consecutive-night limit', message: pastLimit }] }, 'admin'
  );
  for (const [name, policy] of POLICIES) {
    assert.strictEqual(check({ policy, person, date: '2099-01-11', shiftType: night, assignments: twoNights }).eligible, true, `${name}: a gap day resets the run`);
    assert.strictEqual(check({ policy, date: '2099-01-10', shiftType: night, assignments: twoNights }).eligible, true, `${name}: no limit set`);
  }
}

// ---- shift maximum: the generator blocks, admin is warned, trades ignore it ----
{
  const person = mkUser({ maxShiftsOverride: 2 });
  const standby: ShiftType = { ...day, id: 'standby', name: 'Standby', weight: 0 };
  shiftTypes.standby = standby;
  const two = [A('b', '2099-01-05', 'day'), A('b', '2099-01-06', 'day'), A('b', '2099-01-07', 'standby')];
  const atMax = { eligible: false, reason: 'Ben is already at their maximum of 2 shifts for this schedule.' };
  assert.deepStrictEqual(check({ policy: GENERATOR_POLICY, person, assignments: two }), atMax, 'generator');
  assert.deepStrictEqual(
    check({ policy: ADMIN_REASSIGN_POLICY, person, assignments: two }),
    { eligible: true, warnings: [{ kind: 'shift maximum', message: atMax.reason }] }, 'admin'
  );
  assert.deepStrictEqual(check({ policy: TRADE_POLICY, person, assignments: two }), { eligible: true, warnings: [] }, 'trade');
  for (const [name, policy] of POLICIES) {
    assert.strictEqual(check({ policy, person, assignments: two, shiftType: standby }).eligible, true, `${name}: standby never counts`);
    assert.strictEqual(check({ policy, person, assignments: two.slice(1) }).eligible, true, `${name}: under the maximum`);
    const held = scheduleHeldShifts(two, 'b', shiftTypes, [two[0]]);
    assert.strictEqual(check({ policy, person, held }).eligible, true, `${name}: the shift given up doesn't count`);
  }
}

// ---- when several rules break, the blocking reason is the first, in a fixed
// order: role, must-off, started, away, one shift a day, rest, nights, maximum ----
{
  const facts: DayFacts = { mustOff: () => ({ affordable: true }), isAway: () => true };
  const everything = {
    person: mkUser({ roles: [], startDate: '2099-02-01', maxConsecutiveNights: 1, maxShiftsOverride: 1 }),
    shiftType: { ...night, allowedRoles: ['role-mgr'] }, facts,
    assignments: [A('b', '2099-01-09', 'night'), A('b', '2099-01-10', 'eve')],
  };
  const reasons: string[] = [];
  const peel = [
    () => { everything.person.roles = ['role-mgr']; },
    () => { everything.facts = { mustOff: () => null, isAway: () => true }; },
    () => { everything.person.startDate = null; },
    () => { everything.facts = noFacts; },
    () => { everything.assignments = [A('b', '2099-01-09', 'night'), A('b', '2099-01-11', 'day')]; },
    () => { everything.assignments = [A('b', '2099-01-09', 'night')]; },
    () => { everything.person.maxConsecutiveNights = null; },
  ];
  for (const [i, step] of [() => {}, ...peel].entries()) {
    step();
    const r = check({ ...everything, policy: GENERATOR_POLICY });
    reasons.push(r.eligible ? 'eligible' : r.reason);
    // Admin reassign blocks on the same hard rules and must-off day; it only
    // warns on the last two (nights, maximum).
    if (i < 6) assert.deepStrictEqual(check({ ...everything, policy: ADMIN_REASSIGN_POLICY }), r, 'admin and generator agree on hard rules');
  }
  assert.deepStrictEqual(reasons, [
    "Ben doesn't have a role allowed for that shift.",
    'Ben is on vacation that day.',
    "Ben hasn't started yet (starts 2099-02-01).",
    'Ben is on away time that day.',
    'Ben already works a shift that day.',
    'Ben would have less than 8 hours of rest around that shift.',
    'Ben would exceed their 1-night limit on consecutive overnight shifts.',
    'Ben is already at their maximum of 1 shifts for this schedule.',
  ]);
}

// ---- a limit set to warn makes the person eligible, listing every warning ----
{
  const warnAll: EligibilityPolicy = {
    name: 'warn all', affordableMustOff: 'warn', unaffordableMustOff: 'warn', consecutiveNightLimit: 'warn', shiftMaximum: 'warn',
  };
  const r = check({
    policy: warnAll, person: mkUser({ maxConsecutiveNights: 1, maxShiftsOverride: 1 }), shiftType: night,
    facts: mustOffOn(true), assignments: [A('b', '2099-01-09', 'night')],
  });
  assert.deepStrictEqual(r, {
    eligible: true,
    warnings: [
      { kind: 'must-off day', message: "2099-01-10 is one of Ben's must-off days." },
      { kind: 'consecutive-night limit', message: 'Ben would exceed their 1-night limit on consecutive overnight shifts.' },
      { kind: 'shift maximum', message: 'Ben is already at their maximum of 1 shifts for this schedule.' },
    ],
  });
}

// ---- admin reassign past both limits gets both warnings in one answer ----
{
  const r = check({
    policy: ADMIN_REASSIGN_POLICY, person: mkUser({ maxConsecutiveNights: 1, maxShiftsOverride: 1 }),
    shiftType: night, assignments: [A('b', '2099-01-09', 'night')],
  });
  assert.deepStrictEqual(r, {
    eligible: true,
    warnings: [
      { kind: 'consecutive-night limit', message: 'Ben would exceed their 1-night limit on consecutive overnight shifts.' },
      { kind: 'shift maximum', message: 'Ben is already at their maximum of 1 shifts for this schedule.' },
    ],
  });
}

// ---- confirmation contract: a request needs confirming unless it confirmed
// every warning kind it now triggers ----
{
  const max = { kind: 'shift maximum' as const, message: 'm' };
  const nights = { kind: 'consecutive-night limit' as const, message: 'n' };
  assert.strictEqual(needsConfirmation([], undefined), false, 'no warnings, no step');
  assert.strictEqual(needsConfirmation([max], undefined), true, 'not confirmed');
  assert.strictEqual(needsConfirmation([max], []), true, 'confirmed nothing');
  assert.strictEqual(needsConfirmation([max], ['shift maximum']), false, 'confirmed');
  assert.strictEqual(needsConfirmation([max, nights], ['shift maximum']), true, 'a new warning appeared');
  assert.strictEqual(needsConfirmation([max], ['shift maximum', 'consecutive-night limit']), false, 'a confirmed warning went away');
  assert.strictEqual(needsConfirmation([max], 'shift maximum'), true, 'only a list confirms');
}

// ---- both held-shifts adapters give the same answers on the same assignments ----
{
  const assignments = [
    A('b', '2099-01-03', 'night'), A('b', '2099-01-04', 'night'), A('b', '2099-01-06', 'day'),
    A('b', '2099-01-07', 'standby'), A('b', '2099-01-09', 'eve'), A('a', '2099-01-05', 'day'),
  ];
  // The generator's live per-person indexes, built the way it builds them.
  const list = new Map<string, Assignment[]>();
  const byDate = new Map<string, Map<string, Assignment>>();
  const counts = new Map<string, number>();
  for (const a of assignments) {
    if (!list.has(a.userId)) { list.set(a.userId, []); byDate.set(a.userId, new Map()); counts.set(a.userId, 0); }
    list.get(a.userId)!.push(a);
    byDate.get(a.userId)!.set(a.date, a);
    if (a.shiftTypeId !== 'standby') counts.set(a.userId, counts.get(a.userId)! + 1);
  }
  const indexed = indexedHeldShifts('b', { list, byDate, counts });
  const plain = scheduleHeldShifts(assignments, 'b', shiftTypes);
  const person = mkUser({ maxConsecutiveNights: 2, maxShiftsOverride: 4 });
  let compared = 0;
  for (let d = 1; d <= 12; d++) {
    const date = `2099-01-${String(d).padStart(2, '0')}`;
    for (const shiftType of Object.values(shiftTypes)) {
      for (const [name, policy] of POLICIES) {
        const viaIndex = check({ person, date, shiftType, policy, held: indexed });
        assert.deepStrictEqual(viaIndex, check({ person, date, shiftType, policy, held: plain }), `${name} ${date} ${shiftType.id}`);
        compared++;
      }
    }
  }
  // Sanity: the grid exercised blocks and eligibles alike.
  assert.ok(compared > 100);
  // The index adapter reads live: a shift added after it was made counts.
  const added = A('b', '2099-01-11', 'day');
  list.get('b')!.push(added); byDate.get('b')!.set(added.date, added); counts.set('b', counts.get('b')! + 1);
  assert.strictEqual(check({ person, date: '2099-01-11', held: indexed }).eligible, false);
}

// ---- live affordability (trades and reassign): a must-off day is unaffordable
// when the person's must-off days in that vacation year, within the schedule,
// outnumber their year balance counted without this schedule's own charges ----
{
  const sched = (id: string, startDate: string, endDate: string, vacationCharges: VacationCharge[] = []): Schedule => ({
    id, startDate, endDate, userIds: ['b'], assignments: [], unfilled: [], counts: {}, warnings: [],
    createdAt: '2099-01-01T00:00:00Z', vacationCharges,
  });
  const mkDb = (vacationDays: number, mustOff: string[], schedules: Schedule[]): Db => ({
    users: [mkUser({ vacationDays })], roles: [], shiftTypes: [day], settings: { maxVacationPerDay: 2 },
    timeOff: mustOff.map((date, i) => ({ id: `t${i}`, userId: 'b', date, type: 'vacation' })),
    schedules, trades: [], notifications: [], awayTime: [], holidays: [], meta: { rotationCursor: 0 },
  });
  const charge = (date: string): VacationCharge => ({ userId: 'b', date, cause: 'shortfall' });
  const reassign = (db: Db, date: string) =>
    scheduleEligibility(db, db.schedules[0], { date, shiftTypeId: 'day' }, db.users[0], ADMIN_REASSIGN_POLICY);
  const mustOffs = ['2099-01-05', '2099-01-06', '2099-01-07'];

  // 3 balance, 3 must-off days: affordable, so the admin is blocked.
  assert.deepStrictEqual(reassign(mkDb(3, mustOffs, [sched('s1', '2099-01-01', '2099-01-31')]), '2099-01-05'), onVacation, 'affordable blocks admin');
  // 2 balance, 3 must-off days: unaffordable, so the admin may reassign onto any of them.
  for (const d of mustOffs)
    assert.deepStrictEqual(reassign(mkDb(2, mustOffs, [sched('s1', '2099-01-01', '2099-01-31')]), d), { eligible: true, warnings: [] }, `unaffordable ${d}`);

  // The schedule's own charges don't make its must-off days unaffordable:
  // 3 balance, 3 must-off days, all 3 charged by this schedule -> all affordable.
  {
    const db = mkDb(3, mustOffs, [sched('s1', '2099-01-01', '2099-01-31', mustOffs.map(charge))]);
    for (const d of mustOffs) assert.deepStrictEqual(reassign(db, d), onVacation, `own charges left out ${d}`);
  }
  // Another schedule's charges (live balance changes) do count: 3 balance,
  // 1 charged elsewhere in 2099 -> 2 left for 3 must-off days -> unaffordable.
  {
    const db = mkDb(3, mustOffs, [sched('s1', '2099-01-01', '2099-01-31'), sched('s0', '2098-12-01', '2098-12-31', [charge('2099-12-31')])]);
    assert.deepStrictEqual(reassign(db, '2099-01-05').eligible, true, 'other schedules count');
  }
  // Must-off days outside the schedule don't count toward it.
  assert.deepStrictEqual(
    reassign(mkDb(2, [...mustOffs.slice(0, 2), '2099-03-01'], [sched('s1', '2099-01-01', '2099-01-31')]), '2099-01-05'),
    onVacation, 'only the schedule\'s own must-off days count'
  );

  // A schedule spanning two vacation years is judged per year: 2 balance in
  // each; 3 must-off days in 2098 (unaffordable), 2 in 2099 (affordable).
  {
    const db = mkDb(2, ['2098-12-29', '2098-12-30', '2098-12-31', '2099-01-01', '2099-01-02'], [sched('s1', '2098-12-20', '2099-01-10')]);
    assert.strictEqual(reassign(db, '2098-12-30').eligible, true, '2098 unaffordable');
    assert.deepStrictEqual(reassign(db, '2099-01-01'), onVacation, '2099 affordable');
  }
}

console.log('All eligibility tests passed.');
