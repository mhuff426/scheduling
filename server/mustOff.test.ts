// Smoke test: tsx server/mustOff.test.ts
import assert from 'assert';
import { requestMustOff, withdrawMustOff } from './mustOff.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import type { Db, TimeOff, User } from '../shared/types.js';

const TODAY = '2050-01-01';
const mkUser = (id: string, roles = ['role-employee']): User =>
  ({ id, name: id, roles, vacationDays: 10, color: '#888' }) as User;
const off = (id: string, userId: string, date: string, type: TimeOff['type'] = 'vacation'): TimeOff =>
  ({ id, userId, date, type });

function mkDb(timeOff: TimeOff[] = []): Db {
  return {
    users: [mkUser('ann'), mkUser('bob'), mkUser('cat'), mkUser('boss', ['role-employee', 'role-admin'])],
    roles: [], shiftTypes: [], settings: { maxVacationPerDay: 2 } as Db['settings'],
    timeOff, schedules: [], trades: [], notifications: [], awayTime: [], holidays: [],
    meta: {} as Db['meta'],
  };
}
const as = (db: Db, uid: string): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today: TODAY });
function value<T>(o: Outcome<T>): T { if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.message}`); return o.value; }
const reasonOf = (o: Outcome<unknown>) => (o.ok ? 'ok' : o.refusal.reason);

// A must-off request on a full day is refused, saying only that the day is full (ADR 0002).
{
  const db = mkDb([off('t1', 'ann', '2050-02-01'), off('t2', 'bob', '2050-02-01')]);
  const o = requestMustOff(db, as(db, 'cat'), { date: '2050-02-01', type: 'vacation' });
  assert.equal(reasonOf(o), 'invalid');
  assert.ok(!o.ok);
  assert.equal(o.refusal.message, 'That day is full. Pick another day.');
  assert.ok(!/\d/.test(o.refusal.message), 'the refusal gives no headcount');
}

// A person who already has a request that day is refused as a conflict.
{
  const db = mkDb([off('t1', 'ann', '2050-02-01', 'preferred')]);
  const o = requestMustOff(db, as(db, 'ann'), { date: '2050-02-01', type: 'vacation' });
  assert.equal(reasonOf(o), 'conflict');
  assert.ok(!o.ok);
  assert.equal(o.refusal.message, 'You already have a request on that day. Remove it first.');
}

// A request is always for the actor, whatever userId the client sends.
{
  const db = mkDb();
  const entry = value(requestMustOff(db, as(db, 'ann'), { date: '2050-02-01', type: 'vacation', userId: 'bob' } as any));
  assert.equal(entry.userId, 'ann');
  assert.equal(entry.date, '2050-02-01');
  assert.deepEqual(db.timeOff, [entry]);
}

// Bad dates and unknown types are refused as invalid.
{
  const db = mkDb();
  assert.equal(reasonOf(requestMustOff(db, as(db, 'ann'), { date: '2050-2-1', type: 'vacation' })), 'invalid');
  assert.equal(reasonOf(requestMustOff(db, as(db, 'ann'), { date: '2050-02-01', type: 'sick' })), 'invalid');
  assert.equal(db.timeOff.length, 0);
}

// A person withdraws their own request.
{
  const db = mkDb([off('t1', 'ann', '2050-02-01'), off('t2', 'bob', '2050-02-01')]);
  value(withdrawMustOff(db, as(db, 'ann'), { id: 't1' }));
  assert.deepEqual(db.timeOff.map((t) => t.id), ['t2']);
}

// A coworker's request can't be withdrawn without managing others' time off.
{
  const db = mkDb([off('t1', 'ann', '2050-02-01')]);
  const o = withdrawMustOff(db, as(db, 'bob'), { id: 't1' });
  assert.equal(reasonOf(o), 'forbidden');
  assert.ok(!o.ok);
  assert.equal(o.refusal.message, 'You can only delete your own time-off requests.');
  assert.equal(db.timeOff.length, 1);
}

// An admin (manage others' time off) withdraws anyone's request.
{
  const db = mkDb([off('t1', 'ann', '2050-02-01')]);
  value(withdrawMustOff(db, as(db, 'boss'), { id: 't1' }));
  assert.equal(db.timeOff.length, 0);
}

// An unknown request is not found.
{
  const db = mkDb();
  const o = withdrawMustOff(db, as(db, 'ann'), { id: 'nope' });
  assert.equal(reasonOf(o), 'not_found');
  assert.ok(!o.ok);
  assert.equal(o.refusal.message, 'Request not found.');
}

// Through the route adapter: a full day is a 400 with no headcount, and leaves the data unchanged.
{
  let stored = mkDb([off('t1', 'ann', '2050-02-01'), off('t2', 'bob', '2050-02-01')]);
  const mutate: Mutate = async (fn) => { const draft = structuredClone(stored); const r = await fn(draft); stored = draft; return r; };
  const r = await runCommand(mutate, 'cat', TODAY, (db, ctx) => requestMustOff(db, ctx, { date: '2050-02-01', type: 'vacation' }));
  assert.deepEqual(r, { status: 400, body: { error: 'That day is full. Pick another day.' } });
  assert.equal(stored.timeOff.length, 2);
}

console.log('mustOff tests passed');