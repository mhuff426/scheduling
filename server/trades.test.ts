// Smoke test: tsx server/trades.test.ts
import assert from 'assert';
import {
  createTrade, respondToOpenTrade, withdrawResponse, acceptOpenResponse,
  acceptDirect, rejectDirect, claimGiveaway, cancelTrade, extraShifts,
  setExtraElection, tradeOptions, swapPartners, acceptTrade,
} from './trades.js';
import { runCommand, type CommandContext, type Mutate, type Outcome } from './outcome.js';
import { scheduleEligibility, TRADE_POLICY } from './eligibility.js';
import { yearBalance } from '../shared/settlement.js';
import type { Assignment, Db, Schedule, ShiftType, TimeOff, User } from '../shared/types.js';

// Commands run as of TODAY: dates in 2099 are future, 2020 is past.
const TODAY = '2050-01-01';
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
// Vacation charged to a user across 2099's schedules.
const vacationUsed = (db: Db, uid: string) => yearBalance(db, db.users.find((u) => u.id === uid)!, 2099).used;

// Who's acting: the named user, as of TODAY.
const as = (db: Db, uid: string, today = TODAY): CommandContext => ({ actor: db.users.find((u) => u.id === uid)!, today });
// A success's value (failing the test on a refusal), or a refusal's parts.
function value<T>(o: Outcome<T>): T {
  if (!o.ok) assert.fail(`unexpected refusal: ${o.refusal.reason}: ${o.refusal.message}`);
  return o.value;
}
const msg = (o: Outcome<unknown>) => (o.ok ? '' : o.refusal.message);
const reasonOf = (o: Outcome<unknown>) => (o.ok ? 'ok' : o.refusal.reason);
const warningsOf = (o: Outcome<unknown>) => (o.ok ? undefined : o.refusal.warnings);
const persists = (o: Outcome<unknown>) => !o.ok && o.refusal.persist === true;

// ---- direct swap: happy path ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  }));
  assert.ok(trade, 'direct trade created');
  assert.ok(notesFor(db, 'b').some((m) => m.includes('proposes swapping')), 'target notified');
  const r = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `accept failed: ${msg(r)}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
  assert.strictEqual(trade!.status, 'completed');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('accepted your swap')), 'proposer notified');
  assert.strictEqual(vacationUsed(db, 'a'), 0, 'swaps never cost vacation');
  assert.strictEqual(vacationUsed(db, 'b'), 0);
}

// ---- direct swap: reject notifies the proposer ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  }));
  rejectDirect(db, as(db, 'b'), { tradeId: trade!.id });
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
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  }));
  assert.ok(notesFor(db, 'b').length && notesFor(db, 'c').length, 'everyone alerted');
  assert.ok(respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-10', shiftTypeId: 'day' }).ok);
  assert.ok(respondToOpenTrade(db, as(db, 'c'), { tradeId: trade!.id, date: '2099-01-12', shiftTypeId: 'eve' }).ok);
  assert.strictEqual(trade!.responses.length, 2);
  assert.ok(notesFor(db, 'a').filter((m) => m.includes('offered their')).length === 2, 'owner sees responses');
  const r = acceptOpenResponse(db, as(db, 'a'), { tradeId: trade!.id, responseUserId: 'b' });
  assert.ok(r.ok, `accept failed: ${msg(r)}`);
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
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  }));
  respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-10', shiftTypeId: 'day' });
  withdrawResponse(db, as(db, 'b'), { tradeId: trade!.id });
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
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  }));
  // Ben can't take the 7th (night ends 06:00 -> <8h rest) — respond rejected.
  const r1 = respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-20', shiftTypeId: 'eve' });
  assert.ok(msg(r1).includes('rest'), `expected rest block, got: ${msg(r1)}`);
  // Cy already works the 7th — respond rejected.
  const r2 = respondToOpenTrade(db, as(db, 'c'), { tradeId: trade!.id, date: '2099-01-15', shiftTypeId: 'eve' });
  assert.ok(msg(r2).includes('already works'), `expected double-day block, got: ${msg(r2)}`);
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
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  }));
  assert.ok(trade, 'giveaway created');
  assert.strictEqual(vacationUsed(db, 'a'), 0, 'no charge at posting');
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'a', 'shift stays with giver until claimed');

  const rc = claimGiveaway(db, as(db, 'c'), { tradeId: trade!.id });
  assert.ok(msg(rc).includes('already works'), 'busy claimer blocked');
  const rb = claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(rb.ok, `claim failed: ${msg(rb)}`);
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'b');
  assert.strictEqual(trade!.status, 'completed');
  assert.strictEqual(vacationUsed(db, 'a'), 0, 'above-required giveaway never charges');
  assert.deepStrictEqual(extraShifts(db, 'sch1'), { b: 1 }, 'extra shift tracked');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('picked up your')), 'giver notified');
  const again = claimGiveaway(db, as(db, 'c'), { tradeId: trade!.id });
  assert.strictEqual(reasonOf(again), 'conflict', 'double-claim refused');
}

// ---- giveaway below required: charges exactly at claim time ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 5, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  // a is required 1 -> losing the only shift drops a below their required floor
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  }));
  assert.ok(trade, 'affordable giveaway allowed');
  assert.strictEqual(vacationUsed(db, 'a'), 0, 'nothing charged before the claim');
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `claim failed: ${msg(r)}`);
  assert.deepStrictEqual(db.schedules[0].vacationCharges, [{ userId: 'a', date: '2099-01-15', cause: 'giveaway' }], 'day charged at claim, dated on the shift given away');
  assert.strictEqual(vacationUsed(db, 'a'), 1);
}

// ---- broke giver: posting blocked when a day would be needed and none remain ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 0, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  const r = createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  });
  assert.ok(msg(r).includes('must switch'), `expected must-switch gate, got: ${msg(r)}`);
}

// ---- claim-time affordability re-check: expired if the giver went broke ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { vacationDays: 1, requiredShifts: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-15', 'day')]
  );
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  }));
  // another schedule in the same year eats a's last day before anyone claims
  db.schedules.push({ id: 'sch2', startDate: '2099-02-01', endDate: '2099-02-07', assignments: [], unfilled: [], vacationCharges: [{ userId: 'a', date: '2099-02-01', cause: 'shortfall' }] } as unknown as Schedule);
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id });
  assert.strictEqual(reasonOf(r), 'conflict', 'unaffordable claim rejected');
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
  const over = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 2 }, incentive: 1 });
  assert.ok(msg(over).includes('Only 2 extra'), 'over-allocation rejected');
  const ok = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 1 }, incentive: 1 });
  assert.ok(ok.ok, `election failed: ${msg(ok)}`);

  // giving up a shift shrinks extra from 2 to 1 -> incentive trimmed first
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-17', shiftTypeId: 'day' },
  }));
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `claim failed: ${msg(r)}`);
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2099: 1 }, incentive: 0 }, 'incentive trimmed first');

  // spending the elected vacation elsewhere blocks both lowering it and the
  // giveaway that would trim it
  db.schedules.push({ id: 'sch2', startDate: '2099-03-01', endDate: '2099-03-07', assignments: [], unfilled: [], vacationCharges: [{ userId: 'a', date: '2099-02-01', cause: 'shortfall' }] } as unknown as Schedule);
  const lower = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: {}, incentive: 0 });
  assert.ok(msg(lower).includes('already used'), 'cannot un-elect spent vacation');
  const t2 = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-16', shiftTypeId: 'day' },
  }));
  const r2 = claimGiveaway(db, as(db, 'b'), { tradeId: t2!.id });
  assert.strictEqual(reasonOf(r2), 'conflict', 'claim blocked when trimming elected vacation would go negative');
  assert.strictEqual(t2!.status, 'expired');
}

// ===== a schedule spanning New Year (28 Dec 2099 - 10 Jan 2100) =====
const spanning = (users: User[], assignments: Assignment[]) => {
  const db = mkDb(users, assignments);
  Object.assign(db.schedules[0], { startDate: '2099-12-28', endDate: '2100-01-10' });
  return db;
};
const balanceOf = (db: Db, uid: string, year: number) => yearBalance(db, db.users.find((u) => u.id === uid)!, year).balance;
const otherSchedule = (id: string, chargeDates: string[]) => ({
  id, startDate: chargeDates[0], endDate: chargeDates[0], assignments: [], unfilled: [],
  vacationCharges: chargeDates.map((date) => ({ userId: 'a', date, cause: 'shortfall' })),
} as unknown as Schedule);

// ---- giveaway charge is dated on the day of the shift given away ----
{
  const db = spanning(
    [mkUser('a', 'Ann', { vacationDays: 5, requiredShifts: 2 }), mkUser('b', 'Ben')],
    [A('a', '2099-12-29', 'day'), A('a', '2100-01-05', 'day')]
  );
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway', offered: { date: '2100-01-05', shiftTypeId: 'day' },
  }));
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `claim failed: ${msg(r)}`);
  assert.deepStrictEqual(db.schedules[0].vacationCharges, [{ userId: 'a', date: '2100-01-05', cause: 'giveaway' }]);
  assert.deepStrictEqual([balanceOf(db, 'a', 2099), balanceOf(db, 'a', 2100)], [5, 4], 'charged to 2100, not the start year');
}

// ---- posting is refused when the given-away day's year has nothing left ----
{
  const db = spanning(
    [mkUser('a', 'Ann', { vacationDays: 1, requiredShifts: 2 }), mkUser('b', 'Ben')],
    [A('a', '2099-12-29', 'day'), A('a', '2100-01-05', 'day')]
  );
  db.schedules.push(otherSchedule('sch2', ['2100-02-01']));
  const jan = createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2100-01-05', shiftTypeId: 'day' } });
  assert.ok(msg(jan).includes('none left for 2100'), `2100 is spent: ${msg(jan)}`);
  const dec = createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-12-29', shiftTypeId: 'day' } });
  assert.ok(dec.ok, '2099 still has a day');
}

// ---- split elections: the employee picks the year(s) for elected vacation ----
{
  const db = spanning(
    [mkUser('a', 'Ann', { vacationDays: 0, requiredShifts: 0 }), mkUser('b', 'Ben')],
    [A('a', '2099-12-29', 'day'), A('a', '2099-12-30', 'day'), A('a', '2100-01-05', 'day')]
  );
  // 3 extra days
  const split = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 1, 2100: 2 }, incentive: 0 });
  assert.ok(split.ok, `split failed: ${msg(split)}`);
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2099: 1, 2100: 2 }, incentive: 0 });
  assert.deepStrictEqual([balanceOf(db, 'a', 2099), balanceOf(db, 'a', 2100)], [1, 2], 'each year credited its own days');

  const outside = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2101: 1 }, incentive: 0 });
  assert.ok(msg(outside).includes('2101'), `a year the schedule doesn't cover is refused: ${msg(outside)}`);
  const tooMany = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 2, 2100: 2 }, incentive: 0 });
  assert.ok(msg(tooMany).includes('Only 3 extra'), 'the total across years is capped by extra days');
  // spellings of the same year collapse to one canonical key
  const aliased = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { '2099': 1, '02099': 1, ' 2100': 1 }, incentive: 0 });
  assert.ok(aliased.ok, `aliased years accepted: ${msg(aliased)}`);
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2099: 2, 2100: 1 }, incentive: 0 }, 'one key per year');
  const fractional = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { '2099.5': 1 }, incentive: 0 });
  assert.strictEqual(reasonOf(fractional), 'invalid', 'a non-integer year is refused');
  assert.ok(setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 1, 2100: 2 }, incentive: 0 }).ok);

  // spending 2100's elected days blocks lowering 2100, but not moving 2099's
  db.schedules.push(otherSchedule('sch2', ['2100-02-01', '2100-02-02']));
  const lower2100 = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 2, 2100: 1 }, incentive: 0 });
  assert.ok(msg(lower2100).includes('already used'), 'lowering 2100 would push it below zero');
  const lower2099 = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2100: 2 }, incentive: 1 });
  assert.ok(lower2099.ok, `2099's day is unspent, so it can move to incentive: ${msg(lower2099)}`);
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2100: 2 }, incentive: 1 });

  // the pre-#37 single `vacation` field is refused, not silently ignored
  const legacy = setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacation: 1, incentive: 0 } as any);
  assert.strictEqual(reasonOf(legacy), 'invalid', 'legacy vacation field -> 400');
  assert.ok(msg(legacy).includes('vacationByYear'), `error names the new field: ${msg(legacy)}`);
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2100: 2 }, incentive: 1 }, 'election unchanged');
}

// ---- election cut after a giveaway: incentive, then the earlier year as far as it can absorb, then the later ----
{
  const db = spanning(
    [mkUser('a', 'Ann', { vacationDays: 0, requiredShifts: 0 }), mkUser('b', 'Ben')],
    [A('a', '2099-12-29', 'day'), A('a', '2099-12-30', 'day'), A('a', '2100-01-05', 'day'), A('a', '2100-01-06', 'day')]
  );
  // 4 extra: 2099: 2, 2100: 1, incentive 1
  assert.ok(setExtraElection(db, as(db, 'a'), { scheduleId: 'sch1', vacationByYear: { 2099: 2, 2100: 1 }, incentive: 1 }).ok);
  // spend one of 2099's elected days elsewhere: 2099 can absorb only 1 cut
  db.schedules.push(otherSchedule('sch2', ['2099-03-01']));
  const give = (date: string) => {
    const trade = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date, shiftTypeId: 'day' } }));
    return { trade, r: claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id }) };
  };
  assert.ok(give('2099-12-29').r.ok); // 3 extra left -> cut the incentive day
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2099: 2, 2100: 1 }, incentive: 0 });
  assert.ok(give('2099-12-30').r.ok); // 2 extra left -> cut 1 from 2099 (all it can absorb)
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2099: 1, 2100: 1 }, incentive: 0 });
  assert.deepStrictEqual([balanceOf(db, 'a', 2099), balanceOf(db, 'a', 2100)], [0, 1]);
  assert.ok(give('2100-01-05').r.ok); // 1 extra left -> 2099 is at 0, so the cut comes from 2100
  assert.deepStrictEqual(db.schedules[0].extraElections!.a, { vacationByYear: { 2099: 1 }, incentive: 0 });
  assert.deepStrictEqual([balanceOf(db, 'a', 2099), balanceOf(db, 'a', 2100)], [0, 0]);
  // nothing left to absorb the last cut: blocked and expired
  const last = give('2100-01-06');
  assert.strictEqual(reasonOf(last.r), 'conflict', 'neither year can absorb the cut');
  assert.strictEqual(last.trade.status, 'expired');
}

// ---- max-shifts cap deliberately does NOT block a claim ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { maxShiftsOverride: 1 })],
    [A('a', '2099-01-15', 'day'), A('b', '2099-01-10', 'day')]
  );
  // b's per-user maxShiftsOverride is 1 (already at the cap with their own shift)
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-15', shiftTypeId: 'day' },
  }));
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `cap must not block an extra pickup: ${msg(r)}`);
  assert.strictEqual(owner(db, '2099-01-15', 'day'), 'b');
}

// ---- staleness: admin reassignment before accept expires the trade ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  }));
  // admin moves Ann's shift to Cy in the meantime
  db.schedules[0].assignments.find((x) => x.date === '2099-01-05')!.userId = 'c';
  const r = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id });
  assert.strictEqual(reasonOf(r), 'conflict', 'stale accept rejected');
  assert.strictEqual(trade!.status, 'expired');
  assert.ok(notesFor(db, 'a').some((m) => m.includes('expired')), 'proposer told of expiry');
}

// ---- only future, owned shifts are tradable ----
{
  const db = mkDb([mkUser('a', 'Ann'), mkUser('b', 'Ben')], [A('a', '2020-01-05', 'day')]);
  const past = createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2020-01-05', shiftTypeId: 'day' },
  });
  assert.ok(msg(past).includes('future'), 'past shifts not tradable');
  const notMine = createTrade(db, as(db, 'b'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2020-01-05', shiftTypeId: 'day' },
  });
  assert.ok(msg(notMine).includes('currently yours'), 'ownership enforced');
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
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  }));
  // Ben offering the 20th: Ann can take it, but Ben can't take the 7th day
  // shift (his night ends 06:00 that day -> <8h rest). Rejected fail-fast.
  const rest = respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-20', shiftTypeId: 'eve' });
  assert.ok(msg(rest).includes('rest'), `expected rest block, got: ${msg(rest)}`);
  assert.strictEqual(trade!.responses.length, 0, 'no response recorded on rejection');
  // Ben offering the 21st: he already works the 7th? no — but Ann works the
  // 21st, so she can't take it back (double-day). Rejected.
  const dbl = respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-21', shiftTypeId: 'day' });
  assert.ok(msg(dbl).includes('already works'), `expected double-day block, got: ${msg(dbl)}`);
  assert.strictEqual(trade!.responses.length, 0, 'still no responses');
}

// ---- tradeOptions: a must-off coworker may respond and claim, each option
// marked with his must-off warning; a free one can do both unmarked ----
{
  // Ben has a must-have-off on the 7th; swapping into or claiming Ann's 7th
  // shift would have him work it, so his options carry the warning.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [
      A('a', '2099-01-07', 'day'),   // Ann offers this (open + giveaway)
      A('b', '2099-01-15', 'day'),   // Ben has a shift to offer
      A('c', '2099-01-18', 'day'),   // Cy is free on the 7th, has an offerable shift
    ],
    [{ id: 'm1', userId: 'b', date: '2099-01-07', type: 'vacation' }]
  );
  const open = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  }));
  const give = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'giveaway',
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
  }));

  const benWarning = { kind: 'must-off day', message: "2099-01-07 is one of Ben's must-off days." };

  const optsBen = tradeOptions(db, 'sch1', 'b', TODAY);
  assert.deepStrictEqual(
    optsBen.respond[open.id],
    [{ date: '2099-01-15', shiftTypeId: 'day', warnings: [benWarning] }],
    'Ben may offer his 15th for the 7th, marked with his must-off warning'
  );
  assert.deepStrictEqual(
    optsBen.claim[give.id],
    { ok: true, reason: null, warnings: [benWarning] },
    'Ben may claim the 7th, marked with his must-off warning'
  );

  const optsCy = tradeOptions(db, 'sch1', 'c', TODAY);
  assert.deepStrictEqual(
    optsCy.respond[open.id], [{ date: '2099-01-18', shiftTypeId: 'day', warnings: [] }], 'Cy can offer her 18th, no warning'
  );
  assert.deepStrictEqual(optsCy.claim[give.id], { ok: true, reason: null, warnings: [] }, 'Cy can claim the 7th, no warning');
}

// ---- tradeOptions: a giveaway with a blocking reason stays not-ok ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-07', 'day'), A('b', '2099-01-07', 'eve')]
  );
  const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-07', shiftTypeId: 'day' } }));
  assert.deepStrictEqual(
    tradeOptions(db, 'sch1', 'b', TODAY).claim[give.id],
    { ok: false, reason: 'Ben already works a shift that day.', warnings: [] }
  );
}

// ===== claiming a giveaway on your own must-off day (confirmation contract) =====

// ---- refused with the warning until confirmed, then succeeds ----
for (const vacationDays of [10, 0]) {
  // 10: the must-off day is affordable; 0: it's unaffordable. Both warn.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { vacationDays })],
    [A('a', '2099-01-07', 'day')],
    [{ id: 'm1', userId: 'b', date: '2099-01-07', type: 'vacation' }]
  );
  const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-07', shiftTypeId: 'day' } }));
  const warning = { kind: 'must-off day', message: "2099-01-07 is one of Ben's must-off days." };

  const first = claimGiveaway(db, as(db, 'b'), { tradeId: give.id });
  assert.strictEqual(reasonOf(first), 'unconfirmed', `vacationDays ${vacationDays}: unconfirmed claim refused`);
  assert.deepStrictEqual(warningsOf(first), [warning], 'refusal carries the warning');
  assert.strictEqual(msg(first), warning.message);
  assert.strictEqual(owner(db, '2099-01-07', 'day'), 'a', 'shift not transferred');
  assert.strictEqual(give.status, 'open', 'giveaway stays open');

  const wrong = claimGiveaway(db, as(db, 'b'), { tradeId: give.id, confirmedWarnings: ['must-off day'] });
  assert.strictEqual(reasonOf(wrong), 'unconfirmed', 'confirming the kind alone does not count');
  // A must-off warning confirmed for another day is a different warning.
  const otherDay = claimGiveaway(db, as(db, 'b'), { tradeId: give.id, confirmedWarnings: ["2099-01-08 is one of Ben's must-off days."] });
  assert.deepStrictEqual([reasonOf(otherDay), warningsOf(otherDay)], ['unconfirmed', [warning]], 'a new warning of a confirmed kind refuses again');

  const ok = claimGiveaway(db, as(db, 'b'), { tradeId: give.id, confirmedWarnings: [warning.message] });
  assert.ok(ok.ok, `confirmed claim failed: ${msg(ok)}`);
  assert.strictEqual(owner(db, '2099-01-07', 'day'), 'b', 'Ben now works his must-off day');
  assert.strictEqual(give.status, 'completed');
}

// ---- a claim with no warning needs no confirmation ----
{
  const db = mkDb([mkUser('a', 'Ann'), mkUser('b', 'Ben')], [A('a', '2099-01-07', 'day')]);
  const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-07', shiftTypeId: 'day' } }));
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: give.id });
  assert.ok(r.ok, `plain claim failed: ${msg(r)}`);
}

// ---- past the consecutive-night limit: claimed with no warning ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { maxConsecutiveNights: 2 })],
    [A('a', '2099-01-07', 'night'), A('b', '2099-01-05', 'night'), A('b', '2099-01-06', 'night')]
  );
  const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-07', shiftTypeId: 'night' } }));
  assert.deepStrictEqual(tradeOptions(db, 'sch1', 'b', TODAY).claim[give.id], { ok: true, reason: null, warnings: [] });
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: give.id });
  assert.ok(r.ok, `night limit must not block or warn a claim: ${msg(r)}`);
  assert.strictEqual(owner(db, '2099-01-07', 'night'), 'b');
}

// ---- a hard rule still refuses a confirmed claim on a must-off day ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-07', 'day')],
    [{ id: 'm1', userId: 'b', date: '2099-01-07', type: 'vacation' }]
  );
  db.awayTime.push({ id: 'aw1', userId: 'b', start: '2099-01-07', end: '2099-01-07' });
  const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-07', shiftTypeId: 'day' } }));
  const r = claimGiveaway(db, as(db, 'b'), { tradeId: give.id, confirmedWarnings: ["2099-01-07 is one of Ben's must-off days."] });
  assert.deepStrictEqual([reasonOf(r), msg(r), warningsOf(r)], ['invalid', 'Ben is on away time that day.', undefined]);
  assert.strictEqual(owner(db, '2099-01-07', 'day'), 'a');
}

// ---- swapPartners: feasible partners + their swappable shifts, never self;
// a partner who'd land on their own must-off day is still listed, and each
// shift is marked with the viewer's (offerer's) own warnings only ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy'), mkUser('d', 'Dee')],
    [
      A('a', '2099-01-07', 'day'),   // Ann's offered shift
      A('b', '2099-01-15', 'day'),   // Ben is off the 7th -> listed; his warning isn't Ann's to see
      A('c', '2099-01-18', 'day'),   // Ann is off the 18th -> listed, marked with Ann's warning
      A('c', '2099-01-09', 'eve'),   // plain swap
      A('d', '2099-01-20', 'eve'),   // Dee is away the 7th -> blocked -> excluded
    ],
    [
      { id: 'm1', userId: 'b', date: '2099-01-07', type: 'vacation' },
      { id: 'm2', userId: 'a', date: '2099-01-18', type: 'vacation' },
    ]
  );
  db.awayTime.push({ id: 'aw1', userId: 'd', start: '2099-01-07', end: '2099-01-07' });
  const partners = swapPartners(db, 'sch1', 'a', { date: '2099-01-07', shiftTypeId: 'day' }, TODAY);
  assert.ok(!partners.some((p) => p.userId === 'a'), 'never includes the requester');
  assert.ok(!partners.some((p) => p.userId === 'd'), 'excludes Dee (blocked: away the 7th)');
  assert.deepStrictEqual(
    partners.find((p) => p.userId === 'b')?.shifts,
    [{ date: '2099-01-15', shiftTypeId: 'day', warnings: [] }],
    "Ben is listed; his own must-off day isn't shown to Ann"
  );
  const cy = partners.find((p) => p.userId === 'c');
  assert.ok(cy, 'includes feasible partner Cy');
  assert.deepStrictEqual(
    [...cy.shifts].sort((x, y) => x.date.localeCompare(y.date)),
    [
      { date: '2099-01-09', shiftTypeId: 'eve', warnings: [] },
      { date: '2099-01-18', shiftTypeId: 'day', warnings: [{ kind: 'must-off day', message: "2099-01-18 is one of Ann's must-off days." }] },
    ],
    "Cy's 18th is marked with Ann's must-off warning"
  );
}

// ===== swaps on your own must-off day: each person warned at their own step =====

const mustOff = (id: string, userId: string, date: string): TimeOff => ({ id, userId, date, type: 'vacation' });
const offMsg = (date: string, name: string) => ({ kind: 'must-off day', message: `${date} is one of ${name}'s must-off days.` });
// Ann offers her 5th day shift for Ben's 10th day shift.
const direct = (db: Db, confirmedWarnings?: string[]) => createTrade(db, as(db, 'a'), {
  scheduleId: 'sch1', type: 'direct',
  offered: { date: '2099-01-05', shiftTypeId: 'day' },
  toUserId: 'b', requested: { date: '2099-01-10', shiftTypeId: 'day' },
  ...(confirmedWarnings ? { confirmedWarnings } : {}),
});
const swapDb = (timeOff: TimeOff[]) => mkDb(
  [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
  [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')],
  timeOff
);

// ---- direct swap: only the target lands on a must-off day -> warned at accept ----
{
  // Ben would take Ann's 5th, one of his must-off days.
  const db = swapDb([mustOff('m1', 'b', '2099-01-05')]);
  const trade = value(direct(db));
  assert.ok(trade, "Ann offers with no warning");
  const first = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id });
  assert.deepStrictEqual([reasonOf(first), warningsOf(first)], ['unconfirmed', [offMsg('2099-01-05', 'Ben')]], 'Ben warned at accept');
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'a', 'nothing swapped yet');
  assert.strictEqual(trade!.status, 'open');
  const ok = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id, confirmedWarnings: [offMsg('2099-01-05', 'Ben').message] });
  assert.ok(ok.ok, `confirmed accept failed: ${msg(ok)}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
}

// ---- direct swap: only the offerer lands on a must-off day -> warned at offer ----
{
  // Ann would take Ben's 10th, one of her must-off days.
  const db = swapDb([mustOff('m1', 'a', '2099-01-10')]);
  const first = direct(db);
  assert.deepStrictEqual([reasonOf(first), warningsOf(first)], ['unconfirmed', [offMsg('2099-01-10', 'Ann')]], 'Ann warned before offering');
  assert.strictEqual(db.trades.length, 0, 'no trade posted until confirmed');
  assert.deepStrictEqual(notesFor(db, 'b'), [], 'Ben not notified of an unsent offer');
  const trade = value(direct(db, [offMsg('2099-01-10', 'Ann').message]));
  assert.ok(trade, "confirmed offer failed");
  const r = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `Ben is not warned about Ann's must-off day: ${msg(r)}`);
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a', 'Ann now works her must-off day');
}

// ---- direct swap: both land on must-off days -> each warned at their own step ----
{
  const db = swapDb([mustOff('m1', 'a', '2099-01-10'), mustOff('m2', 'b', '2099-01-05')]);
  const offer = direct(db);
  assert.deepStrictEqual(warningsOf(offer), [offMsg('2099-01-10', 'Ann')], 'Ann sees only her own warning');
  const trade = value(direct(db, [offMsg('2099-01-10', 'Ann').message]));
  const accept = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id });
  assert.deepStrictEqual(warningsOf(accept), [offMsg('2099-01-05', 'Ben')], 'Ben sees only his own warning');
  // Ann's confirmation doesn't carry over to Ben's step.
  assert.strictEqual(reasonOf(acceptDirect(db, as(db, 'b'), { tradeId: trade!.id, confirmedWarnings: [offMsg('2099-01-10', 'Ann').message] })), 'unconfirmed');
  assert.ok(acceptDirect(db, as(db, 'b'), { tradeId: trade!.id, confirmedWarnings: [offMsg('2099-01-05', 'Ben').message] }).ok);
  assert.strictEqual(trade!.status, 'completed');
}

// ---- direct swap: neither lands on a must-off day -> nobody warned ----
{
  // Must-off days on the shifts they give up don't count.
  const db = swapDb([mustOff('m1', 'a', '2099-01-05'), mustOff('m2', 'b', '2099-01-10')]);
  const trade = value(direct(db));
  assert.ok(trade, "offer needs no confirmation");
  const r = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id });
  assert.ok(r.ok, `accept needs no confirmation: ${msg(r)}`);
}

// ---- open swap: responder warned at response, poster at accept ----
{
  // Ann posts her 5th. Ben (must-off the 5th) responds with his 10th, which
  // is one of Ann's must-off days. Cy responds with a plain shift.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day'), A('c', '2099-01-12', 'day')],
    [mustOff('m1', 'b', '2099-01-05'), mustOff('m2', 'a', '2099-01-10')]
  );
  const trade = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'open', offered: { date: '2099-01-05', shiftTypeId: 'day' } }));

  const ben = respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-10', shiftTypeId: 'day' });
  assert.deepStrictEqual([reasonOf(ben), warningsOf(ben)], ['unconfirmed', [offMsg('2099-01-05', 'Ben')]], "Ben warned about his own day, not Ann's");
  assert.strictEqual(trade!.responses.length, 0, 'no response recorded until confirmed');
  assert.ok(respondToOpenTrade(db, as(db, 'b'), { tradeId: trade!.id, date: '2099-01-10', shiftTypeId: 'day', confirmedWarnings: [offMsg('2099-01-05', 'Ben').message] }).ok);
  assert.ok(respondToOpenTrade(db, as(db, 'c'), { tradeId: trade!.id, date: '2099-01-12', shiftTypeId: 'day' }).ok, 'Cy responds with no warning');

  const accept = acceptOpenResponse(db, as(db, 'a'), { tradeId: trade!.id, responseUserId: 'b' });
  assert.deepStrictEqual([reasonOf(accept), warningsOf(accept)], ['unconfirmed', [offMsg('2099-01-10', 'Ann')]], 'Ann warned when accepting');
  assert.strictEqual(trade!.status, 'open');
  const ok = acceptOpenResponse(db, as(db, 'a'), { tradeId: trade!.id, responseUserId: 'b', confirmedWarnings: [offMsg('2099-01-10', 'Ann').message] });
  assert.ok(ok.ok, `confirmed accept failed: ${msg(ok)}`);
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'b');
  assert.strictEqual(owner(db, '2099-01-10', 'day'), 'a');
}

// ---- open swap: accepting a plain response needs no confirmation ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('c', 'Cy')],
    [A('a', '2099-01-05', 'day'), A('c', '2099-01-12', 'day')],
    [mustOff('m1', 'a', '2099-01-05')]   // Ann's must-off on the shift she gives up
  );
  const trade = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'open', offered: { date: '2099-01-05', shiftTypeId: 'day' } }));
  assert.ok(respondToOpenTrade(db, as(db, 'c'), { tradeId: trade!.id, date: '2099-01-12', shiftTypeId: 'day' }).ok);
  const r = acceptOpenResponse(db, as(db, 'a'), { tradeId: trade!.id, responseUserId: 'c' });
  assert.ok(r.ok, `plain accept failed: ${msg(r)}`);
}

// ---- same-day swap on a must-off day the person already works ----
{
  // Ann works the day shift on her must-off 7th and swaps it for Ben's
  // evening that day: only the must-off warning, no "already works" block.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-07', 'day'), A('b', '2099-01-07', 'eve')],
    [mustOff('m1', 'a', '2099-01-07')]
  );
  const body = {
    scheduleId: 'sch1', type: 'direct' as const,
    offered: { date: '2099-01-07', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-07', shiftTypeId: 'eve' },
  };
  const first = createTrade(db, as(db, 'a'), body);
  assert.deepStrictEqual([reasonOf(first), warningsOf(first)], ['unconfirmed', [offMsg('2099-01-07', 'Ann')]]);
  const trade = value(createTrade(db, as(db, 'a'), { ...body, confirmedWarnings: [offMsg('2099-01-07', 'Ann').message] }));
  assert.ok(trade, "confirmed same-day offer failed");
  assert.ok(acceptDirect(db, as(db, 'b'), { tradeId: trade!.id }).ok);
  assert.strictEqual(owner(db, '2099-01-07', 'eve'), 'a');
  assert.strictEqual(owner(db, '2099-01-07', 'day'), 'b');
}

// ---- swaps ignore the shift maximum and the consecutive-night limit ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { maxConsecutiveNights: 1, maxShiftsOverride: 1 }), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'night'), A('a', '2099-01-20', 'day'), A('b', '2099-01-06', 'night')]
  );
  const trade = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'direct',
    offered: { date: '2099-01-20', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-06', shiftTypeId: 'night' },
  }));
  assert.ok(trade, "no warning past the night limit");
  assert.ok(acceptDirect(db, as(db, 'b'), { tradeId: trade!.id }).ok);
}

// ---- under 8h rest after the swap is still refused, even when confirmed ----
{
  // Offerer side: Ann would take Ben's 7th day shift right after her own
  // night ending 06:00 on the 7th.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-06', 'night'), A('a', '2099-01-20', 'eve'), A('b', '2099-01-07', 'day')],
    [mustOff('m1', 'a', '2099-01-07')]
  );
  const r = createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'direct',
    offered: { date: '2099-01-20', shiftTypeId: 'eve' },
    toUserId: 'b', requested: { date: '2099-01-07', shiftTypeId: 'day' },
    confirmedWarnings: [offMsg('2099-01-07', 'Ann').message],
  });
  assert.strictEqual(reasonOf(r), 'invalid', 'rest block at offer time');
  assert.ok(msg(r).includes('rest'), msg(r));
  assert.strictEqual(db.trades.length, 0);
}
{
  // Target side: Ben picks up a night ending 06:00 on Ann's 5th after the
  // offer was made; his confirmed accept is refused with the blocking reason.
  const db = swapDb([mustOff('m1', 'b', '2099-01-05')]);
  const trade = value(direct(db));
  db.schedules[0].assignments.push(A('b', '2099-01-04', 'night'));
  const r = acceptDirect(db, as(db, 'b'), { tradeId: trade!.id, confirmedWarnings: [offMsg('2099-01-05', 'Ben').message] });
  assert.strictEqual(reasonOf(r), 'invalid');
  assert.ok(msg(r).includes('rest'), msg(r));
  assert.strictEqual(owner(db, '2099-01-05', 'day'), 'a', 'nothing swapped');
}

// ===== start date & away time gate taking a shift in a trade =====

// Why `user` can't take `slot` in a trade, or null.
const tradeBlockingReason = (db: Db, slot: { date: string; shiftTypeId: string }, user: User) => {
  const r = scheduleEligibility(db, db.schedules[0], slot, user, TRADE_POLICY);
  return r.eligible ? null : r.reason;
};

// ---- (8) a start date after the offered shift blocks the taker ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { startDate: '2099-01-20' })],
    [A('a', '2099-01-10', 'day')]
  );
  // Ben hasn't started by the 10th, so he can't pick up Ann's shift.
  const err = tradeBlockingReason(db, { date: '2099-01-10', shiftTypeId: 'day' }, db.users[1]);
  assert.ok(err && err.includes("hasn't started"), `expected pre-start block, got: ${err}`);
}

// ---- (9) an away range covering the offered shift blocks the taker ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-10', 'day')]
  );
  db.awayTime.push({ id: 'aw1', userId: 'b', start: '2099-01-08', end: '2099-01-12' });
  const err = tradeBlockingReason(db, { date: '2099-01-10', shiftTypeId: 'day' }, db.users[1]);
  assert.ok(err && err.includes('away'), `expected away-time block, got: ${err}`);
}

// ---- (10) no away range + a start date on/before the date => allowed ----
{
  // Ben started on the 10th (boundary: start date == shift date is OK) and has
  // no away range; he holds no other shift that day, so the new checks don't
  // over-block.
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben', { startDate: '2099-01-10' })],
    [A('a', '2099-01-10', 'day')]
  );
  const ok = tradeBlockingReason(db, { date: '2099-01-10', shiftTypeId: 'day' }, db.users[1]);
  assert.strictEqual(ok, null, `start-date-on-the-day with no away should be allowed, got: ${ok}`);
}

// ===== role eligibility gates taking a shift in a trade =====

// ---- a shift's allowed roles block employees who don't hold one ----
{
  const db = mkDb(
    [mkUser('a', 'Ann', { roles: ['role-employee', 'role-mgr'] }), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'mgr')]
  );
  db.shiftTypes.push({ id: 'mgr', name: 'Manager', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, allowedRoles: ['role-mgr'] });
  // Ben lacks role-mgr -> blocked from the manager shift.
  const err = tradeBlockingReason(db, { date: '2099-01-06', shiftTypeId: 'mgr' }, db.users[1]);
  assert.ok(err && err.includes('role'), `expected a role block, got: ${err}`);
  // Ann holds role-mgr and the day is free -> allowed.
  const ok = tradeBlockingReason(db, { date: '2099-01-07', shiftTypeId: 'mgr' }, db.users[0]);
  assert.strictEqual(ok, null, `manager should be allowed: ${ok}`);
  // An unrestricted shift type is open to Ben.
  const ok2 = tradeBlockingReason(db, { date: '2099-01-08', shiftTypeId: 'day' }, db.users[1]);
  assert.strictEqual(ok2, null, `unrestricted shift should be allowed: ${ok2}`);
}

// ---- duplicate open trade for the same offered shift is rejected ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day')]
  );
  const first = createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  });
  assert.ok(first.ok, 'first open trade created');
  const dup = createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  });
  assert.strictEqual(reasonOf(dup), 'conflict', 'duplicate open trade rejected with 409');
  assert.ok(msg(dup).includes('already have an open trade'), msg(dup));
  // A different type for the same shift is still allowed (open swap vs giveaway
  // are distinct offers), and cancelling frees the slot for a new trade.
  cancelTrade(db, as(db, 'a'), { tradeId: value(first).id });
  const again = createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 'day' },
  });
  assert.ok(again.ok, 'cancelled trade no longer blocks a new one');
}

// ===== the outcome convention (ADR 0003) =====

// ---- "future" means after the context's today, not the clock's ----
{
  const db = mkDb([mkUser('a', 'Ann'), mkUser('b', 'Ben')], [A('a', '2050-01-02', 'day')]);
  const offer = { scheduleId: 'sch1', type: 'open' as const, offered: { date: '2050-01-02', shiftTypeId: 'day' } };
  const onTheDay = createTrade(db, as(db, 'a', '2050-01-02'), offer);
  assert.deepStrictEqual([reasonOf(onTheDay), msg(onTheDay)], ['invalid', 'Only future shifts can be traded.'], "today's shift is not tradable");
  assert.ok(createTrade(db, as(db, 'a', '2050-01-01'), offer).ok, "tomorrow's shift is");
}

// ---- refusals that expire a stale trade (or drop a stale offer) set persist; others don't ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day'), A('c', '2099-01-12', 'day')]
  );
  const open = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'open', offered: { date: '2099-01-05', shiftTypeId: 'day' } }));
  value(respondToOpenTrade(db, as(db, 'b'), { tradeId: open.id, date: '2099-01-10', shiftTypeId: 'day' }));
  const self = respondToOpenTrade(db, as(db, 'a'), { tradeId: open.id, date: '2099-01-05', shiftTypeId: 'day' });
  assert.deepStrictEqual([reasonOf(self), persists(self)], ['invalid', false]);
  const notOwner = acceptOpenResponse(db, as(db, 'c'), { tradeId: open.id, responseUserId: 'b' });
  assert.deepStrictEqual([reasonOf(notOwner), msg(notOwner), persists(notOwner)], ['forbidden', 'Only the trade owner can accept an offer.', false]);
  assert.deepStrictEqual(reasonOf(cancelTrade(db, as(db, 'a'), { tradeId: 'nope' })), 'not_found');

  // Ben's offered shift moves away: accepting drops his offer, and that is kept.
  db.schedules[0].assignments.find((x) => x.date === '2099-01-10')!.userId = 'c';
  const staleOffer = acceptOpenResponse(db, as(db, 'a'), { tradeId: open.id, responseUserId: 'b' });
  assert.deepStrictEqual([reasonOf(staleOffer), msg(staleOffer), persists(staleOffer)], ['conflict', "Ben's offered shift is no longer valid.", true]);
  assert.strictEqual(open.responses.length, 0);

  // Ann's offered shift moves away: the trade expires, and that is kept.
  db.schedules[0].assignments.find((x) => x.date === '2099-01-05')!.userId = 'c';
  const expired = respondToOpenTrade(db, as(db, 'b'), { tradeId: open.id, date: '2099-01-10', shiftTypeId: 'day' });
  assert.ok(!expired.ok); // Ben no longer holds the 10th
  const expiring = respondToOpenTrade(db, as(db, 'c'), { tradeId: open.id, date: '2099-01-12', shiftTypeId: 'day' });
  assert.deepStrictEqual([reasonOf(expiring), persists(expiring)], ['conflict', true]);
  assert.strictEqual(open.status, 'expired');
}

// ---- acceptTrade accepts an open swap's offer or a direct proposal ----
{
  const db = mkDb(
    [mkUser('a', 'Ann'), mkUser('b', 'Ben')],
    [A('a', '2099-01-05', 'day'), A('b', '2099-01-10', 'day'), A('a', '2099-01-06', 'day'), A('b', '2099-01-11', 'day')]
  );
  const open = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'open', offered: { date: '2099-01-05', shiftTypeId: 'day' } }));
  value(respondToOpenTrade(db, as(db, 'b'), { tradeId: open.id, date: '2099-01-10', shiftTypeId: 'day' }));
  assert.strictEqual(value(acceptTrade(db, as(db, 'a'), { tradeId: open.id, responseUserId: 'b' })).status, 'completed');
  const proposal = value(createTrade(db, as(db, 'a'), {
    scheduleId: 'sch1', type: 'direct', offered: { date: '2099-01-06', shiftTypeId: 'day' },
    toUserId: 'b', requested: { date: '2099-01-11', shiftTypeId: 'day' },
  }));
  assert.strictEqual(value(acceptTrade(db, as(db, 'b'), { tradeId: proposal.id })).status, 'completed');
  assert.deepStrictEqual([reasonOf(acceptTrade(db, as(db, 'b'), { tradeId: 'nope' })), msg(acceptTrade(db, as(db, 'b'), { tradeId: 'nope' }))], ['not_found', 'Trade not found.']);
}

// ---- through the route adapter: a refusal rolls back, a persisting refusal keeps its change ----
{
  // An in-memory withMutation: commits the callback's changes only if it returns.
  const store = (db: Db) => {
    const s = { db };
    const mutate: Mutate = async (fn) => {
      const draft = structuredClone(s.db);
      const result = await fn(draft);
      s.db = draft;
      return result;
    };
    return { s, mutate };
  };
  const adapterTests = async () => {
    // Expiry persists: the stale giveaway is saved as expired and the giver told.
    {
      const db = mkDb([mkUser('a', 'Ann'), mkUser('b', 'Ben'), mkUser('c', 'Cy')], [A('a', '2099-01-15', 'day')]);
      const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-15', shiftTypeId: 'day' } }));
      db.schedules[0].assignments[0].userId = 'c'; // an admin moved the shift
      const { s, mutate } = store(db);
      const res = await runCommand(mutate, 'b', TODAY, (d, ctx) => claimGiveaway(d, ctx, { tradeId: give.id }));
      assert.deepStrictEqual(res, { status: 409, body: { error: 'That shift is no longer available — giveaway expired.', code: 'conflict' } });
      assert.strictEqual(s.db.trades[0].status, 'expired', 'expiry saved');
      assert.ok(notesFor(s.db, 'a').some((m) => m.includes('expired')), 'expiry notice saved');
    }
    // Any other refusal leaves the data unchanged.
    {
      const db = mkDb([mkUser('a', 'Ann'), mkUser('b', 'Ben')], [A('a', '2099-01-07', 'day')], [mustOff('m1', 'b', '2099-01-07')]);
      const give = value(createTrade(db, as(db, 'a'), { scheduleId: 'sch1', type: 'giveaway', offered: { date: '2099-01-07', shiftTypeId: 'day' } }));
      const before = structuredClone(db);
      const { s, mutate } = store(db);
      const res = await runCommand(mutate, 'b', TODAY, (d, ctx) => claimGiveaway(d, ctx, { tradeId: give.id }));
      assert.deepStrictEqual(res, {
        status: 409,
        body: { error: offMsg('2099-01-07', 'Ben').message, code: 'eligibility_warnings', warnings: [offMsg('2099-01-07', 'Ben')] },
      });
      assert.deepStrictEqual(s.db, before, 'unchanged');
    }
  };
  await adapterTests();
}

console.log('All trade tests passed.');
