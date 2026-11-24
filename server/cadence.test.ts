// Smoke test: tsx server/cadence.test.ts
import assert from 'assert';
import { updateSettings } from './cadence.js';
import { type CommandContext, type Outcome } from './outcome.js';
import { cadenceChangeProblem } from '../shared/blocks.js';
import type { Cadence, Db, User } from '../shared/types.js';

// Commands run as of TODAY.
const TODAY = '2050-01-01';
const YESTERDAY = '2049-12-31';
const TOMORROW = '2050-01-02';

const mkUser = (id: string, roles: string[]): User => ({ id, name: id, roles, vacationDays: 10, color: '#888' });
function mkDb(cadence?: Cadence): Db {
  return {
    users: [mkUser('admin', ['role-admin', 'role-employee']), mkUser('emp', ['role-employee'])],
    roles: [], shiftTypes: [], timeOff: [], schedules: [], trades: [],
    notifications: [], awayTime: [], holidays: [],
    settings: { maxVacationPerDay: 2, ...(cadence ? { cadence } : {}) },
    meta: { rotationCursor: 0 },
  };
}
const twoWeeks = (anchorDate: string): Cadence => ({ anchorDate, lengthUnit: 'weeks', lengthValue: 2 });

const as = (db: Db, uid: string, today = TODAY): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today });
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const msg = (o: Outcome<unknown>) => (o.ok ? '' : o.refusal.message);
const reasonOf = (o: Outcome<unknown>) => (o.ok ? 'ok' : o.refusal.reason);

// ---- a changed cadence must start after today ----
{
  const db = mkDb(twoWeeks('2049-06-01'));
  const o = updateSettings(db, as(db, 'admin'), { cadence: twoWeeks(TODAY) });
  assert.strictEqual(reasonOf(o), 'invalid', 'changed cadence starting today is refused');
  assert.strictEqual(msg(o), 'A new schedule start date must be in the future.');
}

// ---- a changed cadence starting tomorrow is accepted and bumps the version ----
{
  const db = mkDb(twoWeeks('2049-06-01'));
  const s = value(updateSettings(db, as(db, 'admin'), { cadence: twoWeeks(TOMORROW), expectedVersion: 1 }));
  assert.deepStrictEqual(s.cadence, twoWeeks(TOMORROW), 'changed cadence starting tomorrow is saved');
  assert.strictEqual(s.version, 2, 'version bumped');
}

// ---- a first cadence may start today, but not yesterday ----
{
  const db = mkDb();
  value(updateSettings(db, as(db, 'admin'), { cadence: twoWeeks(TODAY) }));
  assert.deepStrictEqual(db.settings.cadence, twoWeeks(TODAY), 'first cadence starting today is saved');
}
{
  const db = mkDb();
  const o = updateSettings(db, as(db, 'admin'), { cadence: twoWeeks(YESTERDAY) });
  assert.strictEqual(reasonOf(o), 'invalid', 'first cadence starting yesterday is refused');
  assert.strictEqual(msg(o), 'The schedule start date cannot be in the past.');
}

// ---- resaving the cadence unchanged is exempt from the rule ----
{
  const db = mkDb(twoWeeks('2049-06-01'));
  value(updateSettings(db, as(db, 'admin'), { cadence: twoWeeks('2049-06-01'), maxVacationPerDay: 3 }));
  assert.strictEqual(db.settings.maxVacationPerDay, 3, 'other settings saved alongside an unchanged cadence');
}

// ---- invalid shape ----
for (const bad of [
  { anchorDate: 'soon', lengthUnit: 'weeks', lengthValue: 2 },
  { anchorDate: TOMORROW, lengthUnit: 'fortnights', lengthValue: 2 },
  { anchorDate: TOMORROW, lengthUnit: 'weeks', lengthValue: 0 },
  { anchorDate: TOMORROW, lengthUnit: 'weeks', lengthValue: 1.5 },
  null,
]) {
  const db = mkDb();
  const o = updateSettings(db, as(db, 'admin'), { cadence: bad, maxVacationPerDay: 5 });
  assert.strictEqual(reasonOf(o), 'invalid', `invalid cadence refused: ${JSON.stringify(bad)}`);
  assert.strictEqual(msg(o), 'Invalid cadence: need an anchor date, a positive whole number, and a unit.');
  assert.strictEqual(db.settings.maxVacationPerDay, 2, 'nothing changed before the refusal');
}

// ---- stale version ----
{
  const db = mkDb();
  db.settings.version = 4;
  const o = updateSettings(db, as(db, 'admin'), { maxVacationPerDay: 5, expectedVersion: 3 });
  assert.strictEqual(reasonOf(o), 'stale', 'stale settings version refused');
  assert.strictEqual(msg(o), 'Settings was changed by someone else — the view has been refreshed with the latest data. Please retry.');
  assert.strictEqual(db.settings.maxVacationPerDay, 2, 'stale refusal changes nothing');
}

// ---- non-admin forbidden ----
{
  const db = mkDb();
  const o = updateSettings(db, as(db, 'emp'), { maxVacationPerDay: 5 });
  assert.strictEqual(reasonOf(o), 'forbidden', 'needs configure scheduling');
  assert.strictEqual(msg(o), 'Admin access required.');
}

// ---- number clamps ----
{
  const db = mkDb();
  const s = value(updateSettings(db, as(db, 'admin'), { maxVacationPerDay: 0, holidaysRequiredPerYear: -3 }));
  assert.strictEqual(s.maxVacationPerDay, 1, 'per-day limit is at least 1');
  assert.strictEqual(s.holidaysRequiredPerYear, 0, 'holidays required is at least 0');
}

// ---- the shared rule, as the Settings form calls it ----
assert.strictEqual(cadenceChangeProblem(twoWeeks('2049-06-01'), twoWeeks(TODAY), TODAY), 'A new schedule start date must be in the future.');
assert.strictEqual(cadenceChangeProblem(twoWeeks('2049-06-01'), twoWeeks(TOMORROW), TODAY), null);
assert.strictEqual(cadenceChangeProblem(null, twoWeeks(TODAY), TODAY), null);
assert.strictEqual(cadenceChangeProblem(undefined, twoWeeks(YESTERDAY), TODAY), 'The schedule start date cannot be in the past.');
assert.strictEqual(cadenceChangeProblem(twoWeeks(YESTERDAY), twoWeeks(YESTERDAY), TODAY), null, 'unchanged is never a problem');

console.log('cadence tests passed');
