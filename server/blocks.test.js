// Smoke test: node server/blocks.test.js
import assert from 'assert';
import {
  UNITS, todayYmd, addDaysLocal, addMonthsLocal, isValidCadence,
  blockStart, blockRange, currentBlockIndex, upcomingBlocks,
} from '../shared/blocks.js';

// ---- UNITS shape ----
assert.deepStrictEqual(UNITS, ['days', 'weeks', 'months', 'quarters', 'years'], 'UNITS list');

// ---- todayYmd returns a local YYYY-MM-DD ----
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(todayYmd()), 'todayYmd is YYYY-MM-DD');

// ===== addDaysLocal =====
assert.strictEqual(addDaysLocal('2026-07-06', 14), '2026-07-20', 'add 14 days');
assert.strictEqual(addDaysLocal('2026-07-20', -1), '2026-07-19', 'subtract a day');
assert.strictEqual(addDaysLocal('2026-12-31', 1), '2027-01-01', 'roll over year end');
assert.strictEqual(addDaysLocal('2026-03-01', -1), '2026-02-28', '2026 not a leap year');

// ===== addMonthsLocal (clamps day to month length) =====
assert.strictEqual(addMonthsLocal('2026-07-01', 1), '2026-08-01', 'plain month add');
assert.strictEqual(addMonthsLocal('2026-01-31', 1), '2026-02-28', 'Jan 31 + 1mo clamps to Feb 28 (2026 not leap)');
assert.strictEqual(addMonthsLocal('2026-01-31', 3), '2026-04-30', 'Jan 31 + 3mo clamps to Apr 30');
assert.strictEqual(addMonthsLocal('2026-12-15', 1), '2027-01-15', 'crosses year boundary');
assert.strictEqual(addMonthsLocal('2024-01-31', 1), '2024-02-29', '2024 IS a leap year -> Feb 29');

// ===== days / weeks: fixed length =====
// weeks/2 anchored 2026-07-06 -> block 0 = 2026-07-06..2026-07-19 (14 inclusive days)
{
  const c = { anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 2 };
  const b0 = blockRange(c, 0);
  assert.strictEqual(b0.startDate, '2026-07-06', 'weeks block0 start');
  assert.strictEqual(b0.endDate, '2026-07-19', 'weeks block0 end (inclusive, 14 days)');
  assert.strictEqual(blockStart(c, 1), '2026-07-20', 'weeks block1 starts day after block0 end');
  // confirm exactly 14 inclusive days
  assert.strictEqual(addDaysLocal(b0.startDate, 13), b0.endDate, '14 inclusive days');
}
// days/5 anchored 2026-07-06 -> block0 5 inclusive days
{
  const c = { anchorDate: '2026-07-06', lengthUnit: 'days', lengthValue: 5 };
  const b0 = blockRange(c, 0);
  assert.strictEqual(b0.startDate, '2026-07-06');
  assert.strictEqual(b0.endDate, '2026-07-10', 'days/5 block0 end inclusive');
  assert.strictEqual(blockStart(c, 1), '2026-07-11', 'days/5 block1 start');
}

// ===== months =====
{
  const c = { anchorDate: '2026-07-01', lengthUnit: 'months', lengthValue: 1 };
  const b0 = blockRange(c, 0);
  const b1 = blockRange(c, 1);
  assert.strictEqual(b0.startDate, '2026-07-01', 'months block0 start');
  assert.strictEqual(b0.endDate, '2026-07-31', 'months block0 end');
  assert.strictEqual(b1.startDate, '2026-08-01', 'months block1 start');
  assert.strictEqual(b1.endDate, '2026-08-31', 'months block1 end');
}

// ===== quarters (matches the app's existing 3-month schedule) =====
{
  const c = { anchorDate: '2026-07-01', lengthUnit: 'quarters', lengthValue: 1 };
  const b0 = blockRange(c, 0);
  assert.strictEqual(b0.startDate, '2026-07-01', 'quarters block0 start');
  assert.strictEqual(b0.endDate, '2026-09-30', 'quarters block0 end (Jul-Sep)');
  assert.strictEqual(blockStart(c, 1), '2026-10-01', 'quarters block1 start');
}

// ===== years =====
{
  const c = { anchorDate: '2026-01-01', lengthUnit: 'years', lengthValue: 1 };
  const b0 = blockRange(c, 0);
  assert.strictEqual(b0.startDate, '2026-01-01', 'years block0 start');
  assert.strictEqual(b0.endDate, '2026-12-31', 'years block0 end');
  assert.strictEqual(blockStart(c, 1), '2027-01-01', 'years block1 start');
}

// ===== month-end clamping across a block boundary =====
// anchor 2026-01-31, months/1 -> block0 2026-01-31..2026-02-27, block1 2026-02-28..2026-03-30
{
  const c = { anchorDate: '2026-01-31', lengthUnit: 'months', lengthValue: 1 };
  const b0 = blockRange(c, 0);
  const b1 = blockRange(c, 1);
  // block1 starts at Feb 28 (Jan 31 + 1mo clamped); block0 ends the day before.
  assert.strictEqual(b1.startDate, '2026-02-28', 'block1 start clamped to Feb 28');
  assert.strictEqual(b0.startDate, '2026-01-31', 'block0 start');
  assert.strictEqual(b0.endDate, '2026-02-27', 'block0 end is day before clamped block1 start');
  // block2 starts at Mar 31 (Jan 31 + 2mo); block1 ends Mar 30.
  assert.strictEqual(blockStart(c, 2), '2026-03-31', 'block2 start (Jan 31 + 2mo)');
  assert.strictEqual(b1.endDate, '2026-03-30', 'block1 end is day before block2 start');
}

// ===== no gaps / no overlaps: each block ends exactly the day before the next =====
{
  const cadences = [
    { anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 2 },
    { anchorDate: '2026-07-06', lengthUnit: 'days', lengthValue: 3 },
    { anchorDate: '2026-01-31', lengthUnit: 'months', lengthValue: 1 },
    { anchorDate: '2026-07-01', lengthUnit: 'quarters', lengthValue: 1 },
    { anchorDate: '2026-01-15', lengthUnit: 'years', lengthValue: 1 },
  ];
  for (const c of cadences) {
    for (let i = 0; i < 6; i++) {
      const cur = blockRange(c, i);
      const next = blockRange(c, i + 1);
      assert.strictEqual(
        addDaysLocal(cur.endDate, 1), next.startDate,
        `no gap/overlap for ${JSON.stringify(c)} at block ${i}`
      );
      assert.strictEqual(cur.index, i, 'blockRange returns its index');
    }
  }
}

// ===== currentBlockIndex =====
// future anchor -> 0 (anchor strictly after today)
{
  const c = { anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 2 };
  assert.strictEqual(currentBlockIndex(c, '2026-06-13'), 0, 'future anchor -> block 0');
  // today before the anchor still gives 0 (block 0 endDate >= today)
  assert.strictEqual(currentBlockIndex(c, '2026-07-06'), 0, 'today == anchor -> block 0');
  assert.strictEqual(currentBlockIndex(c, '2026-07-19'), 0, 'today == block0 end -> block 0');
  assert.strictEqual(currentBlockIndex(c, '2026-07-20'), 1, 'today == block1 start -> block 1');
}
// anchor well in the past -> the straddling block (endDate>=today, prev endDate<today)
{
  const c = { anchorDate: '2020-01-06', lengthUnit: 'weeks', lengthValue: 2 };
  const today = '2026-06-13';
  const idx = currentBlockIndex(c, today);
  assert.ok(idx > 0, 'past anchor yields a positive current index');
  const cur = blockRange(c, idx);
  const prev = blockRange(c, idx - 1);
  assert.ok(cur.endDate >= today, 'current block end is today-or-later');
  assert.ok(cur.startDate <= today, 'current block start is today-or-earlier');
  assert.ok(prev.endDate < today, 'previous block already ended before today');
}
// past anchor with months cadence
{
  const c = { anchorDate: '2026-01-01', lengthUnit: 'months', lengthValue: 1 };
  // 2026-06-13 falls in the June block (block index 5: Jun 1..Jun 30)
  assert.strictEqual(currentBlockIndex(c, '2026-06-13'), 5, 'June is block 5 of monthly cadence anchored Jan 1');
}

// ===== upcomingBlocks =====
{
  const c = { anchorDate: '2026-01-01', lengthUnit: 'months', lengthValue: 1 };
  const today = '2026-06-13';
  const blocks = upcomingBlocks(c, today); // default count 5
  assert.strictEqual(blocks.length, 5, 'returns exactly 5 blocks by default');
  const start = currentBlockIndex(c, today);
  assert.strictEqual(blocks[0].index, start, 'first block is the current block index');
  // consecutive indices
  for (let k = 0; k < blocks.length; k++) {
    assert.strictEqual(blocks[k].index, start + k, `block ${k} is consecutive`);
  }
  assert.ok(blocks[0].endDate >= today, 'first block end is today-or-later');
  // each block immediately follows the previous (no gaps)
  for (let k = 1; k < blocks.length; k++) {
    assert.strictEqual(addDaysLocal(blocks[k - 1].endDate, 1), blocks[k].startDate, 'consecutive ranges');
  }
}
// custom count
{
  const c = { anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 1 };
  assert.strictEqual(upcomingBlocks(c, '2026-06-13', 3).length, 3, 'honors a custom count');
}

// ===== isValidCadence =====
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 2 }),
  true, 'a well-formed cadence is valid'
);
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-07-06', lengthUnit: 'fortnights', lengthValue: 2 }),
  false, 'bad unit is invalid'
);
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 0 }),
  false, 'lengthValue 0 is invalid'
);
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: -3 }),
  false, 'negative lengthValue is invalid'
);
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-07-06', lengthUnit: 'weeks', lengthValue: 2.5 }),
  false, 'non-integer lengthValue is invalid'
);
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-7-6', lengthUnit: 'weeks', lengthValue: 2 }),
  false, 'malformed anchorDate is invalid'
);
assert.strictEqual(
  isValidCadence({ anchorDate: '', lengthUnit: 'weeks', lengthValue: 2 }),
  false, 'empty anchorDate is invalid'
);
assert.strictEqual(isValidCadence(null), false, 'null cadence is invalid');
assert.strictEqual(isValidCadence(undefined), false, 'undefined cadence is invalid');
assert.strictEqual(
  isValidCadence({ anchorDate: '2026-07-06', lengthValue: 2 }),
  false, 'missing unit is invalid'
);

console.log('All blocks tests passed.');
