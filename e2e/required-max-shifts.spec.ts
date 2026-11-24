import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// These tests exercise the per-employee Required & Max shifts feature against
// the ISOLATED, seeded database (reset to e2e/seed.json before each test).
//
// App context (no auth): the first roster user is an admin (seed "Admin").
// The top bar has a .user-switch select; tabs are .tab buttons; server errors
// surface in .banner.error. The Admin tab renders a "👥 Roster" card whose
// table has a "Required / block" column and a "Max / block" column of
// .inline-num inputs and an "✨ Generate Schedule" card. The employee
// "My Requests" tab is the Time-Off screen. Building a block is covered by
// schedule-cadence.spec.ts and server/schedules.test.ts.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

// ----- locators -----
const rosterCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
const generateCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Generate Schedule/ }) });

async function gotoAdmin(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
}

// First data row of the roster table. Columns (1-indexed):
// 1 Employee | 2 Role | 3 Vacation/yr | 4 Used | 5 Required/block | 6 Max/block
// 7 Pref standing | 8 delete
function firstRosterRow(page) {
  return rosterCard(page).locator('tbody tr').first();
}
const requiredInput = (row) => row.locator('td:nth-child(5) input');
const maxInput = (row) => row.locator('td:nth-child(6) input');

test('admin sets Required and Max for an employee; values persist after reload', async ({ page }) => {
  await gotoAdmin(page);
  const row = firstRosterRow(page);
  const req = requiredInput(row);
  const max = maxInput(row);
  await expect(req).toBeVisible();
  await expect(max).toBeVisible();

  // Set distinct values and blur each (the inputs save on blur).
  await req.fill('3');
  await req.blur();
  await max.fill('6');
  await max.blur();
  // No server error on save.
  await expect(page.locator('.banner.error')).toHaveCount(0);
  // Saves are queued client-side; wait for them to land before navigating
  // (<body data-saving> is set while any write is pending).
  await expect(page.locator('body[data-saving]')).toHaveCount(0);

  // Reload and confirm the inputs come back populated from persisted data.
  await page.reload();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
  const row2 = firstRosterRow(page);
  await expect(requiredInput(row2)).toHaveValue('3');
  await expect(maxInput(row2)).toHaveValue('6');
});

test('blank Required clears back to no floor (placeholder dash) after reload', async ({ page }) => {
  await gotoAdmin(page);
  const row = firstRosterRow(page);
  const req = requiredInput(row);

  // Set a floor and let it persist (reload rather than clearing immediately:
  // the input's onBlur skips the save when the value "didn't change", and an
  // immediate clear races the state refresh from the first save).
  await req.fill('2');
  await req.blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  // Saves are queued client-side; wait for them to land before navigating.
  await expect(page.locator('body[data-saving]')).toHaveCount(0);
  await page.reload();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
  const req2 = requiredInput(firstRosterRow(page));
  await expect(req2).toHaveValue('2');

  // Clear it: blank should persist as "no floor".
  await req2.fill('');
  await req2.blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(page.locator('body[data-saving]')).toHaveCount(0);

  await page.reload();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
  await expect(requiredInput(firstRosterRow(page))).toHaveValue('');
});

test('Generate-Schedule form has no global min/max shift inputs', async ({ page }) => {
  await gotoAdmin(page);
  const gen = generateCard(page);
  await expect(gen).toBeVisible();
  // The old global generation inputs are gone — they were replaced by the
  // per-employee Required/Max columns in the roster.
  await expect(gen.locator('label', { hasText: 'Minimum shifts per employee' })).toHaveCount(0);
  await expect(gen.locator('label', { hasText: 'Maximum shifts per employee' })).toHaveCount(0);
  await expect(gen.locator('label', { hasText: /Minimum shifts/ })).toHaveCount(0);
  await expect(gen.locator('label', { hasText: /Maximum shifts/ })).toHaveCount(0);
});

test('employee Time-Off screen no longer shows the old "desired shifts" input', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  // The Preferences screen is the "Preferences" tab (visible to every user).
  await page.locator('.tab', { hasText: 'Preferences' }).click();

  // The removed per-user soft target input had id="desired-shifts".
  await expect(page.locator('#desired-shifts')).toHaveCount(0);
  await expect(page.getByText(/shifts I'?d like per schedule block/i)).toHaveCount(0);
});
