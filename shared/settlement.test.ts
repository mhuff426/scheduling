// Smoke test: tsx shared/settlement.test.ts
import assert from 'assert';
import {
  shiftWeight, countingShifts, shiftMaximum, requiredShifts, shortfall, extraDays, vacationYearOf, yearBalance, vacationCharge, giveaway,
} from './settlement.js';
import type { Assignment, Schedule, ShiftType } from './types.js';

const st = (id: string, weight?: number | null): ShiftType => ({
  id, name: id, startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, weight,
});
const A = (userId: string, date: string, shiftTypeId: string): Assignment => ({ userId, date, shiftTypeId });

const day = st('day');
const standby = st('standby', 0);
const heavy = st('heavy', 2);
const shiftTypes = [day, standby, heavy];

// ---- shift weight: explicit number (0 allowed) wins; null/absent/'' = automatic (1)
{
  assert.strictEqual(shiftWeight(heavy), 2, 'explicit weight wins');
  assert.strictEqual(shiftWeight(standby), 0, 'explicit 0 = standby');
  assert.strictEqual(shiftWeight(day), 1, 'absent weight is automatic (1)');
  assert.strictEqual(shiftWeight(st('n', null)), 1, 'null weight is automatic, not standby');
  assert.strictEqual(shiftWeight({ ...day, weight: '' as any }), 1, 'empty-string weight is automatic');
}

// ---- counting shifts: standby and deleted shift types never count; weight doesn't multiply
{
  const schedule = {
    assignments: [
      A('a', '2026-06-01', 'day'),
      A('a', '2026-06-02', 'heavy'),
      A('a', '2026-06-03', 'standby'),
      A('a', '2026-06-04', 'gone'), // shift type since deleted
      A('b', '2026-06-01', 'day'),
    ],
  };
  assert.strictEqual(countingShifts({ shiftTypes }, schedule, 'a'), 2, 'day + heavy count once each');
  assert.strictEqual(countingShifts({ shiftTypes }, schedule, 'b'), 1);
  assert.strictEqual(countingShifts({ shiftTypes }, schedule, 'nobody'), 0);
}

// ---- shift maximum: absent, invalid or non-positive override = no maximum
{
  assert.strictEqual(shiftMaximum({ maxShiftsOverride: 4 }), 4);
  assert.strictEqual(shiftMaximum({}), Infinity, 'absent = no maximum');
  assert.strictEqual(shiftMaximum({ maxShiftsOverride: null }), Infinity, 'null = no maximum');
  assert.strictEqual(shiftMaximum({ maxShiftsOverride: 0 }), Infinity, '0 = no maximum, not "no shifts"');
  assert.strictEqual(shiftMaximum({ maxShiftsOverride: -2 }), Infinity, 'negative = no maximum');
  assert.strictEqual(shiftMaximum({ maxShiftsOverride: 'x' as any }), Infinity, 'invalid = no maximum');
}

// ---- required shifts: personal requirement, lowered to the shift maximum when smaller
{
  assert.strictEqual(requiredShifts({ requiredShifts: 3 }), 3, 'no maximum');
  assert.strictEqual(requiredShifts({ requiredShifts: 9, maxShiftsOverride: 4 }), 4, 'maximum below requirement lowers it');
  assert.strictEqual(requiredShifts({ requiredShifts: 2, maxShiftsOverride: 4 }), 2, 'maximum above requirement leaves it');
  assert.strictEqual(requiredShifts({ requiredShifts: 3, maxShiftsOverride: 0 }), 3, 'non-positive maximum ignored');
  assert.strictEqual(requiredShifts({ requiredShifts: null }), 0, 'no requirement = 0');
  assert.strictEqual(requiredShifts({}), 0, 'absent requirement = 0');
}

// ---- shortfall and extra days
{
  const ann = { id: 'a', requiredShifts: 3 };
  const three = { assignments: [A('a', '2026-06-01', 'day'), A('a', '2026-06-02', 'day'), A('a', '2026-06-03', 'standby')] };
  // a holds 2 counting shifts against 3 required
  assert.strictEqual(shortfall({ shiftTypes }, three, ann), 1, 'one counting shift short');
  assert.strictEqual(extraDays({ shiftTypes }, three, ann), 0, 'short -> no extra days (never below zero)');
  // a vacation charge covers the gap without being a shortfall itself
  const charged = { ...three, vacationCharged: { a: 1 } };
  assert.strictEqual(shortfall({ shiftTypes }, charged, ann), 1, 'shortfall is counting shifts only');
  assert.strictEqual(extraDays({ shiftTypes }, charged, ann), 0, '2 + 1 charged = 3 required');
  // vacation charges count toward extra days
  const over = { assignments: [...three.assignments, A('a', '2026-06-04', 'heavy')], vacationCharged: { a: 2 } };
  assert.strictEqual(shortfall({ shiftTypes }, over, ann), 0, 'no shortfall at or above required');
  assert.strictEqual(extraDays({ shiftTypes }, over, ann), 2, '3 counting + 2 charged - 3 required');
}

// ---- vacation year of a schedule: the calendar year of its start date
{
  assert.strictEqual(vacationYearOf({ startDate: '2026-12-28' }), 2026, 'a schedule spanning New Year belongs to its start year');
  assert.strictEqual(vacationYearOf({ startDate: '2027-01-01' }), 2027);
}

// ---- year balance: allowance + elected vacation - charges, schedules in that year only
{
  const ann = { id: 'a', vacationDays: 10 };
  const schedules: Pick<Schedule, 'startDate' | 'vacationCharged' | 'extraElections'>[] = [
    { startDate: '2026-01-05', vacationCharged: { a: 2, b: 5 }, extraElections: { a: { vacation: 1, incentive: 4 } } },
    { startDate: '2026-12-28', vacationCharged: { a: 1 } }, // spans New Year, still 2026
    { startDate: '2027-01-04', vacationCharged: { a: 3 }, extraElections: { a: { vacation: 2, incentive: 0 } } },
    { startDate: '2025-06-01', extraElections: { a: { vacation: 7, incentive: 0 } } },
  ];
  assert.deepStrictEqual(yearBalance({ schedules }, ann, 2026), { used: 3, earned: 1, balance: 8 }, '10 + 1 - 3');
  assert.deepStrictEqual(yearBalance({ schedules }, ann, 2027), { used: 3, earned: 2, balance: 9 }, '10 + 2 - 3');
  assert.deepStrictEqual(yearBalance({ schedules }, ann, 2030), { used: 0, earned: 0, balance: 10 }, 'no schedules -> allowance');
  assert.deepStrictEqual(yearBalance({ schedules: [] }, { id: 'a', vacationDays: 0 }, 2026), { used: 0, earned: 0, balance: 0 });
  // can go negative (e.g. a lowered allowance) — callers floor it where they need to
  assert.strictEqual(yearBalance({ schedules }, { id: 'a', vacationDays: 1 }, 2027).balance, 0);
  assert.strictEqual(yearBalance({ schedules }, { id: 'a', vacationDays: 0 }, 2026).balance, -2);
}

// ---- vacation charge: the shortfall, capped by must-off days and the year balance, never negative
{
  const c = (required: number, counting: number, mustOffDays: number, balance: number) =>
    vacationCharge({ required, counting, mustOffDays, yearBalance: balance });
  assert.strictEqual(c(5, 2, 9, 9), 3, 'capped by the shortfall');
  assert.strictEqual(c(5, 2, 1, 9), 1, 'capped by the must-off days that caused it');
  assert.strictEqual(c(5, 2, 9, 2), 2, 'capped by the year balance');
  assert.strictEqual(c(5, 6, 9, 9), 0, 'no shortfall -> no charge');
  assert.strictEqual(c(5, 2, 0, 9), 0, 'no must-off days -> no charge');
  assert.strictEqual(c(5, 2, 9, -3), 0, 'a negative balance floors at zero');
}

// ---- giveaway calculation
{
  const sched = (extra: Partial<{ vacationCharged: Record<string, number>; extraElections: Record<string, { vacation: number; incentive: number }> }> = {}) => ({
    startDate: '2099-01-01',
    assignments: [A('a', '2099-01-15', 'day'), A('a', '2099-01-16', 'day'), A('a', '2099-01-17', 'standby')],
    ...extra,
  });
  const giver = (o: object = {}) => ({ id: 'a', vacationDays: 5, requiredShifts: 2, ...o });
  const calc = (schedule: ReturnType<typeof sched>, g: ReturnType<typeof giver>, shiftTypeId: string) =>
    giveaway({ shiftTypes, schedules: [schedule] }, schedule, g, { shiftTypeId });

  // standby shift: never needs a day, nothing changes
  {
    const r = calc(sched(), giver(), 'standby');
    assert.strictEqual(r.needsDay, false, 'standby giveaway never needs a vacation day');
    assert.strictEqual(r.extraAfter, 0);
    assert.strictEqual(r.balanceAfter, 5);
    assert.ok(r.canPost && r.canClaim);
  }
  // above required: no day
  {
    const r = calc(sched(), giver({ requiredShifts: 1 }), 'day');
    assert.strictEqual(r.needsDay, false, '2 counting, 1 required: still at required after giving one');
    assert.strictEqual(r.extraAfter, 0, '1 counting - 1 required');
    assert.strictEqual(r.balanceAfter, 5);
  }
  // at required: needs a day, which keeps extra days level
  {
    const r = calc(sched(), giver(), 'day');
    assert.strictEqual(r.needsDay, true, '2 counting, 2 required: giving one drops below');
    assert.strictEqual(r.extraAfter, 0, '1 counting + 1 new charge - 2 required');
    assert.strictEqual(r.balanceBefore, 5);
    assert.strictEqual(r.balanceAfter, 4, 'the vacation day comes off the year balance');
    assert.ok(r.canPost && r.canClaim);
  }
  // an existing charge covers the gap: no new day
  {
    const r = calc(sched({ vacationCharged: { a: 1 } }), giver(), 'day');
    assert.strictEqual(r.needsDay, false, '1 counting + 1 charged = 2 required');
  }
  // election cut: incentive days first, then vacation days
  {
    // 2 counting, 0 required -> 2 extra; giving one leaves 1 extra; 2 elected -> cut 1
    const r = calc(sched({ extraElections: { a: { vacation: 1, incentive: 1 } } }), giver({ requiredShifts: 0 }), 'day');
    assert.strictEqual(r.extraAfter, 1);
    assert.deepStrictEqual(r.electionCut, { incentive: 1, vacation: 0 }, 'incentive cut first');
    assert.strictEqual(r.balanceAfter, 6, '5 + 1 elected vacation, nothing cut from it');

    const r2 = calc(sched({ extraElections: { a: { vacation: 2, incentive: 0 } } }), giver({ requiredShifts: 0 }), 'day');
    assert.deepStrictEqual(r2.electionCut, { incentive: 0, vacation: 1 }, 'then vacation');
    assert.strictEqual(r2.balanceAfter, 6, '5 + 2 elected - 1 cut');

    const none = calc(sched(), giver({ requiredShifts: 0 }), 'day');
    assert.deepStrictEqual(none.electionCut, { incentive: 0, vacation: 0 }, 'no election -> no cut');
  }
  // claim-time block: the balance after the day and the vacation cut would go below zero
  {
    const r = calc(sched(), giver({ vacationDays: 0 }), 'day');
    assert.strictEqual(r.balanceAfter, -1);
    assert.strictEqual(r.canClaim, false, 'unaffordable at claim');
    const ok = calc(sched(), giver({ vacationDays: 1 }), 'day');
    assert.strictEqual(ok.balanceAfter, 0);
    assert.strictEqual(ok.canClaim, true, 'landing exactly on zero is affordable');
    // a vacation cut alone can block the claim
    const cut = calc(
      sched({ extraElections: { a: { vacation: 2, incentive: 0 } }, vacationCharged: {} }),
      giver({ requiredShifts: 0, vacationDays: -2 }),
      'day'
    );
    assert.strictEqual(cut.needsDay, false);
    assert.strictEqual(cut.balanceAfter, -1, '-2 + 2 elected - 1 cut');
    assert.strictEqual(cut.canClaim, false);
  }
  // posting-time refusal: a day is needed and the balance is already zero or less
  {
    assert.strictEqual(calc(sched(), giver({ vacationDays: 0 }), 'day').canPost, false, 'needs a day, none left');
    assert.strictEqual(calc(sched(), giver({ vacationDays: 1 }), 'day').canPost, true, 'needs a day, one left');
    assert.strictEqual(calc(sched(), giver({ vacationDays: 0, requiredShifts: 1 }), 'day').canPost, true, 'no day needed -> balance irrelevant');
    // the election cut isn't considered at posting
    const r = calc(
      sched({ extraElections: { a: { vacation: 2, incentive: 0 } } }),
      giver({ requiredShifts: 0, vacationDays: -2 }),
      'day'
    );
    assert.strictEqual(r.canPost, true, 'no day needed, so posting ignores the cut');
  }
}

console.log('All settlement tests passed.');
