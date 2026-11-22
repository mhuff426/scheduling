// Smoke test: tsx server/schema.test.ts
// Covers the row translation the MySQL per-day-vacation-years migration
// (migrateToVacationYears) writes, without needing a database.
import assert from 'assert';
import { legacySettlementRows } from './schema.js';
import { vacationYearOf } from '../shared/settlement.js';

// ---- per-day vacation years migration: no year balance changes for a New-Year-spanning schedule
{
  const schedules = [
    { id: 'sch-ny', start_date: '2026-12-28' }, // spans New Year: 28 Dec 2026 - 10 Jan 2027
    { id: 'sch-jan', start_date: '2027-01-11' },
  ];
  // Old rows, as MySQL returns them (DOUBLE columns).
  const chargeRows = [
    { schedule_id: 'sch-ny', user_id: 'a', days: 2 },
    { schedule_id: 'sch-ny', user_id: 'b', days: 1 },
    { schedule_id: 'sch-jan', user_id: 'a', days: 1 },
  ];
  const electionRows = [
    { schedule_id: 'sch-ny', user_id: 'a', vacation: 3, incentive: 1 },
    { schedule_id: 'sch-ny', user_id: 'b', vacation: 0, incentive: 2 },
  ];
  const { charges, vacation } = legacySettlementRows(schedules, chargeRows, electionRows);
  assert.deepStrictEqual(charges, [
    ['sch-ny', 'a', '2026-12-28', 'legacy', 0],
    ['sch-ny', 'a', '2026-12-28', 'legacy', 1],
    ['sch-ny', 'b', '2026-12-28', 'legacy', 2],
    ['sch-jan', 'a', '2027-01-11', 'legacy', 0],
  ], "legacy charges dated on each schedule's start date");
  assert.deepStrictEqual(vacation, [['sch-ny', 'a', 2026, 3]], "elected vacation goes to the start date's year");

  // Year balances from the new rows, allowance 10. Under the old rule (every
  // count in its schedule's start year), worked by hand:
  // a 2026: 10 + 3 - 2 = 11; a 2027: 10 - 1 = 9; b 2026: 10 - 1 = 9; b 2027: 10.
  const balance = (userId: string, year: number) =>
    10 +
    vacation.filter(([, u, y]) => u === userId && y === year).reduce((t, [, , , d]) => t + Number(d), 0) -
    charges.filter(([, u, date]) => u === userId && vacationYearOf(String(date)) === year).length;
  assert.deepStrictEqual([balance('a', 2026), balance('a', 2027), balance('b', 2026), balance('b', 2027)], [11, 9, 9, 10]);

  // A fractional old count fails the migration, naming the schedule and person.
  assert.throws(
    () => legacySettlementRows(schedules, [{ schedule_id: 'sch-ny', user_id: 'a', days: 0.5 }], []),
    /sch-ny.*\ba\b/
  );
}

console.log('All schema tests passed.');
