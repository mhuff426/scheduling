// Smoke test: node server/trades.test.js
import assert from 'assert';
import {
  createTrade, respondToOpenTrade, withdrawResponse, acceptOpenResponse,
  acceptDirect, rejectDirect, claimGiveaway, cancelTrade, extraShifts, canTakeShift,
  setExtraElection,
} from './trades.js';
import { vacationUsed, vacationAvailable } from './db.js';

// Dates in 2099 are always "future".
const day = { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const eve = { id: 'eve', name: 'Evening', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const night = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };

const mkUser = (id, name, extra = {}) => ({
  id, name, role: 'employee', vacationDays: 10, color: '#888', ...extra,
});
const A = (userId, date, shiftTypeId) => ({ userId, date, shiftTypeId });

function mkDb(users, assignments, timeOff = []) {
  const schedule = {
    id: 'sch1', startDate: '2099-01-01', endDate: '2099-01-31',
    minShifts: 0, maxShifts: null, userIds: null,
    assignments, unfilled: [], counts: {}, warnings: [],
    createdAt: '2099-01-01T00:00:00Z', preferenceStats: { asks: {}, median: 0 },
  };
  return {
    users,
    shiftTypes: [day, eve, night],
    settings: { maxVacationPerDay: 2, overnightWeight: 1.5 },
    timeOff,
    schedules: [schedule],
    trades: [],
    notifications: [],
    meta: { rotationCursor: 0 },
  };
}
const owner = (db, date, shiftTypeId) =>
  db.schedules[0].assignments.find((a) => a.date === date && a.shiftTypeId === shiftTypeId).userId;
const notesFor = (db, uid) => db.notifications.filter((n) => n.userId === uid).map((n) => n.message);

// ---- direct swap: happy path ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  });
  assert.ok(trade, 'direct trade created');
  assert.ok(notesFor(db, 'b').some((m) => m.includes('proposes swapping')), 'target notified');
  const r = acceptDirect(db, trade.id, { userId: 'b' });
  assert.ok(!r.error, `accept failed: ${r.error}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
  assert.strictEqual(trade.status, 'completed');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('accepted your swap')), 'proposer notified');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'swaps never cost vacation');
  assert.strictEqual(vacationUsed(db, 'b', 2099), 0);
}

// ---- direct swap: reject notifies the proposer ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  });
  rejectDirect(db, trade.id, { userId: 'b' });
  assert.strictEqual(trade.status, 'rejected');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('declined')), 'proposer told of rejection');
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'a', 'assignments untouched');
}

// ---- open swap: respond, accept one, runner-up notified ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day'), A('c', '2099-01-12', 'eve')]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  });
  assert.ok(notesFor(db, 'b').length && notesFor(db, 'c').length, 'everyone alerted');
  assert.ok(!respondToOpenTrade(db, trade.id, { userId: 'b', date: '2099-01-10', shiftTypeId: 'day' }).error);
  assert.ok(!respondToOpenTrade(db, trade.id, { userId: 'c', date: '2099-01-12', shiftTypeId: 'eve' }).error);
  assert.strictEqual(trade.responses.length, 2);
  assert.ok(notesFor(db, 'a').filter((m) => m.includes('offered their')).length === 2, 'owner sees responses');
  const r = acceptOpenResponse(db, trade.id, { userId: 'a', responseUserId: 'b' });
  assert.ok(!r.error, `accept failed: ${r.error}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
  assert.strictEqual(owner(db, '2099-01-12', 'eve'), 'c', 'runner-up keeps their shift');
  assert.ok(notesFor(db, 'c').some((m) => m.includes('went to someone else')), 'runner-up notified');
  assert.strictEqual(trade.status, 'completed');
}

// ---- open swap: withdraw a response ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  });
  respondToOpenTrade(db, trade.id, { userId: 'b', date: '2099-01-10', shiftTypeId: 'day' });
  withdrawResponse(db, trade.id, { userId: 'b' });
  assert.strictEqual(trade.responses.length, 0);
}

// ---- safety: swap blocked by 8h rest / double-day; schedule unchanged ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [
      A('a', '2099-01-07', 'day'),
      A('b', '2099-01-20', 'eve'),
      A('b', '2099-01-06', 'night'), // ends 6am on the 7th -> 2h before day shift
      A('c', '2099-01-15', 'eve'),
      A('c', '2099-01-07', 'eve'),   // same-day conflict for c
    ]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'open',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  });
  respondToOpenTrade(db, trade.id, { userId: 'b', date: '2099-01-20', shiftTypeId: 'eve' });
  const r1 = acceptOpenResponse(db, trade.id, { userId: 'a', responseUserId: 'b' });
  assert.ok(r1.error && r1.error.includes('8 hours'), `expected rest block, got: ${r1.error}`);
  assert.strictEqual(trade.status, 'open', 'trade survives a failed accept');
  assert.strictEqual(owner(db, '2099-01-07', 'day'), 'a', 'schedule unchanged');
  respondToOpenTrade(db, trade.id, { userId: 'c', date: '2099-01-15', shiftTypeId: 'eve' });
  const r2 = acceptOpenResponse(db, trade.id, { userId: 'a', responseUserId: 'c' });
  assert.ok(r2.error && r2.error.includes('already works'), `expected double-day block, got: ${r2.error}`);
}

// ---- giveaway above required: costs nothing, claim transfers + tracks extra ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [
      A('a', '2099-01-15', 'day'),
      A('a', '2099-01-16', 'day'),
      A('c', '2099-01-15', 'eve'), // c is busy on the 15th
    ]
  );
  db.schedules[0].minShifts = 1; // a holds 2 -> giving one keeps them at required
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(trade, 'giveaway created');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'no charge at posting');
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'a', 'shift stays with giver until claimed');

  const rc = claimGiveaway(db, trade.id, { userId: 'c' });
  assert.ok(rc.error && rc.error.includes('already works'), 'busy claimer blocked');
  const rb = claimGiveaway(db, trade.id, { userId: 'b' });
  assert.ok(!rb.error, `claim failed: ${rb.error}`);
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'b');
  assert.strictEqual(trade.status, 'completed');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'above-required giveaway never charges');
  assert.deepStrictEqual(extraShifts(db, 'sch1'), { b: 1 }, 'extra shift tracked');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('picked up your')), 'giver notified');
  const again = claimGiveaway(db, trade.id, { userId: 'c' });
  assert.strictEqual(again.code, 409, 'double-claim refused');
}

// ---- giveaway below required: charges exactly at claim time ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 5 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  db.schedules[0].minShifts = 1; // losing the only shift drops a below required
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(trade, 'affordable giveaway allowed');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'nothing charged before the claim');
  const r = claimGiveaway(db, trade.id, { userId: 'b' });
  assert.ok(!r.error, `claim failed: ${r.error}`);
  assert.strictEqual(db.schedules[0].vacationCharged.a, 1, 'day charged at claim');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 1);
}

// ---- broke giver: posting blocked when a day would be needed and none remain ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 0 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  db.schedules[0].minShifts = 1;
  const r = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(r.error && r.error.includes('must switch'), `expected must-switch gate, got: ${r.error}`);
}

// ---- claim-time affordability re-check: expired if the giver went broke ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  db.schedules[0].minShifts = 1;
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  // another schedule in the same year eats a's last day before anyone claims
  db.schedules.push({ id: 'sch2', startDate: '2099-02-01', endDate: '2099-02-07', minShifts: 0, assignments: [], unfilled: [], vacationCharged: { a: 1 } });
  const r = claimGiveaway(db, trade.id, { userId: 'b' });
  assert.strictEqual(r.code, 409, 'unaffordable claim rejected');
  assert.strictEqual(trade.status, 'expired');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('expired')), 'giver notified of expiry');
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'a', 'shift untouched');
}

// ---- extra-day election: validation, allowance credit, clamp on giveaway ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 0 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day'), A('a', '2099-01-16', 'day'), A('a', '2099-01-17', 'day')]
  );
  db.schedules[0].minShifts = 1; // a: count 3, required 1 -> extra 2
  const over = setExtraElection(db, 'sch1', { userId: 'a', vacation: 2, incentive: 1 });
  assert.ok(over.error && over.error.includes('Only 2 extra'), 'over-allocation rejected');
  const ok = setExtraElection(db, 'sch1', { userId: 'a', vacation: 1, incentive: 1 });
  assert.ok(!ok.error, `election failed: ${ok.error}`);
  assert.strictEqual(vacationAvailable(db, db.users[0], 2099), 1, 'elected vacation credits the allowance');

  // giving up a shift shrinks extra from 2 to 1 -> incentive trimmed first
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-17', shiftTypeId: 'day' },
  });
  const r = claimGiveaway(db, trade.id, { userId: 'b' });
  assert.ok(!r.error, `claim failed: ${r.error}`);
  assert.deepStrictEqual(db.schedules[0].extraElections.a, { vacation: 1, incentive: 0 }, 'incentive trimmed first');

  // spending the elected vacation elsewhere blocks both lowering it and the
  // giveaway that would trim it
  db.schedules.push({ id: 'sch2', startDate: '2099-03-01', endDate: '2099-03-07', minShifts: 0, assignments: [], unfilled: [], vacationCharged: { a: 1 } });
  const lower = setExtraElection(db, 'sch1', { userId: 'a', vacation: 0, incentive: 0 });
  assert.ok(lower.error && lower.error.includes('already used'), 'cannot un-elect spent vacation');
  const { trade: t2 } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-16', shiftTypeId: 'day' },
  });
  const r2 = claimGiveaway(db, t2.id, { userId: 'b' });
  assert.strictEqual(r2.code, 409, 'claim blocked when trimming elected vacation would go negative');
  assert.strictEqual(t2.status, 'expired');
}

// ---- max-shifts cap deliberately does NOT block a claim ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { maxShiftsOverride: 1 })],
    [A('a', '2099-01-15', 'day'), A('b', '2099-01-10', 'day')]
  );
  db.schedules[0].maxShifts = 1;
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  const r = claimGiveaway(db, trade.id, { userId: 'b' });
  assert.ok(!r.error, `cap must not block an extra pickup: ${r.error}`);
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'b');
}

// ---- staleness: admin reassignment before accept expires the trade ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  });
  // admin moves Ann's shift to Cy in the meantime
  db.schedules[0].assignments.find((x) => x.date === '2099-01-05').userId = 'c';
  const r = acceptDirect(db, trade.id, { userId: 'b' });
  assert.strictEqual(r.code, 409, 'stale accept rejected');
  assert.strictEqual(trade.status, 'expired');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('expired')), 'proposer told of expiry');
}

// ---- only future, owned shifts are tradable ----
{
  const db = mkDb([mkUser('a', 'Ann'), mkUser('b', 'Ben')], [A('a', '2020-01-05', 'day')]);
  const past = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'open',
    offered: { date: '2020-01-05', shiftTypeId: 'day' },
  });
  assert.ok(past.error && past.error.includes('future'), 'past shifts not tradable');
  const notMine = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'b', type: 'open',
    offered: { date: '2020-01-05', shiftTypeId: 'day' },
  });
  assert.ok(notMine.error && notMine.error.includes('currently yours'), 'ownership enforced');
}

console.log('All trade tests passed.');
