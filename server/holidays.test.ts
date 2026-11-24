// Smoke test: tsx server/holidays.test.ts
import assert from 'assert';
import { createHoliday, editHoliday, deleteHoliday } from './holidays.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import type { Db, Holiday, User } from '../shared/types.js';

const TODAY = '2050-01-01';
const mkUser = (id: string, roles: string[]): User => ({ id, name: id, roles, vacationDays: 10, color: '#888' });
const xmas = (): Holiday => ({ id: 'xmas', name: 'Christmas', workable: false, recurrence: { type: 'yearly', month: 12, day: 25 } });
function mkDb(): Db {
  return {
    users: [mkUser('admin', ['role-employee', 'role-admin']), mkUser('emp', ['role-employee'])],
    roles: [], shiftTypes: [], settings: { maxVacationPerDay: 2 }, timeOff: [], schedules: [],
    trades: [], notifications: [], awayTime: [], holidays: [xmas()], meta: { rotationCursor: 0 },
  };
}
const as = (db: Db, uid: string): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today: TODAY });
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const refusal = (o: Outcome<unknown>) => (o.ok ? { reason: 'ok', message: '' } : { reason: o.refusal.reason, message: o.refusal.message });

const july4 = { type: 'yearly', month: 7, day: 4 };

// ---- create ----
{
  const db = mkDb();
  const h = value(createHoliday(db, as(db, 'admin'), { name: ' Independence Day ', recurrence: july4, workable: 1 }));
  assert.equal(h.name, 'Independence Day');
  assert.equal(h.workable, true);
  assert.deepEqual(h.recurrence, july4);
  assert.ok(h.id.startsWith('hol-'));
  assert.equal(db.holidays.length, 2);
}
{
  const db = mkDb();
  assert.deepEqual(refusal(createHoliday(db, as(db, 'admin'), { name: '', recurrence: july4 })),
    { reason: 'invalid', message: 'A holiday needs a name.' });
  assert.deepEqual(refusal(createHoliday(db, as(db, 'admin'), { name: 5, recurrence: july4 })),
    { reason: 'invalid', message: 'A holiday needs a name.' });
  assert.deepEqual(refusal(createHoliday(db, as(db, 'admin'), { name: 'X', recurrence: { type: 'yearly', month: 13, day: 1 } })),
    { reason: 'invalid', message: 'A holiday needs a valid recurrence.' });
  assert.deepEqual(refusal(createHoliday(db, as(db, 'emp'), { name: 'X', recurrence: july4 })),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.equal(db.holidays.length, 1);
}

// ---- edit: only the fields sent change ----
{
  const db = mkDb();
  const h = value(editHoliday(db, as(db, 'admin'), { id: 'xmas', workable: true, expectedVersion: 1 }));
  assert.equal(h.name, 'Christmas');
  assert.equal(h.workable, true);
  assert.equal(h.version, 2);
  const h2 = value(editHoliday(db, as(db, 'admin'), { id: 'xmas', name: ' Xmas ', recurrence: july4 }));
  assert.equal(h2.name, 'Xmas');
  assert.deepEqual(h2.recurrence, july4);
  assert.equal(h2.version, 3);
}
{
  const db = mkDb();
  assert.deepEqual(refusal(editHoliday(db, as(db, 'admin'), { id: 'xmas', workable: true, expectedVersion: 4 })),
    { reason: 'stale', message: 'The holiday "Christmas" was changed by someone else — the view has been refreshed with the latest data. Please retry.' });
  assert.deepEqual(refusal(editHoliday(db, as(db, 'admin'), { id: 'nope' })),
    { reason: 'not_found', message: 'Holiday not found.' });
  assert.deepEqual(refusal(editHoliday(db, as(db, 'admin'), { id: 'xmas', name: '' })),
    { reason: 'invalid', message: 'A holiday needs a name.' });
  assert.deepEqual(refusal(editHoliday(db, as(db, 'admin'), { id: 'xmas', recurrence: { type: 'bogus' } })),
    { reason: 'invalid', message: 'A holiday needs a valid recurrence.' });
  assert.deepEqual(refusal(editHoliday(db, as(db, 'emp'), { id: 'xmas', workable: true })),
    { reason: 'forbidden', message: 'Admin access required.' });
}

// ---- delete ----
{
  const db = mkDb();
  assert.deepEqual(refusal(deleteHoliday(db, as(db, 'emp'), { id: 'xmas' })),
    { reason: 'forbidden', message: 'Admin access required.' });
  assert.deepEqual(refusal(deleteHoliday(db, as(db, 'admin'), { id: 'nope' })),
    { reason: 'not_found', message: 'Holiday not found.' });
  assert.deepEqual(value(deleteHoliday(db, as(db, 'admin'), { id: 'xmas' })), { ok: true });
  assert.equal(db.holidays.length, 0);
}

// ---- through the adapter: a recurrence refused after a rename leaves the data unchanged ----
{
  let db = mkDb();
  const mutate: Mutate = async (fn) => { const draft = structuredClone(db); const r = await fn(draft); db = draft; return r; };
  const res = await runCommand(mutate, 'admin', TODAY, (d, ctx) =>
    editHoliday(d, ctx, { id: 'xmas', name: 'Renamed', recurrence: { type: 'bogus' } }));
  assert.equal(res.status, 400);
  assert.deepEqual(db.holidays[0], xmas());
}

console.log('holidays tests passed');
