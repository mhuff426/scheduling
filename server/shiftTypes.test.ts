// Smoke test: tsx server/shiftTypes.test.ts
import assert from 'assert';
import { createShiftType, editShiftType, deleteShiftType } from './shiftTypes.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import type { Db, ShiftType, User } from '../shared/types.js';

const TODAY = '2050-01-01';
const mkUser = (id: string, roles: string[]): User => ({ id, name: id, roles, vacationDays: 10, color: '#888' });
const day = (): ShiftType => ({ id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 });
function mkDb(): Db {
  return {
    users: [mkUser('admin', ['role-employee', 'role-admin']), mkUser('emp', ['role-employee'])],
    roles: [], shiftTypes: [day()], settings: { maxVacationPerDay: 2 }, timeOff: [], schedules: [],
    trades: [], notifications: [], awayTime: [], holidays: [], meta: { rotationCursor: 0 },
  };
}
const as = (db: Db, uid: string): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today: TODAY });
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const refusal = (o: Outcome<unknown>) => (o.ok ? { reason: 'ok', message: '' } : { reason: o.refusal.reason, message: o.refusal.message });

const valid = { name: '  Night  ', startTime: '22:00', endTime: '06:00' };

// ---- create ----
{
  const db = mkDb();
  const st = value(createShiftType(db, as(db, 'admin'), valid));
  assert.equal(st.name, 'Night');
  assert.ok(st.id.startsWith('s-'));
  assert.deepEqual(db.shiftTypes.map((s) => s.name), ['Day', 'Night']);
  // Defaults: daily, staff 1, run 1..none, automatic weight, anyone.
  assert.equal(st.frequency, 'daily');
  assert.equal(st.dayOfWeek, null);
  assert.equal(st.staffRequired, 1);
  assert.equal(st.minRun, 1);
  assert.equal(st.maxRun, null);
  assert.equal(st.weight, null);
  assert.deepEqual(st.allowedRoles, []);
}
{
  // Clamps: weekly day 0..6, max run never below min run, weight 0 kept.
  const db = mkDb();
  const st = value(createShiftType(db, as(db, 'admin'), {
    ...valid, frequency: 'weekly', dayOfWeek: 9, staffRequired: 0, minRun: 3, maxRun: 2, weight: 0,
    allowedRoles: ['role-a', 7],
  }));
  assert.equal(st.dayOfWeek, 6);
  assert.equal(st.staffRequired, 1);
  assert.equal(st.minRun, 3);
  assert.equal(st.maxRun, 3);
  assert.equal(st.weight, 0);
  assert.deepEqual(st.allowedRoles, ['role-a']);
}
{
  const db = mkDb();
  assert.deepEqual(refusal(createShiftType(db, as(db, 'admin'), { ...valid, name: '   ' })),
    { reason: 'invalid', message: 'Shift name is required.' });
  assert.deepEqual(refusal(createShiftType(db, as(db, 'admin'), { ...valid, startTime: '8am' })),
    { reason: 'invalid', message: 'Start and end times are required (HH:MM).' });
  assert.deepEqual(refusal(createShiftType(db, as(db, 'admin'), { ...valid, endTime: undefined })),
    { reason: 'invalid', message: 'Start and end times are required (HH:MM).' });
  assert.deepEqual(refusal(createShiftType(db, as(db, 'emp'), valid)),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.equal(db.shiftTypes.length, 1);
}

// ---- edit ----
{
  const db = mkDb();
  const st = value(editShiftType(db, as(db, 'admin'), { ...valid, id: 'day', expectedVersion: 1 }));
  assert.equal(st, db.shiftTypes[0], 'edited in place so schedules keep the id');
  assert.equal(st.id, 'day');
  assert.equal(st.name, 'Night');
  assert.equal(st.version, 2);
  // No expectedVersion skips the check.
  assert.equal(value(editShiftType(db, as(db, 'admin'), { ...valid, id: 'day' })).version, 3);
}
{
  const db = mkDb();
  assert.deepEqual(refusal(editShiftType(db, as(db, 'admin'), { ...valid, id: 'day', expectedVersion: 5 })),
    { reason: 'stale', message: 'The shift type "Day" was changed by someone else — the view has been refreshed with the latest data. Please retry.' });
  assert.deepEqual(refusal(editShiftType(db, as(db, 'admin'), { ...valid, id: 'nope' })),
    { reason: 'not_found', message: 'Shift type not found.' });
  assert.deepEqual(refusal(editShiftType(db, as(db, 'admin'), { ...valid, id: 'day', name: '' })),
    { reason: 'invalid', message: 'Shift name is required.' });
  assert.deepEqual(refusal(editShiftType(db, as(db, 'emp'), { ...valid, id: 'day' })),
    { reason: 'forbidden', message: 'Admin access required.' });
}

// ---- delete ----
{
  const db = mkDb();
  assert.deepEqual(refusal(deleteShiftType(db, as(db, 'emp'), { id: 'day' })),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.deepEqual(refusal(deleteShiftType(db, as(db, 'admin'), { id: 'nope' })),
    { reason: 'not_found', message: 'Shift type not found.' });
  assert.deepEqual(value(deleteShiftType(db, as(db, 'admin'), { id: 'day' })), { ok: true });
  assert.equal(db.shiftTypes.length, 0);
}

// ---- through the adapter: a refused edit leaves the data unchanged ----
{
  let db = mkDb();
  const mutate: Mutate = async (fn) => { const draft = structuredClone(db); const r = await fn(draft); db = draft; return r; };
  const res = await runCommand(mutate, 'admin', TODAY, (d, ctx) =>
    editShiftType(d, ctx, { ...valid, id: 'day', expectedVersion: 9 }));
  assert.equal(res.status, 409);
  assert.equal((res.body as any).code, 'version_conflict');
  assert.equal(db.shiftTypes[0].name, 'Day');
}

console.log('shiftTypes tests passed');
