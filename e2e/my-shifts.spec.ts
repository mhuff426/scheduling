import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Schedule tab → "📋 My Shifts": below the dated list, a per-shift-type
// breakdown table (Shift type | Shifts | Extra picked up) with a Total row in
// <tfoot>. "Extra picked up" = completed giveaways in this schedule claimed by
// the viewed person, grouped by the offered shift's type.
//
// Seed: u-admin (bypass-authenticated admin), u-bea, u-cy; shift types s-day
// ("Day") and s-eve ("Evening"). A 2099 schedule keeps dates in the future.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

const A = (userId: string, date: string, shiftTypeId: string) => ({ userId, date, shiftTypeId });
const schedule = {
  id: 'sch-2099',
  createdAt: '2099-01-01T00:00:00.000Z',
  startDate: '2099-01-01',
  endDate: '2099-01-14',
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  assignments: [
    A('u-admin', '2099-01-02', 's-day'),
    A('u-admin', '2099-01-03', 's-day'),
    A('u-admin', '2099-01-04', 's-day'),
    A('u-admin', '2099-01-06', 's-eve'),
    // Picked up from Cy via a completed giveaway (trade below).
    A('u-admin', '2099-01-08', 's-eve'),
    A('u-cy', '2099-01-02', 's-eve'),
  ],
  unfilled: [],
  counts: {},
  warnings: [],
};
const giveaway = {
  id: 'tr-1',
  scheduleId: 'sch-2099',
  type: 'giveaway',
  status: 'completed',
  fromUserId: 'u-cy',
  offered: { date: '2099-01-08', shiftTypeId: 's-eve' },
  toUserId: null,
  requested: null,
  responses: [],
  claimedBy: 'u-admin',
  createdAt: '2099-01-01T00:00:00.000Z',
  resolvedAt: '2099-01-01T01:00:00.000Z',
};

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', {
    data: { ...SEED, schedules: [schedule], trades: [giveaway] },
  });
  expect(res.ok()).toBeTruthy();
});

const breakdown = (page) => page.locator('table.shift-breakdown');
const rowFor = (page, name: string) => breakdown(page).locator('tbody tr', { hasText: name });

async function openMyShifts(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.getByRole('button', { name: /My Shifts/ }).click();
}

test('breakdown lists shifts per type with extras picked up and a total row', async ({ page }) => {
  await openMyShifts(page);
  await expect(breakdown(page)).toBeVisible();

  const day = rowFor(page, 'Day').locator('td');
  await expect(day.nth(1)).toHaveText('3');
  await expect(day.nth(2)).toHaveText('0');

  const eve = rowFor(page, 'Evening').locator('td');
  await expect(eve.nth(1)).toHaveText('2');
  await expect(eve.nth(2)).toHaveText('1');

  const total = breakdown(page).locator('tfoot tr th');
  await expect(total.nth(0)).toHaveText('Total');
  await expect(total.nth(1)).toHaveText('5');
  await expect(total.nth(2)).toHaveText('1');

  // The total reconciles with the dated list above it.
  const dated = page.locator('.card', { has: page.getByRole('heading', { name: /Shifts for/ }) })
    .locator('table').first().locator('tbody tr');
  await expect(dated).toHaveCount(5);
});

test('a person with no shifts sees the empty state and no breakdown table', async ({ page }) => {
  await openMyShifts(page);
  const card = page.locator('.card', { has: page.getByRole('heading', { name: /Shifts for/ }) });
  await card.locator('select').selectOption('u-bea');
  await expect(card.getByText('No shifts assigned in this schedule.')).toBeVisible();
  await expect(breakdown(page)).toHaveCount(0);
});

test('types with no shifts and no extras are omitted', async ({ page }) => {
  // Cy only works one Evening shift (and gave one away — giving away is not
  // an extra): one Evening row, no Day row.
  await openMyShifts(page);
  const card = page.locator('.card', { has: page.getByRole('heading', { name: /Shifts for/ }) });
  await card.locator('select').selectOption('u-cy');
  await expect(breakdown(page).locator('tbody tr')).toHaveCount(1);
  const eve = rowFor(page, 'Evening').locator('td');
  await expect(eve.nth(1)).toHaveText('1');
  await expect(eve.nth(2)).toHaveText('0');
});

// Settlement is private to the person and the admins (ADR 0002): an employee
// looking at a coworker's shifts sees the assignments, but no settlement card
// and no extras picked up.
async function openMyShiftsAs(page, userId: string) {
  await page.goto('/');
  await page.locator('.user-switch select').selectOption(userId);
  await expect(page.locator('.user-switch select')).toHaveValue(userId);
  // Reload so the picker starts on the signed-in person, as after a real sign-in.
  await page.reload();
  await expect(page.locator('.user-switch select')).toHaveValue(userId);
  await page.getByRole('button', { name: /My Shifts/ }).click();
}
const settlementHeading = (page) => page.getByRole('heading', { name: /Schedule settlement/ });

test("an employee sees a coworker's shifts but not their settlement or extras picked up", async ({ page }) => {
  await openMyShiftsAs(page, 'u-bea');
  const card = page.locator('.card', { has: page.getByRole('heading', { name: /Shifts for/ }) });
  await card.locator('select').selectOption('u-admin');
  await expect(card.locator('table').first().locator('tbody tr')).toHaveCount(5);
  await expect(breakdown(page)).toBeVisible();
  await expect(breakdown(page).getByText('Extra picked up')).toHaveCount(0);
  await expect(rowFor(page, 'Evening').locator('td')).toHaveCount(2);
  await expect(settlementHeading(page)).toHaveCount(0);
});

test('an employee still sees their own settlement card', async ({ page }) => {
  await openMyShiftsAs(page, 'u-bea');
  await expect(settlementHeading(page)).toBeVisible();
});

test("an admin still sees a coworker's settlement card and extras picked up", async ({ page }) => {
  await openMyShiftsAs(page, 'u-admin');
  const card = page.locator('.card', { has: page.getByRole('heading', { name: /Shifts for/ }) });
  await card.locator('select').selectOption('u-cy');
  await expect(breakdown(page).getByText('Extra picked up')).toBeVisible();
  await expect(settlementHeading(page)).toBeVisible();
});
