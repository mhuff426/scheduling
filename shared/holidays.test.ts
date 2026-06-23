// Smoke test: tsx shared/holidays.test.ts
import assert from 'assert';
import { resolveHoliday, holidayDatesInRange, isValidRecurrence } from './holidays.js';
import type { Holiday } from './types.js';

const mk = (recurrence: Holiday['recurrence'], workable = true): Holiday =>
  ({ id: 'h', name: 'H', workable, recurrence });

// ---- yearly: same month/day every year
{
  const xmas = mk({ type: 'yearly', month: 12, day: 25 });
  assert.strictEqual(resolveHoliday(xmas, 2026), '2026-12-25', 'yearly resolves in 2026');
  assert.strictEqual(resolveHoliday(xmas, 2027), '2027-12-25', 'yearly resolves in 2027');
}

// ---- yearly Feb 29: only in leap years, otherwise no occurrence
{
  const leapDay = mk({ type: 'yearly', month: 2, day: 29 });
  assert.strictEqual(resolveHoliday(leapDay, 2026), null, 'Feb 29 has no occurrence in non-leap 2026');
  assert.strictEqual(resolveHoliday(leapDay, 2028), '2028-02-29', 'Feb 29 exists in leap 2028');
}

// ---- nth-weekday: 4th Thursday of November (US Thanksgiving)
{
  const thanksgiving = mk({ type: 'nth-weekday', month: 11, weekday: 4, ordinal: 4 });
  assert.strictEqual(resolveHoliday(thanksgiving, 2026), '2026-11-26', '4th Thu of Nov 2026 = Nov 26');
  assert.strictEqual(resolveHoliday(thanksgiving, 2027), '2027-11-25', '4th Thu of Nov 2027 = Nov 25');
}

// ---- nth-weekday: last Monday of May (US Memorial Day)
{
  const memorial = mk({ type: 'nth-weekday', month: 5, weekday: 1, ordinal: -1 });
  assert.strictEqual(resolveHoliday(memorial, 2026), '2026-05-25', 'last Mon of May 2026 = May 25');
}

// ---- nth-weekday: "Last" differs from "4th" when the month has five of that weekday
{
  // July 2026 has Thursdays on the 2,9,16,23,30 -> 4th = Jul 23, Last = Jul 30.
  const fourthThu = mk({ type: 'nth-weekday', month: 7, weekday: 4, ordinal: 4 });
  const lastThu = mk({ type: 'nth-weekday', month: 7, weekday: 4, ordinal: -1 });
  assert.strictEqual(resolveHoliday(fourthThu, 2026), '2026-07-23', '4th Thu of Jul 2026 = Jul 23');
  assert.strictEqual(resolveHoliday(lastThu, 2026), '2026-07-30', 'last Thu of Jul 2026 = Jul 30');
}

// ---- one-off: only resolves in its own year
{
  const oneOff = mk({ type: 'one-off', date: '2026-07-04' });
  assert.strictEqual(resolveHoliday(oneOff, 2026), '2026-07-04', 'one-off resolves in its year');
  assert.strictEqual(resolveHoliday(oneOff, 2027), null, 'one-off does not resolve in other years');
}

// ---- holidayDatesInRange: expands across the years a window spans
{
  const xmas = mk({ type: 'yearly', month: 12, day: 25 });
  const oneYear = holidayDatesInRange([xmas], '2026-12-01', '2027-01-31').map((o) => o.date);
  assert.deepStrictEqual(oneYear, ['2026-12-25'], 'only the 2026 occurrence falls in this window');

  const twoYears = holidayDatesInRange([xmas], '2026-12-20', '2027-12-31').map((o) => o.date);
  assert.deepStrictEqual(twoYears, ['2026-12-25', '2027-12-25'], 'both yearly occurrences across the span');
}

// ---- holidayDatesInRange: inclusive boundaries and exclusion outside range
{
  const xmas = mk({ type: 'yearly', month: 12, day: 25 });
  assert.strictEqual(
    holidayDatesInRange([xmas], '2026-12-25', '2026-12-25').length, 1,
    'start == end == the date is included (inclusive)'
  );
  assert.strictEqual(
    holidayDatesInRange([xmas], '2026-12-26', '2026-12-31').length, 0,
    'a holiday just before the window is excluded'
  );
}

// ---- holidayDatesInRange: carries the source holiday and handles multiple rules
{
  const a = mk({ type: 'yearly', month: 1, day: 1 });
  const b = mk({ type: 'one-off', date: '2026-07-04' }, false);
  const occ = holidayDatesInRange([a, b], '2026-01-01', '2026-12-31');
  const byDate = Object.fromEntries(occ.map((o) => [o.date, o.holiday]));
  assert.strictEqual(byDate['2026-01-01'].recurrence.type, 'yearly', 'occurrence keeps its source holiday');
  assert.strictEqual(byDate['2026-07-04'].workable, false, 'the non-workable one-off is carried through');
}

// ---- isValidRecurrence: accepts valid shapes, rejects malformed ones
{
  assert.ok(isValidRecurrence({ type: 'yearly', month: 12, day: 25 }), 'valid yearly');
  assert.ok(isValidRecurrence({ type: 'nth-weekday', month: 11, weekday: 4, ordinal: 4 }), 'valid nth-weekday');
  assert.ok(isValidRecurrence({ type: 'nth-weekday', month: 5, weekday: 1, ordinal: -1 }), 'valid last-weekday');
  assert.ok(isValidRecurrence({ type: 'one-off', date: '2026-07-04' }), 'valid one-off');
  assert.ok(!isValidRecurrence(null), 'null rejected');
  assert.ok(!isValidRecurrence({ type: 'yearly', month: 13, day: 1 }), 'month out of range rejected');
  assert.ok(!isValidRecurrence({ type: 'nth-weekday', month: 1, weekday: 7, ordinal: 1 }), 'weekday out of range rejected');
  assert.ok(!isValidRecurrence({ type: 'nth-weekday', month: 1, weekday: 0, ordinal: 5 }), 'ordinal 5 rejected (no explicit 5th)');
  assert.ok(!isValidRecurrence({ type: 'one-off', date: 'nope' }), 'bad date string rejected');
  assert.ok(!isValidRecurrence({ type: 'weekly' }), 'unknown type rejected');
}

console.log('All holidays tests passed.');
