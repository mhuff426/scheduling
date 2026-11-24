// Smoke test: tsx server/people.test.ts
import assert from 'assert';
import { createPerson, editPerson, removePerson, createRole, renameRole, deleteRole } from './people.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import type { Db, User } from '../shared/types.js';

const TODAY = '2050-01-01';
const mkUser = (id: string, name: string, roles: string[], extra: Partial<User> = {}): User => ({
  id, name, roles, vacationDays: 10, color: '#888', ...extra,
});
function mkDb(): Db {
  return {
    users: [
      mkUser('admin', 'Ada', ['role-admin', 'role-employee'], { email: 'ada@x.com' }),
      mkUser('bea', 'Bea', ['role-employee'], { email: 'bea@x.com' }),
    ],
    roles: [
      { id: 'role-admin', name: 'Admin', system: true },
      { id: 'role-employee', name: 'Employee', system: true },
      { id: 'role-cook', name: 'Cook' },
    ],
    shiftTypes: [],
    settings: { maxVacationPerDay: 2 },
    timeOff: [], schedules: [], trades: [], notifications: [], awayTime: [], holidays: [],
    meta: { rotationCursor: 0 },
  };
}
const as = (db: Db, uid: string): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today: TODAY });
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const refusalOf = (o: Outcome<unknown>) => (o.ok ? 'ok' : [o.refusal.reason, o.refusal.message]);

// ---- creating a person: the Employee role is always added, unknown roles dropped ----
{
  const db = mkDb();
  const u = value(createPerson(db, as(db, 'admin'), {
    firstName: ' Cy ', lastName: 'Dee', email: ' CY@X.com ', roles: ['role-cook', 'role-bogus'],
  }));
  assert.deepStrictEqual(u.roles, ['role-cook', 'role-employee']);
  assert.strictEqual(u.name, 'Cy Dee');
  assert.strictEqual(u.email, 'cy@x.com');
  assert.ok(db.users.includes(u), 'person added');
}

// ---- creating a person: a duplicate email is refused, whatever its case ----
{
  const db = mkDb();
  assert.deepStrictEqual(
    refusalOf(createPerson(db, as(db, 'admin'), { firstName: 'B', lastName: 'Two', email: 'BEA@x.com' })),
    ['conflict', 'A user with that email already exists.']);
  assert.strictEqual(db.users.length, 2);
}

// ---- only someone who manages people may create one ----
{
  const db = mkDb();
  assert.deepStrictEqual(
    refusalOf(createPerson(db, as(db, 'bea'), { firstName: 'Cy', lastName: 'Dee', email: 'cy@x.com' })),
    ['forbidden', 'Admin access required.']);
}

// ---- editing a person: roles are fixed up the same way, and the version bumps ----
{
  const db = mkDb();
  const u = value(editPerson(db, as(db, 'admin'), { id: 'bea', roles: ['role-cook'], vacationDays: 12, expectedVersion: 1 }));
  assert.deepStrictEqual(u.roles, ['role-cook', 'role-employee']);
  assert.strictEqual(u.vacationDays, 12);
  assert.strictEqual(u.version, 2);
}

// ---- editing a person: a stale version is refused ----
{
  const db = mkDb();
  db.users[1].version = 3;
  assert.deepStrictEqual(
    refusalOf(editPerson(db, as(db, 'admin'), { id: 'bea', vacationDays: 1, expectedVersion: 2 })),
    ['stale', "Bea's profile was changed by someone else — the view has been refreshed with the latest data. Please retry."]);
}

// ---- editing a person: a duplicate email is refused, their own is fine ----
{
  const db = mkDb();
  assert.deepStrictEqual(refusalOf(editPerson(db, as(db, 'admin'), { id: 'bea', email: 'ada@x.com' })),
    ['conflict', 'A user with that email already exists.']);
  assert.strictEqual(value(editPerson(db, as(db, 'admin'), { id: 'bea', email: 'BEA@x.com' })).email, 'bea@x.com');
}

// ---- the last admin can't lose the Admin role; once there's another admin they can ----
{
  const db = mkDb();
  assert.deepStrictEqual(refusalOf(editPerson(db, as(db, 'admin'), { id: 'admin', roles: ['role-employee'] })),
    ['invalid', 'Ada is the only admin. Make someone else an admin first.']);
  assert.ok(db.users[0].roles.includes('role-admin'));
  value(editPerson(db, as(db, 'admin'), { id: 'bea', roles: ['role-admin'] }));
  assert.deepStrictEqual(value(editPerson(db, as(db, 'admin'), { id: 'admin', roles: [] })).roles, ['role-employee']);
}

// ---- editing: unknown person, and non-admin refused ----
{
  const db = mkDb();
  assert.deepStrictEqual(refusalOf(editPerson(db, as(db, 'admin'), { id: 'nope' })), ['not_found', 'User not found.']);
  assert.deepStrictEqual(refusalOf(editPerson(db, as(db, 'bea'), { id: 'bea', vacationDays: 99 })),
    ['forbidden', 'Admin access required.']);
}

// ---- removing a person takes their must-off days and away time with them ----
{
  const db = mkDb();
  db.timeOff = [
    { id: 't1', userId: 'bea', date: '2050-02-01', type: 'vacation' } as any,
    { id: 't2', userId: 'admin', date: '2050-02-01', type: 'vacation' } as any,
  ];
  db.awayTime = [{ id: 'a1', userId: 'bea' } as any, { id: 'a2', userId: 'admin' } as any];
  value(removePerson(db, as(db, 'admin'), { id: 'bea' }));
  assert.deepStrictEqual(db.users.map((u) => u.id), ['admin']);
  assert.deepStrictEqual(db.timeOff.map((t) => t.id), ['t2']);
  assert.deepStrictEqual(db.awayTime.map((a) => a.id), ['a2']);
}

// ---- the last admin can't be removed; unknown person; non-admin refused ----
{
  const db = mkDb();
  assert.deepStrictEqual(refusalOf(removePerson(db, as(db, 'admin'), { id: 'admin' })),
    ['invalid', "Ada is the only admin and can't be removed. Make someone else an admin first."]);
  assert.deepStrictEqual(refusalOf(removePerson(db, as(db, 'admin'), { id: 'nope' })), ['not_found', 'User not found.']);
  assert.deepStrictEqual(refusalOf(removePerson(db, as(db, 'bea'), { id: 'bea' })), ['forbidden', 'Admin access required.']);
  assert.strictEqual(db.users.length, 2);
}

// ---- roles: create and rename refuse a duplicate name, whatever its case ----
{
  const db = mkDb();
  const r = value(createRole(db, as(db, 'admin'), { name: ' Grill ' }));
  assert.strictEqual(r.name, 'Grill');
  assert.deepStrictEqual(refusalOf(createRole(db, as(db, 'admin'), { name: 'cook' })),
    ['invalid', 'A role with that name already exists.']);
  assert.deepStrictEqual(refusalOf(createRole(db, as(db, 'admin'), { name: ' ' })), ['invalid', 'Role name is required.']);
  assert.deepStrictEqual(refusalOf(renameRole(db, as(db, 'admin'), { id: r.id, name: 'COOK' })),
    ['invalid', 'A role with that name already exists.']);
  const renamed = value(renameRole(db, as(db, 'admin'), { id: r.id, name: 'Griddle', expectedVersion: 1 }));
  assert.deepStrictEqual([renamed.name, renamed.version], ['Griddle', 2]);
  assert.deepStrictEqual(refusalOf(renameRole(db, as(db, 'admin'), { id: r.id, name: 'Fry', expectedVersion: 1 })),
    ['stale', 'The role "Griddle" was changed by someone else — the view has been refreshed with the latest data. Please retry.']);
}

// ---- system roles can't be renamed or deleted ----
{
  const db = mkDb();
  assert.deepStrictEqual(refusalOf(renameRole(db, as(db, 'admin'), { id: 'role-admin', name: 'Boss' })),
    ['invalid', 'System roles cannot be renamed.']);
  assert.deepStrictEqual(refusalOf(deleteRole(db, as(db, 'admin'), { id: 'role-employee' })),
    ['invalid', 'System roles cannot be deleted.']);
  assert.deepStrictEqual(refusalOf(deleteRole(db, as(db, 'admin'), { id: 'nope' })), ['not_found', 'Role not found.']);
  assert.strictEqual(db.roles.length, 3);
}

// ---- deleting a role removes it from every person and every shift type ----
{
  const db = mkDb();
  db.users[1].roles = ['role-cook', 'role-employee'];
  db.shiftTypes = [
    { id: 'grill', name: 'Grill', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, allowedRoles: ['role-cook'] },
    { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 },
  ];
  value(deleteRole(db, as(db, 'admin'), { id: 'role-cook' }));
  assert.deepStrictEqual(db.roles.map((r) => r.id), ['role-admin', 'role-employee']);
  assert.deepStrictEqual(db.users[1].roles, ['role-employee']);
  assert.deepStrictEqual(db.shiftTypes.map((s) => s.allowedRoles), [[], []]);
}

// ---- only someone who manages people may change roles ----
{
  const db = mkDb();
  const forbidden = ['forbidden', 'Admin access required.'];
  assert.deepStrictEqual(refusalOf(createRole(db, as(db, 'bea'), { name: 'Grill' })), forbidden);
  assert.deepStrictEqual(refusalOf(renameRole(db, as(db, 'bea'), { id: 'role-cook', name: 'Chef' })), forbidden);
  assert.deepStrictEqual(refusalOf(deleteRole(db, as(db, 'bea'), { id: 'role-cook' })), forbidden);
}

// ---- through the route adapter: a refusal leaves the data unchanged ----
const adapterTests = async () => {
  const db = mkDb();
  const before = structuredClone(db);
  let saved = db;
  const mutate: Mutate = async (fn) => {
    const draft = structuredClone(saved);
    const result = await fn(draft);
    saved = draft;
    return result;
  };
  // The email changes before the roles are refused; the refusal undoes it.
  const res = await runCommand(mutate, 'admin', TODAY, (d, ctx) =>
    editPerson(d, ctx, { id: 'admin', email: 'new@x.com', roles: [] }));
  assert.deepStrictEqual(res, { status: 400, body: { error: 'Ada is the only admin. Make someone else an admin first.' } });
  assert.deepStrictEqual(saved, before, 'unchanged');
};

adapterTests().then(() => console.log('people tests passed'), (e) => { console.error(e); process.exit(1); });
