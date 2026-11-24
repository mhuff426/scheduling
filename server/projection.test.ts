// Smoke test: tsx server/projection.test.ts
// What a viewer receives for each read (ADR 0002), against an in-memory Db.
import assert from 'assert';
import { project } from './projection.js';
import type { Db, Trade } from '../shared/types.js';

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

// ---- see everyone's records: viewers with different roles (capability lookup) ----
{
  const db = fixture();
  db.roles.push({ id: 'role-lead', name: 'Lead' });
  db.users.push(
    { id: 'u-only-admin', name: 'Oli Admin', firstName: 'Oli', lastName: 'Admin', email: 'oli@x.test', roles: ['role-admin'], vacationDays: 0, color: '#333333', requiredShifts: null },
    { id: 'u-lead', name: 'Lee Lead', firstName: 'Lee', lastName: 'Lead', email: 'lee@x.test', roles: ['role-employee', 'role-lead'], vacationDays: 0, color: '#444444', requiredShifts: null },
    { id: 'u-no-roles', name: 'Noa None', firstName: 'Noa', lastName: 'None', email: 'noa@x.test', roles: undefined as any, vacationDays: 0, color: '#555555', requiredShifts: null },
  );
  const dump = project(db, 'u-only-admin', { kind: 'state' });
  assert.ok('state' in dump, 'the admin role tag alone grants the full dump');
  assert.strictEqual((dump.state.awayTime[0] as any).memo, 'admin note');
  assert.deepStrictEqual(project(db, 'u-lead', { kind: 'state' }), { refused: 'forbidden' }, 'a custom role tag is not admin');
  assert.deepStrictEqual(project(db, 'u-lead', { kind: 'tab', tab: 'admin' }), { refused: 'forbidden' });
  assert.deepStrictEqual(project(db, 'u-no-roles', { kind: 'state' }), { refused: 'forbidden' }, 'no roles, no capabilities');
}

// ---- removing a person's admin role takes effect on their very next read ----
{
  const db = fixture();
  assert.ok('state' in project(db, 'u-admin', { kind: 'state' }));
  db.users.find((u) => u.id === 'u-admin')!.roles = ['role-employee'];
  assert.deepStrictEqual(project(db, 'u-admin', { kind: 'state' }), { refused: 'forbidden' });
  assert.deepStrictEqual(project(db, 'u-admin', { kind: 'tab', tab: 'admin' }), { refused: 'forbidden' });
}

// ---- trades: an employee sees the trades open to them (ADR 0002) ----
// Eve is the viewer; Bo and Cy are coworkers.
function tradeFixture(): Db {
  const db = fixture();
  db.users.push(
    { id: 'u-bo', name: 'Bo Coworker', firstName: 'Bo', lastName: 'Coworker', email: 'bo@x.test', roles: ['role-employee'], vacationDays: 10, color: '#333333', requiredShifts: null },
    { id: 'u-cy', name: 'Cy Coworker', firstName: 'Cy', lastName: 'Coworker', email: 'cy@x.test', roles: ['role-employee'], vacationDays: 10, color: '#444444', requiredShifts: null },
  );
  const slot = { date: '2026-12-20', shiftTypeId: 'st-day' };
  const trade = (id: string, type: Trade['type'], status: Trade['status'], fromUserId: string, more: Partial<Trade> = {}): Trade => ({
    id, scheduleId: 's1', type, status, fromUserId, offered: slot, toUserId: null, requested: null,
    responses: [], claimedBy: null, createdAt: '2026-11-01T00:00:00Z', resolvedAt: status === 'open' ? null : '2026-11-02T00:00:00Z', ...more,
  });
  const response = (userId: string) => ({ userId, date: '2026-12-21', shiftTypeId: 'st-day', at: '2026-11-01T01:00:00Z' });
  db.trades = [
    // Eve offered these, whatever became of them.
    trade('mine-open', 'open', 'open', 'u-emp'),
    trade('mine-direct-rejected', 'direct', 'rejected', 'u-emp', { toUserId: 'u-bo', requested: slot }),
    trade('mine-giveaway-cancelled', 'giveaway', 'cancelled', 'u-emp'),
    // Eve was offered this direct trade, later completed.
    trade('to-me-completed', 'direct', 'completed', 'u-bo', { toUserId: 'u-emp', requested: slot }),
    // Eve claimed this giveaway.
    trade('claimed-by-me', 'giveaway', 'completed', 'u-bo', { claimedBy: 'u-emp' }),
    // Eve offered a shift in reply to this open trade, which then expired.
    trade('responded-expired', 'open', 'expired', 'u-cy', { responses: [response('u-emp')] }),
    // Coworkers' open trades and giveaways that are still open.
    trade('cw-open', 'open', 'open', 'u-bo', { responses: [response('u-cy')] }),
    trade('cw-giveaway', 'giveaway', 'open', 'u-cy'),
    // Hidden: direct trades between two other people, open or not.
    trade('cw-direct-open', 'direct', 'open', 'u-bo', { toUserId: 'u-cy', requested: slot }),
    trade('cw-direct-completed', 'direct', 'completed', 'u-cy', { toUserId: 'u-bo', requested: slot }),
    // Hidden: coworkers' finished trades.
    trade('cw-open-completed', 'open', 'completed', 'u-bo', { responses: [response('u-cy')] }),
    trade('cw-giveaway-claimed', 'giveaway', 'completed', 'u-bo', { claimedBy: 'u-cy' }),
    trade('cw-giveaway-expired', 'giveaway', 'expired', 'u-cy'),
    trade('cw-open-cancelled', 'open', 'cancelled', 'u-cy'),
  ];
  return db;
}
const tradeIds = (r: ReturnType<typeof project>) => {
  assert.ok('state' in r);
  return r.state.trades.map((t) => t.id).sort();
};
const MY_TRADES = ['mine-open', 'mine-direct-rejected', 'mine-giveaway-cancelled', 'to-me-completed', 'claimed-by-me', 'responded-expired'];

// ---- an employee sees every trade they offered, were offered or claimed, whatever its status ----
{
  for (const tab of ['trades', 'schedule']) {
    const ids = tradeIds(project(tradeFixture(), 'u-emp', { kind: 'tab', tab }));
    for (const id of MY_TRADES) assert.ok(ids.includes(id), `${tab}: ${id} visible`);
  }
}

// ---- an employee sees coworkers' open trades and giveaways that are still open ----
{
  const ids = tradeIds(project(tradeFixture(), 'u-emp', { kind: 'tab', tab: 'trades' }));
  assert.ok(ids.includes('cw-open'), 'coworker open trade visible');
  assert.ok(ids.includes('cw-giveaway'), 'coworker giveaway visible');
}

// ---- an employee doesn't see direct trades between two other people, or coworkers' finished trades ----
{
  for (const tab of ['trades', 'schedule']) {
    const ids = tradeIds(project(tradeFixture(), 'u-emp', { kind: 'tab', tab }));
    assert.deepStrictEqual(ids, [...MY_TRADES, 'cw-open', 'cw-giveaway'].sort(), tab);
  }
}

// ---- an admin still sees every trade ----
{
  for (const tab of ['trades', 'schedule']) {
    assert.strictEqual(tradeIds(project(tradeFixture(), 'u-admin', { kind: 'tab', tab })).length, 14, tab);
  }
  assert.strictEqual(tradeIds(project(tradeFixture(), 'u-admin', { kind: 'state' })).length, 14, 'full dump');
}

console.log('projection tests passed');
