// Smoke test: tsx shared/settlement.test.ts
import assert from 'assert';
import {
  shiftWeight, countingShifts, shiftMaximum, requiredShifts, shortfall, extraDays, vacationCharged, vacationChargedInYear,
  vacationYearOf, vacationYearsOf, yearBalance, electedVacation, electedVacationInYear, electedYears, shortfallCharges, giveaway, applyElectionCut, migrateLegacySettlement,
} from './settlement.js';
import type { Assignment, Schedule, ShiftType, VacationCharge, VacationChargeCause } from './types.js';

const st = (id: string, weight?: number | null): ShiftType => ({
  id, name: id, startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, weight,
});
const A = (userId: string, date: string, shiftTypeId: string): Assignment => ({ userId, date, shiftTypeId });
const C = (userId: string, date: string, cause: VacationChargeCause = 'shortfall'): VacationCharge => ({ userId, date, cause });

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
  const charged = { ...three, vacationCharges: [C('a', '2026-06-05')] };
  assert.strictEqual(shortfall({ shiftTypes }, charged, ann), 1, 'shortfall is counting shifts only');
  assert.strictEqual(extraDays({ shiftTypes }, charged, ann), 0, '2 + 1 charged = 3 required');
  // vacation charges count toward extra days
  const over = {
    assignments: [...three.assignments, A('a', '2026-06-04', 'heavy')],
    vacationCharges: [C('a', '2026-06-05'), C('a', '2026-06-06'), C('b', '2026-06-06')],
  };
  assert.strictEqual(shortfall({ shiftTypes }, over, ann), 0, 'no shortfall at or above required');
  assert.strictEqual(extraDays({ shiftTypes }, over, ann), 2, '3 counting + 2 charged - 3 required');
  assert.strictEqual(vacationCharged(over, 'a'), 2, "only a's charges");
}

// ---- vacation year: the calendar year of a day; a schedule spans every year its days fall in
{
  assert.strictEqual(vacationYearOf('2026-12-31'), 2026);
  assert.strictEqual(vacationYearOf('2027-01-01'), 2027);
  assert.deepStrictEqual(vacationYearsOf({ startDate: '2026-12-28', endDate: '2027-01-10' }), [2026, 2027], 'spans New Year');
  assert.deepStrictEqual(vacationYearsOf({ startDate: '2026-06-01', endDate: '2026-06-14' }), [2026]);
}

// ---- year balance: allowance + elected vacation for that year - charges dated in that year
{
  const ann = { id: 'a', vacationDays: 10 };
  const schedules: Pick<Schedule, 'vacationCharges' | 'extraElections'>[] = [
    {
      vacationCharges: [C('a', '2026-01-06'), C('a', '2026-01-07'), ...[1, 2, 3, 4, 5].map((d) => C('b', `2026-01-0${d}`))],
      extraElections: { a: { vacationByYear: { 2026: 1 }, incentive: 4 } },
    },
    // spans New Year: each charge and each elected day counts toward its own year
    {
      vacationCharges: [C('a', '2026-12-30'), C('a', '2027-01-03', 'giveaway')],
      extraElections: { a: { vacationByYear: { 2026: 1, 2027: 2 }, incentive: 0 } },
    },
    { vacationCharges: [C('a', '2027-02-01', 'legacy'), C('a', '2027-02-02', 'legacy')] },
    { extraElections: { a: { vacationByYear: { 2025: 7 }, incentive: 0 } } },
  ];
  assert.deepStrictEqual(yearBalance({ schedules }, ann, 2026), { used: 3, earned: 2, balance: 9 }, '10 + 2 - 3');
  assert.deepStrictEqual(yearBalance({ schedules }, ann, 2027), { used: 3, earned: 2, balance: 9 }, '10 + 2 - 3');
  assert.deepStrictEqual(yearBalance({ schedules }, ann, 2030), { used: 0, earned: 0, balance: 10 }, 'no schedules -> allowance');
  assert.deepStrictEqual(yearBalance({ schedules: [] }, { id: 'a', vacationDays: 0 }, 2026), { used: 0, earned: 0, balance: 0 });
  // can go negative (e.g. a lowered allowance) — callers floor it where they need to
  assert.strictEqual(yearBalance({ schedules }, { id: 'a', vacationDays: 1 }, 2027).balance, 0);
  assert.strictEqual(yearBalance({ schedules }, { id: 'a', vacationDays: 0 }, 2026).balance, -1);
  assert.strictEqual(electedVacation({ vacationByYear: { 2026: 1, 2027: 2 }, incentive: 5 }), 3, 'all years');
  assert.strictEqual(electedVacationInYear({ vacationByYear: { 2026: 1, 2027: 2 }, incentive: 5 }, 2027), 2, 'one year');
  assert.strictEqual(electedVacation(undefined), 0);
  assert.deepStrictEqual(electedYears({ vacationByYear: { 2027: 2, 2026: 1, 2028: 0 }, incentive: 0 }), [2026, 2027], 'years with days, earliest first');
  assert.strictEqual(vacationChargedInYear(schedules[1], 'a', 2027), 1);
}

// ---- shortfall charges: must-off days earliest first, each vacation year's balance its own limit
{
  const charge = (required: number, counting: number, mustOffDates: string[], balances: Record<number, number>) =>
    shortfallCharges({ required, counting, mustOffDates, yearBalance: (y) => balances[y] ?? 0 });
  const days = ['2026-06-03', '2026-06-01', '2026-06-02'];
  assert.deepStrictEqual(charge(5, 3, days, { 2026: 9 }), ['2026-06-01', '2026-06-02'], 'capped by the shortfall, earliest first');
  assert.deepStrictEqual(charge(5, 2, ['2026-06-02'], { 2026: 9 }), ['2026-06-02'], 'capped by the must-off days that caused it');
  assert.deepStrictEqual(charge(5, 2, days, { 2026: 2 }), ['2026-06-01', '2026-06-02'], 'capped by the year balance');
  assert.deepStrictEqual(charge(5, 6, days, { 2026: 9 }), [], 'no shortfall -> no charge');
  assert.deepStrictEqual(charge(5, 2, [], { 2026: 9 }), [], 'no must-off days -> no charge');
  assert.deepStrictEqual(charge(5, 2, days, { 2026: -3 }), [], 'a negative balance charges nothing');

  // The schedule 28 Dec 2026 - 10 Jan 2027, must-off days 30 Dec and 3 Jan, shortfall 1.
  const newYear = ['2027-01-03', '2026-12-30'];
  assert.deepStrictEqual(charge(4, 3, newYear, { 2026: 5, 2027: 5 }), ['2026-12-30'], 'the earlier day, charged to 2026');
  assert.deepStrictEqual(charge(4, 3, newYear, { 2026: 0, 2027: 5 }), ['2027-01-03'], "2026 empty -> 3 Jan, charged to 2027");
  assert.deepStrictEqual(charge(4, 2, newYear, { 2026: 1, 2027: 1 }), ['2026-12-30', '2027-01-03'], 'one from each year');
  assert.deepStrictEqual(charge(4, 2, ['2026-12-30', '2026-12-31', '2027-01-03'], { 2026: 1, 2027: 0 }), ['2026-12-30'],
    "2026's balance limits 2026's days; 2027's is empty");
}

// ---- giveaway calculation
{
  type Extra = Partial<Pick<Schedule, 'vacationCharges' | 'extraElections'>>;
  const sched = (extra: Extra = {}) => ({
    startDate: '2099-01-01',
    endDate: '2099-01-31',
    assignments: [A('a', '2099-01-15', 'day'), A('a', '2099-01-16', 'day'), A('a', '2099-01-17', 'standby')],
    ...extra,
  });
  const giver = (o: object = {}) => ({ id: 'a', vacationDays: 5, requiredShifts: 2, ...o });
  const calc = (schedule: ReturnType<typeof sched>, g: ReturnType<typeof giver>, shiftTypeId: string) =>
    giveaway({ shiftTypes, schedules: [schedule] }, schedule, g, { date: '2099-01-15', shiftTypeId });
  const el = (vacationByYear: Record<string, number>, incentive = 0) => ({ a: { vacationByYear, incentive } });

  // standby shift: never needs a day, nothing changes
  {
    const r = calc(sched(), giver(), 'standby');
    assert.strictEqual(r.needsDay, false, 'standby giveaway never needs a vacation day');
    assert.strictEqual(r.extraAfter, 0);
    assert.deepStrictEqual(r.balancesAfter, {}, 'nothing charged or cut');
    assert.ok(r.canPost && r.canClaim);
  }
  // above required: no day
  {
    const r = calc(sched(), giver({ requiredShifts: 1 }), 'day');
    assert.strictEqual(r.needsDay, false, '2 counting, 1 required: still at required after giving one');
    assert.strictEqual(r.extraAfter, 0, '1 counting - 1 required');
    assert.deepStrictEqual(r.balancesAfter, {});
  }
  // at required: needs a day, which keeps extra days level
  {
    const r = calc(sched(), giver(), 'day');
    assert.strictEqual(r.needsDay, true, '2 counting, 2 required: giving one drops below');
    assert.strictEqual(r.chargeYear, 2099);
    assert.strictEqual(r.extraAfter, 0, '1 counting + 1 new charge - 2 required');
    assert.strictEqual(r.balanceBefore, 5);
    assert.deepStrictEqual(r.balancesAfter, { 2099: 4 }, 'the vacation day comes off the year balance');
    assert.ok(r.canPost && r.canClaim);
  }
  // an existing charge covers the gap: no new day
  {
    const r = calc(sched({ vacationCharges: [C('a', '2099-01-20')] }), giver(), 'day');
    assert.strictEqual(r.needsDay, false, '1 counting + 1 charged = 2 required');
  }
  // election cut: incentive days first, then vacation days
  {
    // 2 counting, 0 required -> 2 extra; giving one leaves 1 extra; 2 elected -> cut 1
    const r = calc(sched({ extraElections: el({ 2099: 1 }, 1) }), giver({ requiredShifts: 0 }), 'day');
    assert.strictEqual(r.extraAfter, 1);
    assert.deepStrictEqual(r.electionCut, { incentive: 1, vacationByYear: {} }, 'incentive cut first');
    assert.deepStrictEqual(r.balancesAfter, {}, 'only incentive cut: no year touched');

    const r2 = calc(sched({ extraElections: el({ 2099: 2 }) }), giver({ requiredShifts: 0 }), 'day');
    assert.deepStrictEqual(r2.electionCut, { incentive: 0, vacationByYear: { 2099: 1 } }, 'then vacation');
    assert.deepStrictEqual(r2.balancesAfter, { 2099: 6 }, '5 + 2 elected - 1 cut');

    const none = calc(sched(), giver({ requiredShifts: 0 }), 'day');
    assert.deepStrictEqual(none.electionCut, { incentive: 0, vacationByYear: {} }, 'no election -> no cut');
  }
  // claim-time block: the balance after the day and the vacation cut would go below zero
  {
    const r = calc(sched(), giver({ vacationDays: 0 }), 'day');
    assert.deepStrictEqual(r.balancesAfter, { 2099: -1 });
    assert.strictEqual(r.canClaim, false, 'unaffordable at claim');
    const ok = calc(sched(), giver({ vacationDays: 1 }), 'day');
    assert.deepStrictEqual(ok.balancesAfter, { 2099: 0 });
    assert.strictEqual(ok.canClaim, true, 'landing exactly on zero is affordable');
    // a vacation cut alone can block the claim
    const cut = calc(sched({ extraElections: el({ 2099: 2 }) }), giver({ requiredShifts: 0, vacationDays: -2 }), 'day');
    assert.strictEqual(cut.needsDay, false);
    assert.deepStrictEqual(cut.balancesAfter, { 2099: -1 }, '-2 + 2 elected - 1 cut');
    assert.strictEqual(cut.canClaim, false);
  }
  // posting-time refusal: a day is needed and the balance is already zero or less
  {
    assert.strictEqual(calc(sched(), giver({ vacationDays: 0 }), 'day').canPost, false, 'needs a day, none left');
    assert.strictEqual(calc(sched(), giver({ vacationDays: 1 }), 'day').canPost, true, 'needs a day, one left');
    assert.strictEqual(calc(sched(), giver({ vacationDays: 0, requiredShifts: 1 }), 'day').canPost, true, 'no day needed -> balance irrelevant');
    // the election cut isn't considered at posting
    const r = calc(sched({ extraElections: el({ 2099: 2 }) }), giver({ requiredShifts: 0, vacationDays: -2 }), 'day');
    assert.strictEqual(r.canPost, true, 'no day needed, so posting ignores the cut');
  }
}

// ---- giveaway across New Year: the charge is dated on the given-away day; the cut goes earlier year first
{
  // Schedule 28 Dec 2026 - 10 Jan 2027; a holds 3 counting shifts, one in 2027.
  const sched = (extra: Partial<Pick<Schedule, 'vacationCharges' | 'extraElections'>> = {}) => ({
    startDate: '2026-12-28',
    endDate: '2027-01-10',
    assignments: [A('a', '2026-12-29', 'day'), A('a', '2026-12-30', 'day'), A('a', '2027-01-05', 'day')],
    ...extra,
  });
  const giver = (o: object = {}) => ({ id: 'a', vacationDays: 3, requiredShifts: 3, ...o });
  const give = (schedule: ReturnType<typeof sched>, g: ReturnType<typeof giver>, date: string, others: object[] = []) =>
    giveaway({ shiftTypes, schedules: [schedule, ...others] }, schedule, g, { date, shiftTypeId: 'day' });

  // giving up a January shift charges 2027, whatever year the schedule starts in
  {
    const r = give(sched(), giver(), '2027-01-05');
    assert.strictEqual(r.needsDay, true);
    assert.strictEqual(r.chargeYear, 2027, 'dated on the day of the shift given away');
    assert.deepStrictEqual(r.balancesAfter, { 2027: 2 });
    // 2027 has nothing left: can't post, even though 2026 does
    const spent2027 = { vacationCharges: [C('a', '2027-02-01'), C('a', '2027-02-02'), C('a', '2027-02-03')] };
    const blocked = give(sched(), giver(), '2027-01-05', [spent2027]);
    assert.strictEqual(blocked.balanceBefore, 0, "2027's balance");
    assert.strictEqual(blocked.canPost, false, "2026's balance can't pay for a 2027 day");
  }
  // election cut: incentive first, then the earlier year as far as its balance absorbs, then the later year
  {
    // required 0: 3 extra, 2 after the giveaway. Elected 2026: 2, 2027: 1, incentive 1 = 4 -> cut 2.
    const elected = { a: { vacationByYear: { 2026: 2, 2027: 1 }, incentive: 1 } };
    const r = give(sched({ extraElections: elected }), giver({ requiredShifts: 0 }), '2026-12-30');
    assert.deepStrictEqual(r.electionCut, { incentive: 1, vacationByYear: { 2026: 1 } }, 'incentive, then 2026');
    assert.deepStrictEqual(r.balancesAfter, { 2026: 4 }, '3 + 2 - 1');
    assert.ok(r.canClaim);

    // 2026's balance is mostly spent (3 + 2 elected - 4 charged = 1 left).
    const spent = {
      extraElections: { a: { vacationByYear: { 2026: 2, 2027: 2 }, incentive: 0 } },
      vacationCharges: ['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map((d) => C('a', d, 'legacy')),
    };
    // required 4: 2 counting + 4 charged - 4 = 2 extra after; elected 4 -> cut 2
    const r2 = give(sched(spent), giver({ requiredShifts: 4 }), '2026-12-30');
    assert.strictEqual(r2.needsDay, false);
    assert.deepStrictEqual(r2.electionCut, { incentive: 0, vacationByYear: { 2026: 1, 2027: 1 } },
      '2026 absorbs only the 1 it has left, the rest comes from 2027');
    assert.deepStrictEqual(r2.balancesAfter, { 2026: 0, 2027: 4 });
    assert.ok(r2.canClaim);

    // Neither year can absorb it. Allowance 0, elected 2026: 2, 2027: 1; 2026 is at -2, 2027 at 1.
    // required 5: 2 counting + 4 charged - 5 = 1 extra after; elected 3 -> cut 2.
    const r3 = give(
      sched({ ...spent, extraElections: { a: { vacationByYear: { 2026: 2, 2027: 1 }, incentive: 0 } } }),
      giver({ requiredShifts: 5, vacationDays: 0 }),
      '2026-12-30'
    );
    assert.deepStrictEqual(r3.electionCut, { incentive: 0, vacationByYear: { 2027: 1, 2026: 1 } }, '2027 gives what it has, the rest from 2026');
    assert.deepStrictEqual(r3.balancesAfter, { 2026: -3, 2027: 0 });
    assert.strictEqual(r3.canClaim, false, 'neither year can absorb the cut');
  }
  // only years actually charged or cut gate the claim: an untouched, already-negative year doesn't block it
  {
    // 2026 is at 0 + 1 elected - 3 charged = -2; 2027 at 0 + 2 elected = 2.
    // required 0: 3 extra, 2 after the giveaway; elected 3 -> cut 1, all from 2027 (2026 can't absorb any).
    const spent2026 = { vacationCharges: ['2026-01-02', '2026-01-03', '2026-01-04'].map((d) => C('a', d)) };
    const elected = sched({ extraElections: { a: { vacationByYear: { 2026: 1, 2027: 2 }, incentive: 0 } } });
    const g = giver({ requiredShifts: 0, vacationDays: 0 });
    for (const date of ['2026-12-30', '2027-01-05']) {
      const r = give(elected, g, date, [spent2026]);
      assert.strictEqual(r.needsDay, false);
      assert.deepStrictEqual(r.electionCut, { incentive: 0, vacationByYear: { 2027: 1 } });
      assert.deepStrictEqual(r.balancesAfter, { 2027: 1 }, `only the cut year is touched (shift on ${date})`);
      assert.strictEqual(r.canClaim, true, `the untouched negative 2026 doesn't block (shift on ${date})`);
    }
  }
}

// ---- applying an election cut: each year's elected days drop by the cut; years left at zero disappear
{
  const el = { vacationByYear: { 2026: 2, 2027: 1 }, incentive: 3 };
  assert.deepStrictEqual(
    applyElectionCut(el, { incentive: 1, vacationByYear: { 2027: 1, 2026: 1 } }),
    { vacationByYear: { 2026: 1 }, incentive: 2 }
  );
  assert.deepStrictEqual(applyElectionCut(el, { incentive: 0, vacationByYear: {} }), el, 'no cut -> unchanged');
  assert.deepStrictEqual(el, { vacationByYear: { 2026: 2, 2027: 1 }, incentive: 3 }, 'the original election is not mutated');
}

// ---- migration: legacy per-schedule counts become dated charges and start-year elections; no year balance changes
{
  const legacy: Parameters<typeof migrateLegacySettlement>[0][] = [
    { startDate: '2026-12-28', vacationCharged: { a: 2, b: 1 }, extraElections: { a: { vacation: 3, incentive: 1 }, b: { vacation: 0, incentive: 2 } } },
    { startDate: '2027-01-11', vacationCharged: { a: 1 }, extraElections: {} },
    { startDate: '2026-06-01' },
  ];
  const migrated = legacy.map((s) => migrateLegacySettlement(s));
  assert.deepStrictEqual(migrated[0].vacationCharges, [C('a', '2026-12-28', 'legacy'), C('a', '2026-12-28', 'legacy'), C('b', '2026-12-28', 'legacy')],
    "dated on the schedule's start date, cause legacy");
  assert.deepStrictEqual(migrated[0].extraElections, {
    a: { vacationByYear: { 2026: 3 }, incentive: 1 },
    b: { vacationByYear: {}, incentive: 2 },
  }, "elected vacation moves to the schedule's start year");
  assert.deepStrictEqual(migrated[2], { vacationCharges: [], extraElections: {} });
  // Balances under the old rule (every count in its schedule's start year), worked by hand:
  // a 2026: 10 + 3 - 2 = 11; a 2027: 10 - 1 = 9; b 2026: 10 - 1 = 9; b 2027: 10.
  const bal = (id: string, year: number) => yearBalance({ schedules: migrated }, { id, vacationDays: 10 }, year).balance;
  assert.deepStrictEqual([bal('a', 2026), bal('a', 2027), bal('b', 2026), bal('b', 2027)], [11, 9, 9, 10]);
  // idempotent: an already-migrated schedule passes through unchanged
  assert.deepStrictEqual(migrateLegacySettlement({ startDate: '2026-12-28', ...migrated[0] }), migrated[0]);
  // a fractional legacy count can't become whole charges without changing a balance: refuse, naming the schedule and person
  assert.throws(
    () => migrateLegacySettlement({ id: 'sch-x', startDate: '2026-12-28', vacationCharged: { a: 1.5 } }),
    /sch-x.*\ba\b.*1\.5/
  );
  assert.throws(
    () => migrateLegacySettlement({ id: 'sch-y', startDate: '2026-12-28', extraElections: { b: { vacation: 0.5, incentive: 0 } } }),
    /sch-y.*\bb\b.*0\.5/
  );
}

console.log('All settlement tests passed.');
