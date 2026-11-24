// Smoke test: tsx server/schedules.test.ts
import assert from 'assert';
import { buildSchedule, deleteSchedule, reassignShift } from './schedules.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import type { Assignment, Db, Schedule, ShiftType, User } from '../shared/types.js';

// Commands run as of TODAY. Two-week blocks anchored on 2050-01-01, so block 0
// is 2050-01-01..2050-01-14 and holds TODAY.
const TODAY = '2050-01-03';
const cadence = { anchorDate: '2050-01-01', lengthUnit: 'weeks' as const, lengthValue: 2 };
const day: ShiftType = { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };

const mkUser = (id: string, name: string, extra: Record<string, any> = {}): User => ({
  id, name, roles: ['role-employee'], vacationDays: 10, color: '#888', ...extra,
});
const admin = mkUser('admin', 'Ada', { roles: ['role-admin'] });

function mkDb(extra: Partial<Db> = {}): Db {
  return {
    users: [admin, mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    roles: [],
    shiftTypes: [day],
    settings: { maxVacationPerDay: 2, cadence },
    timeOff: [],
    schedules: [],
    trades: [],
    notifications: [],
    awayTime: [],
    holidays: [],
    meta: { rotationCursor: 0 },
    ...extra,
  };
}

const as = (db: Db, uid: string, today = TODAY): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today });
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const reasonOf = (o: Outcome<unknown>) => (o.ok ? 'ok' : o.refusal.reason);
const refusalOf =(o: Outcome<unknown>) => (o.ok ? 'ok' : `${o.refusal.reason}: ${o.refusal.message}`);

// ---- build: happy path ----
{
  const db = mkDb();
  const schedule = value(buildSchedule(db, as(db, 'admin'), { blockIndex: 0 }));
  assert.strictEqual(schedule.startDate, '2050-01-01');
  assert.strictEqual(schedule.endDate, '2050-01-14');
  assert.deepStrictEqual(schedule.userIds, ['admin', 'a', 'b'], 'everyone included by default');
  assert.deepStrictEqual(db.schedules, [schedule], 'saved');
  assert.strictEqual(schedule.assignments.length + schedule.unfilled.length, 14, 'one Day slot per day');
  assert.notStrictEqual(db.meta.rotationCursor, 0, 'rotation cursor moved forward');
}

// ---- build: non-admin forbidden ----
{
  const db = mkDb();
  assert.strictEqual(refusalOf(buildSchedule(db, as(db, 'a'), { blockIndex: 0 })), 'forbidden: Admin access required.');
  assert.deepStrictEqual(db.schedules, []);
}

// ---- build: each refusal, in the order they're checked ----
{
  const build = (db: Db, input: { blockIndex: unknown; userIds?: unknown }, today = TODAY) =>
    refusalOf(buildSchedule(db, as(db, 'admin', today), input));

  let db = mkDb({ settings: { maxVacationPerDay: 2, cadence: null } });
  assert.strictEqual(build(db, { blockIndex: 0 }), 'invalid: Configure a schedule cadence in Settings first.');
  db = mkDb({ shiftTypes: [] });
  assert.strictEqual(build(db, { blockIndex: 0 }), 'invalid: Configure at least one shift type first.');
  db = mkDb();
  for (const blockIndex of [undefined, -1, 1.5, 'x'])
    assert.strictEqual(build(db, { blockIndex }), 'invalid: Pick a schedule block.', `blockIndex ${blockIndex}`);
  assert.strictEqual(build(db, { blockIndex: 0, userIds: ['ghost'] }), 'invalid: Include at least one person in the block.');
  assert.strictEqual(build(db, { blockIndex: 0, userIds: [] }), 'invalid: Include at least one person in the block.');
  assert.deepStrictEqual(db.schedules, [], 'nothing built');
}

// ---- build: the selectable window is the current block and the next 4 ----
{
  const outside = 'invalid: That block is outside the selectable window.';
  // As of 2050-01-15, block 1 (2050-01-15..28) is current: blocks 1..5 are offered.
  const late = '2050-01-15';
  const build = (blockIndex: number) => {
    const db = mkDb();
    return refusalOf(buildSchedule(db, as(db, 'admin', late), { blockIndex }));
  };
  assert.strictEqual(build(0), outside, 'a block that has ended');
  assert.strictEqual(build(1), 'ok', 'the current block');
  assert.strictEqual(build(5), 'ok', 'the fifth block offered');
  assert.strictEqual(build(6), outside, 'one past the window');
  // On a block's last day it is still current.
  const db = mkDb();
  assert.strictEqual(refusalOf(buildSchedule(db, as(db, 'admin', '2050-01-14'), { blockIndex: 0 })), 'ok');
}

// ---- build: a block that already has a schedule ----
{
  const db = mkDb();
  value(buildSchedule(db, as(db, 'admin'), { blockIndex: 0 }));
  const cursor = db.meta.rotationCursor;
  assert.strictEqual(
    refusalOf(buildSchedule(db, as(db, 'admin'), { blockIndex: 0 })),
    'invalid: A schedule for this block already exists — delete it first to regenerate.'
  );
  assert.strictEqual(db.schedules.length, 1);
  assert.strictEqual(db.meta.rotationCursor, cursor, 'cursor untouched');
  assert.strictEqual(refusalOf(buildSchedule(db, as(db, 'admin'), { blockIndex: 1 })), 'ok', 'the next block is free');
}

// ---- build: only the requested, known people are included ----
{
  const db = mkDb();
  const schedule = value(buildSchedule(db, as(db, 'admin'), { blockIndex: 0, userIds: ['a', 'ghost'] }));
  assert.deepStrictEqual(schedule.userIds, ['a']);
  assert.ok(schedule.assignments.every((x) => x.userId === 'a'));
}

// ---- reassign ----
// Bea holds a Day on the 5th and a Night on the 9th; a Day on the 12th and a
// Night on the 10th are open.
const night: ShiftType = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const A = (userId: string, date: string, shiftTypeId: string): Assignment => ({ userId, date, shiftTypeId });
const dayShift = { date: '2099-01-12', shiftTypeId: 'day' };
const nightShift = { date: '2099-01-10', shiftTypeId: 'night' };

function reassignDb(bea: Record<string, unknown> = {}, extra: Partial<Db> = {}): Db {
  const schedule: Schedule = {
    id: 'sch1', startDate: '2099-01-01', endDate: '2099-01-31',
    createdAt: '2099-01-01T00:00:00Z', userIds: ['admin', 'bea', 'cy'],
    assignments: [A('bea', '2099-01-05', 'day'), A('bea', '2099-01-09', 'night')],
    unfilled: [dayShift, nightShift], counts: {}, warnings: [],
  };
  return mkDb({
    users: [admin, mkUser('bea', 'Bea', bea), mkUser('cy', 'Cy')],
    shiftTypes: [day, night],
    schedules: [schedule],
    ...extra,
  });
}
type ReassignInput = Parameters<typeof reassignShift>[2];
const reassign = (db: Db, input: Partial<ReassignInput>, uid = 'admin') =>
  reassignShift(db, as(db, uid), { id: 'sch1', fromUserId: null, toUserId: 'bea', ...dayShift, ...input });

// Filling an open shift moves it to the assignments and re-summarizes.
{
  const db = reassignDb();
  const schedule = value(reassign(db, {}));
  assert.ok(schedule.assignments.some((x) => x.userId === 'bea' && x.date === '2099-01-12' && x.shiftTypeId === 'day'));
  assert.deepStrictEqual(schedule.unfilled, [nightShift]);
  assert.strictEqual(schedule.counts!.bea, 3, 'counts re-summarized');
}

const warningsOf = (o: Outcome<unknown>) => (o.ok ? undefined : o.refusal.warnings);
const atMax = 'Bea is already at their maximum of 2 shifts for this schedule.';
const pastNights = 'Bea would exceed their 1-night limit on consecutive overnight shifts.';
const mustOffMsg = "2099-01-12 is one of Bea's must-off days.";
const vacation = (id: string, date: string) => ({ id, userId: 'bea', date, type: 'vacation' as const });

// The shift maximum warns, and the reassign goes through once confirmed.
{
  const db = reassignDb({ maxShiftsOverride: 2 });
  const refused = reassign(db, {});
  assert.strictEqual(refusalOf(refused), `unconfirmed: ${atMax}`);
  assert.deepStrictEqual(warningsOf(refused), [{ kind: 'shift maximum', message: atMax }]);
  const schedule = value(reassign(db, { confirmedWarnings: [atMax] }));
  assert.ok(schedule.assignments.some((x) => x.userId === 'bea' && x.date === '2099-01-12'));
}

// The consecutive-night limit warns, and goes through once confirmed.
{
  const db = reassignDb({ maxConsecutiveNights: 1 });
  assert.deepStrictEqual(warningsOf(reassign(db, nightShift)), [{ kind: 'consecutive-night limit', message: pastNights }]);
  value(reassign(db, { ...nightShift, confirmedWarnings: [pastNights] }));
}

// Past both limits lists both; confirming only one is refused with both again.
{
  const db = reassignDb({ maxConsecutiveNights: 1, maxShiftsOverride: 2 });
  const both = [
    { kind: 'consecutive-night limit', message: pastNights },
    { kind: 'shift maximum', message: atMax },
  ];
  assert.deepStrictEqual(warningsOf(reassign(db, nightShift)), both);
  assert.deepStrictEqual(warningsOf(reassign(db, { ...nightShift, confirmedWarnings: [atMax] })), both);
  value(reassign(db, { ...nightShift, confirmedWarnings: [pastNights, atMax] }));
}

// Confirming a warning of the same kind but a different message doesn't count.
{
  const db = reassignDb({ maxShiftsOverride: 2 });
  const stale = 'Bea is already at their maximum of 3 shifts for this schedule.';
  const refused = reassign(db, { confirmedWarnings: ['shift maximum', stale] });
  assert.deepStrictEqual(warningsOf(refused), [{ kind: 'shift maximum', message: atMax }]);
}

// A hard rule blocks even with the warnings confirmed.
{
  const db = reassignDb({ maxShiftsOverride: 2 }, {
    awayTime: [{ id: 'aw1', userId: 'bea', start: '2099-01-12', end: '2099-01-12' }] as Db['awayTime'],
  });
  assert.strictEqual(refusalOf(reassign(db, { confirmedWarnings: [atMax] })), 'invalid: Bea is on away time that day.');
}

// One shift a day blocks.
{
  const db = reassignDb();
  const r = reassign(db, { date: '2099-01-05', shiftTypeId: 'night', fromUserId: null });
  assert.strictEqual(reasonOf(r), 'invalid', 'already working that day');
}

// An affordable must-off day blocks, confirmed or not.
{
  const db = reassignDb({}, { timeOff: [vacation('t1', '2099-01-12')] });
  assert.strictEqual(refusalOf(reassign(db, { confirmedWarnings: [mustOffMsg] })), `invalid: ${mustOffMsg}`);
}

// An unaffordable must-off day (two against a balance of one) warns, then goes through.
{
  const db = reassignDb({ vacationDays: 1 }, { timeOff: [vacation('t1', '2099-01-12'), vacation('t2', '2099-01-13')] });
  const refused = reassign(db, {});
  assert.strictEqual(refusalOf(refused), `unconfirmed: ${mustOffMsg}`);
  assert.deepStrictEqual(warningsOf(refused), [{ kind: 'must-off day', message: mustOffMsg }]);
  const schedule = value(reassign(db, { confirmedWarnings: [mustOffMsg] }));
  assert.deepStrictEqual(schedule.unfilled, [nightShift]);
}

// Handing a shift to someone else, and unassigning it back to open.
{
  const db = reassignDb();
  const handed = value(reassign(db, { date: '2099-01-05', shiftTypeId: 'day', fromUserId: 'bea', toUserId: 'cy' }));
  assert.ok(handed.assignments.some((x) => x.userId === 'cy' && x.date === '2099-01-05'));
  assert.strictEqual(handed.counts!.cy, 1);
  const opened = value(reassign(db, { date: '2099-01-05', shiftTypeId: 'day', fromUserId: 'cy', toUserId: null }));
  assert.ok(!opened.assignments.some((x) => x.date === '2099-01-05'));
  assert.ok(opened.unfilled.some((x) => x.date === '2099-01-05' && x.shiftTypeId === 'day'));
}

// Lookups that fail.
{
  const db = reassignDb();
  assert.strictEqual(refusalOf(reassign(db, { id: 'nope' })), 'not_found: Schedule not found.');
  assert.strictEqual(refusalOf(reassign(db, { shiftTypeId: 'gone' })), 'invalid: Shift type no longer exists.');
  assert.strictEqual(refusalOf(reassign(db, { toUserId: 'ghost' })), 'not_found: Employee not found.');
  assert.strictEqual(refusalOf(reassign(db, { toUserId: null })), 'invalid: Pick an employee for the open shift.');
  assert.strictEqual(refusalOf(reassign(db, { date: '2099-01-20' })), 'not_found: Open shift not found.');
  assert.strictEqual(refusalOf(reassign(db, { fromUserId: 'cy' })), 'not_found: Assignment not found.');
}

// Non-admin forbidden.
{
  const db = reassignDb();
  assert.strictEqual(refusalOf(reassign(db, {}, 'cy')), 'forbidden: Admin access required.');
  assert.deepStrictEqual(db.schedules[0].unfilled, [dayShift, nightShift]);
}

// ---- delete ----
{
  const db = reassignDb();
  assert.strictEqual(refusalOf(deleteSchedule(db, as(db, 'cy'), { id: 'sch1' })), 'forbidden: Admin access required.');
  assert.strictEqual(refusalOf(deleteSchedule(db, as(db, 'admin'), { id: 'nope' })), 'not_found: Schedule not found.');
  assert.strictEqual(db.schedules.length, 1);
  value(deleteSchedule(db, as(db, 'admin'), { id: 'sch1' }));
  assert.deepStrictEqual(db.schedules, []);
}

// ---- through the route adapter: the confirmation contract's wire body, and a
// refusal leaves the data unchanged ----
{
  const store = (db: Db) => {
    const s = { db };
    const mutate: Mutate = async (fn) => {
      const draft = structuredClone(s.db);
      const result = await fn(draft);
      s.db = draft;
      return result;
    };
    return { s, mutate };
  };
  const db = reassignDb({ maxShiftsOverride: 2 });
  const before = structuredClone(db);
  const { s, mutate } = store(db);
  const input = { id: 'sch1', fromUserId: null, toUserId: 'bea', ...dayShift };
  const res = await runCommand(mutate, 'admin', TODAY, (d, ctx) => reassignShift(d, ctx, input));
  assert.deepStrictEqual(res, {
    status: 409,
    body: { error: atMax, code: 'eligibility_warnings', warnings: [{ kind: 'shift maximum', message: atMax }] },
  });
  assert.deepStrictEqual(s.db, before, 'unchanged');
}

console.log('All schedule tests passed.');
