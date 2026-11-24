// Smoke test: tsx server/projection.test.ts
// What a viewer receives for each read (ADR 0002), against an in-memory Db.
import assert from 'assert';
import { project } from './projection.js';
import type { Db } from '../shared/types.js';

function fixture(): Db {
  return {
    users: [
      { id: 'u-admin', name: 'Ada Admin', firstName: 'Ada', lastName: 'Admin', email: 'ada@x.test', roles: ['role-admin', 'role-employee'], vacationDays: 15, color: '#111111', requiredShifts: null },
      { id: 'u-emp', name: 'Eve Employee', firstName: 'Eve', lastName: 'Employee', email: 'eve@x.test', roles: ['role-employee'], vacationDays: 10, color: '#222222', requiredShifts: null },
    ],
    roles: [
      { id: 'role-admin', name: 'Admin', system: true },
      { id: 'role-employee', name: 'Employee', system: true },
    ],
    shiftTypes: [],
    settings: { maxVacationPerDay: 2, cadence: null, holidaysRequiredPerYear: 0 },
    timeOff: [{ id: 't1', userId: 'u-emp', date: '2026-12-01', type: 'vacation' } as any],
    schedules: [],
    trades: [],
    notifications: [],
    awayTime: [{ id: 'a1', userId: 'u-emp', start: '2026-12-10', end: '2026-12-12', label: 'Away', memo: 'admin note' } as any],
    holidays: [],
    meta: { rotationCursor: 0 },
  };
}

// ---- an anonymous viewer is refused the full dump ----
{
  const r = project(fixture(), null, { kind: 'state' });
  assert.deepStrictEqual(r, { refused: 'unauthenticated' });
}

// ---- an anonymous viewer is refused every named tab and the user list ----
{
  for (const tab of ['schedule', 'preferences', 'trades', 'admin']) {
    assert.deepStrictEqual(project(fixture(), null, { kind: 'tab', tab }), { refused: 'unauthenticated' }, tab);
  }
  assert.deepStrictEqual(project(fixture(), null, { kind: 'users', registered: {} }), { refused: 'unauthenticated' });
}

// ---- a session for a user who no longer exists counts as nobody signed in ----
{
  assert.deepStrictEqual(project(fixture(), 'u-deleted', { kind: 'tab', tab: 'schedule' }), { refused: 'unauthenticated' });
}

// ---- an employee is refused the admin tab and the full dump ----
{
  assert.deepStrictEqual(project(fixture(), 'u-emp', { kind: 'state' }), { refused: 'forbidden' });
  assert.deepStrictEqual(project(fixture(), 'u-emp', { kind: 'tab', tab: 'admin' }), { refused: 'forbidden' });
}

// ---- an unknown tab is not found ----
{
  assert.deepStrictEqual(project(fixture(), 'u-admin', { kind: 'tab', tab: 'nope' }), { refused: 'not_found' });
}

// ---- an admin gets the full dump, away memos and preference standings included ----
{
  const r = project(fixture(), 'u-admin', { kind: 'state' });
  assert.ok('state' in r);
  assert.strictEqual(r.state.users.length, 2);
  assert.strictEqual((r.state.awayTime[0] as any).memo, 'admin note');
  assert.strictEqual(r.state.timeOff.length, 1);
  assert.ok(r.state.preferenceStandings, 'standings present');
}

// ---- an admin gets the admin tab with standings ----
{
  const r = project(fixture(), 'u-admin', { kind: 'tab', tab: 'admin' });
  assert.ok('state' in r);
  assert.strictEqual(r.state.roles.length, 2);
  assert.strictEqual((r.state.awayTime[0] as any).memo, 'admin note');
  assert.ok(r.state.preferenceStandings, 'standings present');
}

// ---- an employee's other tab reads carry only that tab's collections ----
{
  const r = project(fixture(), 'u-emp', { kind: 'tab', tab: 'preferences' });
  assert.ok('state' in r);
  assert.strictEqual(r.state.timeOff.length, 1, 'own must-off day');
  assert.strictEqual(r.state.awayTime.length, 1, 'own away time');
  assert.deepStrictEqual(r.state.users, [], 'users come from the user list, not the tab');
  assert.deepStrictEqual(r.state.roles, [], 'roles are not on this tab');
  assert.strictEqual(r.state.preferenceStandings, undefined, 'no standings');

  const t = project(fixture(), 'u-emp', { kind: 'tab', tab: 'trades' });
  assert.ok('state' in t);
  assert.deepStrictEqual(t.state.timeOff, [], 'must-off days are not on the trades tab');
  assert.strictEqual(t.state.settings.maxVacationPerDay, 2, 'unrequested settings are the defaults');
}

// ---- away time (#56): an employee sees only their own, with its label and without any away memo ----
function awayFixture(): Db {
  const db = fixture();
  db.awayTime = [
    { id: 'a-own', userId: 'u-emp', start: '2026-12-10', end: '2026-12-12', label: 'Training', memo: 'own memo' },
    { id: 'a-own-bare', userId: 'u-emp', start: '2027-01-05', end: '2027-01-05' },
    { id: 'a-other', userId: 'u-admin', start: '2026-12-20', end: '2026-12-24', label: 'Conference', memo: 'other memo' },
  ];
  return db;
}
{
  for (const tab of ['preferences', 'schedule', 'trades']) {
    const r = project(awayFixture(), 'u-emp', { kind: 'tab', tab });
    assert.ok('state' in r, tab);
    assert.ok(r.state.awayTime.every((a) => a.userId === 'u-emp'), `${tab}: only own away time`);
    assert.ok(!JSON.stringify(r).includes('memo'), `${tab}: no away memo anywhere in the response`);
  }
  const r = project(awayFixture(), 'u-emp', { kind: 'tab', tab: 'preferences' });
  assert.ok('state' in r);
  assert.deepStrictEqual(r.state.awayTime, [
    { id: 'a-own', userId: 'u-emp', start: '2026-12-10', end: '2026-12-12', label: 'Training' },
    { id: 'a-own-bare', userId: 'u-emp', start: '2027-01-05', end: '2027-01-05' },
  ], 'own away time keeps its label, loses its memo');
}

// ---- away time (#56): an admin sees every person's away time with its memo ----
{
  for (const request of [{ kind: 'state' } as const, { kind: 'tab', tab: 'admin' } as const, { kind: 'tab', tab: 'preferences' } as const]) {
    const r = project(awayFixture(), 'u-admin', request);
    assert.ok('state' in r);
    assert.deepStrictEqual(r.state.awayTime, awayFixture().awayTime, JSON.stringify(request));
  }
}

// ---- the user list carries each user's registration ----
{
  const r = project(fixture(), 'u-emp', { kind: 'users', registered: { 'u-admin': true } });
  assert.ok('users' in r);
  assert.deepStrictEqual(r.users.map((u) => [u.id, u.registered]), [['u-admin', true], ['u-emp', false]]);
}

console.log('projection tests passed');
