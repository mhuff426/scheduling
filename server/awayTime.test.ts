// Smoke test: tsx server/awayTime.test.ts
import assert from 'assert';
import { createAwayTime, editAwayTime, deleteAwayTime } from './awayTime.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import type { AwayTime, Db, User } from '../shared/types.js';

const TODAY = '2050-01-01';
const mkUser = (id: string, roles: string[]): User => ({ id, name: id, roles, vacationDays: 10, color: '#888' });
const trip = (): AwayTime => ({ id: 'aw1', userId: 'emp', start: '2050-02-01', end: '2050-02-05', label: 'Training', memo: 'Off-site course' });
function mkDb(): Db {
  return {
    users: [mkUser('admin', ['role-employee', 'role-admin']), mkUser('emp', ['role-employee'])],
    roles: [], shiftTypes: [], settings: { maxVacationPerDay: 2 }, timeOff: [], schedules: [],
    trades: [], notifications: [], awayTime: [trip()], holidays: [], meta: { rotationCursor: 0 },
  };
}
const as = (db: Db, uid: string): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today: TODAY });
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const refusal = (o: Outcome<unknown>) => (o.ok ? { reason: 'ok', message: '' } : { reason: o.refusal.reason, message: o.refusal.message });

const range = { userId: 'emp', start: '2050-03-01', end: '2050-03-03' };

// ---- create: label and memo trimmed and stored; blank ones collapse to absent ----
{
  const db = mkDb();
  const e = value(createAwayTime(db, as(db, 'admin'), { ...range, label: '  Jury duty ', memo: '  Summons #42  ' }));
  assert.equal(e.label, 'Jury duty');
  assert.equal(e.memo, 'Summons #42');
  assert.ok(e.id.startsWith('aw-'));
  assert.equal(db.awayTime.length, 2);

  const bare = value(createAwayTime(db, as(db, 'admin'), { ...range, label: '   ', memo: '\n\t ' }));
  assert.ok(!('label' in bare), 'blank label collapses to absent');
  assert.ok(!('memo' in bare), 'blank memo collapses to absent');
}
{
  // Over-long text is cut to its limit (label 255, memo 10000).
  const db = mkDb();
  const e = value(createAwayTime(db, as(db, 'admin'), { ...range, label: 'x'.repeat(300), memo: 'y'.repeat(10050) }));
  assert.equal(e.label!.length, 255);
  assert.equal(e.memo!.length, 10000);
}
{
  // A single day (end == start) is fine.
  const db = mkDb();
  value(createAwayTime(db, as(db, 'admin'), { ...range, end: range.start }));
}
{
  const db = mkDb();
  assert.deepEqual(refusal(createAwayTime(db, as(db, 'emp'), range)),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.deepEqual(refusal(createAwayTime(db, as(db, 'admin'), { ...range, userId: 'ghost' })),
    { reason: 'not_found', message: 'User not found.' });
  assert.deepEqual(refusal(createAwayTime(db, as(db, 'admin'), { ...range, start: 'March 1' })),
    { reason: 'invalid', message: 'Away time needs a valid start and end date.' });
  assert.deepEqual(refusal(createAwayTime(db, as(db, 'admin'), { ...range, end: undefined })),
    { reason: 'invalid', message: 'Away time needs a valid start and end date.' });
  assert.deepEqual(refusal(createAwayTime(db, as(db, 'admin'), { ...range, end: '2050-02-28' })),
    { reason: 'invalid', message: 'The away end date must be on or after the start date.' });
  assert.equal(db.awayTime.length, 1);
}

// ---- edit ----
{
  // Unsent fields keep their values.
  const db = mkDb();
  const e = value(editAwayTime(db, as(db, 'admin'), { id: 'aw1', end: '2050-02-09', expectedVersion: 1 }));
  assert.deepEqual(e, { ...trip(), end: '2050-02-09', version: 2 });
}
{
  // A blank memo or label sent clears it; a new memo is trimmed and stored.
  const db = mkDb();
  const e = value(editAwayTime(db, as(db, 'admin'), { id: 'aw1', label: '  ', memo: ' New note ' }));
  assert.equal(e.label, undefined);
  assert.equal(e.memo, 'New note');
}
{
  const db = mkDb();
  assert.deepEqual(refusal(editAwayTime(db, as(db, 'admin'), { id: 'aw1', end: '2050-02-09', expectedVersion: 3 })),
    { reason: 'stale', message: 'This away-time range was changed by someone else — the view has been refreshed with the latest data. Please retry.' });
  assert.deepEqual(refusal(editAwayTime(db, as(db, 'admin'), { id: 'nope' })),
    { reason: 'not_found', message: 'Away time not found.' });
  assert.deepEqual(refusal(editAwayTime(db, as(db, 'admin'), { id: 'aw1', start: '' })),
    { reason: 'invalid', message: 'Away time needs a valid start and end date.' });
  // Only the start moves, past the kept end.
  assert.deepEqual(refusal(editAwayTime(db, as(db, 'admin'), { id: 'aw1', start: '2050-02-06' })),
    { reason: 'invalid', message: 'The away end date must be on or after the start date.' });
  assert.deepEqual(refusal(editAwayTime(db, as(db, 'emp'), { id: 'aw1', end: '2050-02-09' })),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.deepEqual(db.awayTime[0], trip());
}

// ---- delete ----
{
  const db = mkDb();
  assert.deepEqual(refusal(deleteAwayTime(db, as(db, 'emp'), { id: 'aw1' })),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.deepEqual(refusal(deleteAwayTime(db, as(db, 'admin'), { id: 'nope' })),
    { reason: 'not_found', message: 'Away time not found.' });
  assert.deepEqual(value(deleteAwayTime(db, as(db, 'admin'), { id: 'aw1' })), { ok: true });
  assert.equal(db.awayTime.length, 0);
}

// ---- through the adapter: a refused create stores nothing ----
{
  let db = mkDb();
  const mutate: Mutate = async (fn) => { const draft = structuredClone(db); const r = await fn(draft); db = draft; return r; };
  const res = await runCommand(mutate, 'admin', TODAY, (d, ctx) =>
    createAwayTime(d, ctx, { ...range, end: '2050-01-01' }));
  assert.equal(res.status, 400);
  assert.deepEqual(db.awayTime, [trip()]);
}

console.log('awayTime tests passed');
