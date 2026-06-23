// Smoke test: tsx server/trades.test.ts
import assert from 'assert';
import {
  createTrade, respondToOpenTrade, withdrawResponse, acceptOpenResponse,
  acceptDirect, rejectDirect, claimGiveaway, cancelTrade, extraShifts, canTakeShift,
  setExtraElection, tradeOptions, swapPartners,
} from './trades.js';
import { vacationUsed, vacationAvailable } from './db.js';
import type { Assignment, Db, Schedule, ShiftType, TimeOff, User } from '../shared/types.js';

// Dates in 2099 are always "future".
const day: ShiftType = { id: 'day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const eve: ShiftType = { id: 'eve', name: 'Evening', startTime: '17:00', endTime: '21:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };
const night: ShiftType = { id: 'night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 };

const mkUser = (id: string, name: string, extra: Record<string, any> = {}): User => ({
  id, name, roles: ['role-employee'], vacationDays: 10, color: '#888', ...extra,
});
const A = (userId: string, date: string, shiftTypeId: string): Assignment => ({ userId, date, shiftTypeId });

function mkDb(users: User[], assignments: Assignment[], timeOff: TimeOff[] = []): Db {
  const schedule: Schedule = {
    id: 'sch1', startDate: '2099-01-01', endDate: '2099-01-31',
    userIds: null as any,
    assignments, unfilled: [], counts: {}, warnings: [],
    createdAt: '2099-01-01T00:00:00Z', preferenceStats: { asks: {}, median: 0 },
  };
  return {
    users,
    roles: [],
    shiftTypes: [day, eve, night],
    settings: { maxVacationPerDay: 2 },
    timeOff,
    schedules: [schedule],
    trades: [],
    notifications: [],
    awayTime: [],
    holidays: [],
    meta: { rotationCursor: 0 },
  };
}
const owner = (db: Db, date: string, shiftTypeId: string) =>
  db.schedules[0].assignments.find((a) => a.date === date && a.shiftTypeId === shiftTypeId)!.userId;
const notesFor = (db: Db, uid: string) => db.notifications.filter((n) => n.userId === uid).map((n) => n.message);

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
  const r = acceptDirect(db, trade!.id, { userId: 'b' });
  assert.ok(!r.error, `accept failed: ${r.error}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
  assert.strictEqual(trade!.status, 'completed');
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
  rejectDirect(db, trade!.id, { userId: 'b' });
  assert.strictEqual(trade!.status, 'rejected');
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
  assert.ok(!respondToOpenTrade(db, trade!.id, { userId: 'b', date: '2099-01-10', shiftTypeId: 'day' }).error);
  assert.ok(!respondToOpenTrade(db, trade!.id, { userId: 'c', date: '2099-01-12', shiftTypeId: 'eve' }).error);
  assert.strictEqual(trade!.responses.length, 2);
  assert.ok(notesFor(db, 'a').filter((m) => m.includes('offered their')).length === 2, 'owner sees responses');
  const r = acceptOpenResponse(db, trade!.id, { userId: 'a', responseUserId: 'b' });
  assert.ok(!r.error, `accept failed: ${r.error}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
  assert.strictEqual(owner(db, '2099-01-12', 'eve'), 'c', 'runner-up keeps their shift');
  assert.ok(notesFor(db, 'c').some((m) => m.includes('went to someone else')), 'runner-up notified');
  assert.strictEqual(trade!.status, 'completed');
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
  respondToOpenTrade(db, trade!.id, { userId: 'b', date: '2099-01-10', shiftTypeId: 'day' });
  withdrawResponse(db, trade!.id, { userId: 'b' });
  assert.strictEqual(trade!.responses.length, 0);
}

// ---- safety: ineligible responses are blocked fail-fast; schedule unchanged ----
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
  // Ben can't take the 7th (night ends 06:00 -> <8h rest) — respond rejected.
  const r1 = respondToOpenTrade(db, trade!.id, { userId: 'b', date: '2099-01-20', shiftTypeId: 'eve' });
  assert.ok(r1.error && r1.error.includes('rest'), `expected rest block, got: ${r1.error}`);
  // Cy already works the 7th — respond rejected.
  const r2 = respondToOpenTrade(db, trade!.id, { userId: 'c', date: '2099-01-15', shiftTypeId: 'eve' });
  assert.ok(r2.error && r2.error.includes('already works'), `expected double-day block, got: ${r2.error}`);
  assert.strictEqual(trade!.responses.length, 0, 'no ineligible responses recorded');
  assert.strictEqual(trade!.status, 'open', 'trade still open');
  assert.strictEqual(owner(db, '2099-01-07', 'day'), 'a', 'schedule unchanged');
}

// ---- giveaway above required: costs nothing, claim transfers + tracks extra ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { requiredShifts: 1 }), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [
      A('a', '2099-01-15', 'day'),
      A('a', '2099-01-16', 'day'),
      A('c', '2099-01-15', 'eve'), // c is busy on the 15th
    ]
  );
  // a holds 2 and is required 1 -> giving one keeps them at their required floor
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(trade, 'giveaway created');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'no charge at posting');
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'a', 'shift stays with giver until claimed');

  const rc = claimGiveaway(db, trade!.id, { userId: 'c' });
  assert.ok(rc.error && rc.error.includes('already works'), 'busy claimer blocked');
  const rb = claimGiveaway(db, trade!.id, { userId: 'b' });
  assert.ok(!rb.error, `claim failed: ${rb.error}`);
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'b');
  assert.strictEqual(trade!.status, 'completed');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'above-required giveaway never charges');
  assert.deepStrictEqual(extraShifts(db, 'sch1'), { b: 1 }, 'extra shift tracked');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('picked up your')), 'giver notified');
  const again = claimGiveaway(db, trade!.id, { userId: 'c' });
  assert.strictEqual(again.code, 409, 'double-claim refused');
}

// ---- giveaway below required: charges exactly at claim time ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 5, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  // a is required 1 -> losing the only shift drops a below their required floor
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(trade, 'affordable giveaway allowed');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 0, 'nothing charged before the claim');
  const r = claimGiveaway(db, trade!.id, { userId: 'b' });
  assert.ok(!r.error, `claim failed: ${r.error}`);
  assert.strictEqual(db.schedules[0].vacationCharged!.a, 1, 'day charged at claim');
  assert.strictEqual(vacationUsed(db, 'a', 2099), 1);
}

// ---- broke giver: posting blocked when a day would be needed and none remain ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 0, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  const r = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(r.error && r.error.includes('must switch'), `expected must-switch gate, got: ${r.error}`);
}

// ---- claim-time affordability re-check: expired if the giver went broke ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 1, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  // another schedule in the same year eats a's last day before anyone claims
  db.schedules.push({ id: 'sch2', startDate: '2099-02-01', endDate: '2099-02-07', assignments: [], unfilled: [], vacationCharged: { a: 1 } } as unknown as Schedule);
  const r = claimGiveaway(db, trade!.id, { userId: 'b' });
  assert.strictEqual(r.code, 409, 'unaffordable claim rejected');
  assert.strictEqual(trade!.status, 'expired');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('expired')), 'giver notified of expiry');
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'a', 'shift untouched');
}

// ---- extra-day election: validation, allowance credit, clamp on giveaway ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 0, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day'), A('a', '2099-01-16', 'day'), A('a', '2099-01-17', 'day')]
  );
  // a: count 3, required 1 -> extra 2
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
  const r = claimGiveaway(db, trade!.id, { userId: 'b' });
  assert.ok(!r.error, `claim failed: ${r.error}`);
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacation: 1, incentive: 0 }, 'incentive trimmed first');

  // spending the elected vacation elsewhere blocks both lowering it and the
  // giveaway that would trim it
  db.schedules.push({ id: 'sch2', startDate: '2099-03-01', endDate: '2099-03-07', assignments: [], unfilled: [], vacationCharged: { a: 1 } } as unknown as Schedule);
  const lower = setExtraElection(db, 'sch1', { userId: 'a', vacation: 0, incentive: 0 });
  assert.ok(lower.error && lower.error.includes('already used'), 'cannot un-elect spent vacation');
  const { trade: t2 } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-16', shiftTypeId: 'day' },
  });
  const r2 = claimGiveaway(db, t2!.id, { userId: 'b' });
  assert.strictEqual(r2.code, 409, 'claim blocked when trimming elected vacation would go negative');
  assert.strictEqual(t2!.status, 'expired');
}

// ---- max-shifts cap deliberately does NOT block a claim ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { maxShiftsOverride: 1 })],
    [A('a', '2099-01-15', 'day'), A('b', '2099-01-10', 'day')]
  );
  // b's per-user maxShiftsOverride is 1 (already at the cap with their own shift)
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  const r = claimGiveaway(db, trade!.id, { userId: 'b' });
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
  db.schedules[0].assignments.find((x) => x.date === '2099-01-05')!.userId = 'c';
  const r = acceptDirect(db, trade!.id, { userId: 'b' });
  assert.strictEqual(r.code, 409, 'stale accept rejected');
  assert.strictEqual(trade!.status, 'expired');
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

// ===== eligibility filtering =====

// ---- respondToOpenTrade rejects ineligible offers fail-fast ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [
      A('a', '2099-01-07', 'day'),     // Ann's open shift (08-16)
      A('b', '2099-01-06', 'night'),   // Ben works night ending 06:00 on the 7th
      A('b', '2099-01-20', 'eve'),     // Ben's only other (offerable) shift
      A('b', '2099-01-21', 'day'),     // Ben already works the 21st
      A('a', '2099-01-21', 'eve'),     // Ann works the 21st too (double-day if swapped)
    ]
  );
  const { trade } = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'open',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  });
  // Ben offering the 20th: Ann can take it, but Ben can't take the 7th day
  // shift (his night ends 06:00 that day -> <8h rest). Rejected fail-fast.
  const rest = respondToOpenTrade(db, trade!.id, { userId: 'b', date: '2099-01-20', shiftTypeId: 'eve' });
  assert.ok(rest.error && rest.error.includes('rest'), `expected rest block, got: ${rest.error}`);
  assert.strictEqual(trade!.responses.length, 0, 'no response recorded on rejection');
  // Ben offering the 21st: he already works the 7th? no — but Ann works the
  // 21st, so she can't take it back (double-day). Rejected.
  const dbl = respondToOpenTrade(db, trade!.id, { userId: 'b', date: '2099-01-21', shiftTypeId: 'day' });
  assert.ok(dbl.error && dbl.error.includes('already works'), `expected double-day block, got: ${dbl.error}`);
  assert.strictEqual(trade!.responses.length, 0, 'still no responses');
}

// ---- tradeOptions: a must-off coworker can't respond/claim; free one can ----
{
  // Ben has a must-have-off on the 7th, so he can't take Ann's 7th shift no
  // matter which of his shifts he offers (vacation isn't freed by a swap).
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [
      A('a', '2099-01-07', 'day'),   // Ann offers this (open + giveaway)
      A('b', '2099-01-15', 'day'),   // Ben has a shift to (try to) offer
      A('c', '2099-01-18', 'day'),   // Cy is free on the 7th, has an offerable shift
    ],
    [{ id: 'm1', userId: 'b', date: '2099-01-07', type: 'vacation' }]
  );
  const open = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'open',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  }).trade!;
  const give = createTrade(db, {
    scheduleId: 'sch1', fromUserId: 'a', type: 'giveaway',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  }).trade!;

  const optsBen = tradeOptions(db, 'sch1', 'b');
  assert.deepStrictEqual(optsBen.respond[open.id], [], 'Ben is off the 7th -> no offerable shift');
  assert.strictEqual(optsBen.claim[give.id].ok, false, 'Ben cannot claim the 7th');
  assert.ok(optsBen.claim[give.id].reason!.includes('vacation'), 'reason surfaced');

  const optsCy = tradeOptions(db, 'sch1', 'c');
  assert.strictEqual(optsCy.respond[open.id].length, 1, 'Cy can offer her 18th for the 7th');
  assert.strictEqual(optsCy.respond[open.id][0].date, '2099-01-18');
  assert.strictEqual(optsCy.claim[give.id].ok, true, 'Cy can claim the 7th');
}

// ---- swapPartners: only feasible partners + their valid shifts, never self ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [
      A('a', '2099-01-07', 'day'),   // Ann's offered shift
      A('b', '2099-01-15', 'day'),   // Ben is off the 7th -> can't take it -> excluded
      A('c', '2099-01-18', 'day'),   // Cy free on 7th, Ann free on 18th -> valid
      A('c', '2099-01-09', 'eve'),   // also valid
    ],
    [{ id: 'm1', userId: 'b', date: '2099-01-07', type: 'vacation' }]
  );
  const partners = swapPartners(db, 'sch1', 'a', { date: '2099-01-07', shiftTypeId: 'day' });
  assert.ok(!partners.some((p) => p.userId === 'a'), 'never includes the requester');
  assert.ok(!partners.some((p) => p.userId === 'b'), 'excludes Ben (off the 7th)');
  const cy = partners.find((p) => p.userId === 'c');
  assert.ok(cy, 'includes feasible partner Cy');
  assert.strictEqual(cy.shifts.length, 2, 'lists Cy\'s two valid shifts');
}

// ===== start date & away time gates on canTakeShift (new feature) =====

// ---- (8) a start date after the offered shift blocks the taker ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { startDate: '2099-01-20' })],
    [A('a', '2099-01-10', 'day')]
  );
  // Ben hasn't started by the 10th, so he can't pick up Ann's shift.
  const err = canTakeShift(db, db.schedules[0], { date: '2099-01-10', shiftTypeId: 'day' }, db.users[1]);
  assert.ok(err && err.includes("hasn't started"), `expected pre-start block, got: ${err}`);
}

// ---- (9) an away range covering the offered shift blocks the taker ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-10', 'day')]
  );
  db.awayTime.push({ id: 'aw1', userId: 'b', start: '2099-01-08', end: '2099-01-12' });
  const err = canTakeShift(db, db.schedules[0], { date: '2099-01-10', shiftTypeId: 'day' }, db.users[1]);
  assert.ok(err && err.includes('away'), `expected away-time block, got: ${err}`);
}

// ---- (10) no away range + a start date on/before the date => allowed ----
{
  // Ben started on the 10th (boundary: start date == shift date is OK) and has
  // no away range; he holds no other shift that day, so the new checks don't
  // over-block — canTakeShift returns null.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { startDate: '2099-01-10' })],
    [A('a', '2099-01-10', 'day')]
  );
  const ok = canTakeShift(db, db.schedules[0], { date: '2099-01-10', shiftTypeId: 'day' }, db.users[1]);
  assert.strictEqual(ok, null, `start-date-on-the-day with no away should be allowed, got: ${ok}`);
}

// ===== role eligibility gates canTakeShift (new feature) =====

// ---- a shift's allowed roles block employees who don't hold one ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { roles: ['role-employee', 'role-mgr'] }), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'mgr')]
  );
  db.shiftTypes.push({ id: 'mgr', name: 'Manager', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, allowedRoles: ['role-mgr'] });
  // Ben lacks role-mgr -> blocked from the manager shift.
  const err = canTakeShift(db, db.schedules[0], { date: '2099-01-06', shiftTypeId: 'mgr' }, db.users[1]);
  assert.ok(err && err.includes('role'), `expected a role block, got: ${err}`);
  // Ann holds role-mgr and the day is free -> allowed.
  const ok = canTakeShift(db, db.schedules[0], { date: '2099-01-07', shiftTypeId: 'mgr' }, db.users[0]);
  assert.strictEqual(ok, null, `manager should be allowed: ${ok}`);
  // An unrestricted shift type is open to Ben.
  const ok2 = canTakeShift(db, db.schedules[0], { date: '2099-01-08', shiftTypeId: 'day' }, db.users[1]);
  assert.strictEqual(ok2, null, `unrestricted shift should be allowed: ${ok2}`);
}

console.log('All trade tests passed.');
