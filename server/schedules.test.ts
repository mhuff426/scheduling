// Smoke test: tsx server/schedules.test.ts
import assert from 'assert';
import { buildSchedule } from './schedules.js';
import type { CommandContext, Outcome } from './outcome.js';
import type { Db, ShiftType, User } from '../shared/types.js';

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
const refusalOf = (o: Outcome<unknown>) => (o.ok ? 'ok' : `${o.refusal.reason}: ${o.refusal.message}`);

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

console.log('All schedule tests passed.');
