import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// These tests exercise the employee Start date and Away time features against
// the ISOLATED, seeded database (reset to e2e/seed.json before each test).
//
// App context (no auth): the first roster user is an admin (seed "Admin").
// The top bar has a .user-switch select; tabs are .tab buttons; server errors
// surface in .banner.error. The Admin tab renders a "👥 Roster" card whose
// table now has a "Start date" column (a date input, after "Pref standing" and
// before the delete column), and a "🏝️ Away time" card (AwayTimeManager) with
// an Employee <select>, a table of existing ranges (two .inline-num date inputs
// + a ✕ delete button per row), and an add form (From/To + "Add away time").
// The employee "My Requests" tab is the Time-Off screen, which shows a read-only
// "✈️ Scheduled away (set by your manager)" card.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

// ----- locators -----
const rosterCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
const awayCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Away time/ }) });
const myRequestsAwayCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Scheduled away/ }) });

async function gotoAdmin(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
}

// First data row of the roster table. Columns (1-indexed):
// 1 Employee | 2 Role | 3 Vacation/yr | 4 Used | 5 Required/block | 6 Max/block
// 7 Pref standing | 8 Start date | 9 delete
function firstRosterRow(page) {
  return rosterCard(page).locator('tbody tr').first();
}
// The Start date column is the date input in the row (column 8).
const startDateInput = (row) => row.locator('td:nth-child(8) input[type=date]');

test('admin sets a Start date for an employee; it persists after reload', async ({ page }) => {
  await gotoAdmin(page);
  const row = firstRosterRow(page);
  const start = startDateInput(row);
  await expect(start).toBeVisible();

  // Set a start date and blur (the input saves on blur).
  await start.fill('2026-09-15');
  await start.blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Reload and confirm the value persisted from the server.
  await page.reload();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
  await expect(startDateInput(firstRosterRow(page))).toHaveValue('2026-09-15');
});

test('away time CRUD: add a range, edit a date, delete it — no error banner', async ({ page }) => {
  await gotoAdmin(page);
  const card = awayCard(page);
  await expect(card).toBeVisible();

  // Select the first employee in the Away time card's Employee picker.
  const employee = card.locator('label', { hasText: 'Employee' }).locator('select');
  const firstValue = await employee.locator('option').first().getAttribute('value');
  await employee.selectOption(firstValue);

  // Count existing rows so assertions are robust against pre-seeded data.
  const rows = card.locator('tbody tr');
  const before = await rows.count();

  // Add a range via the From/To date inputs + "Add away time".
  await card.locator('label', { hasText: 'From' }).locator('input[type=date]').fill('2026-10-01');
  await card.locator('label', { hasText: 'To' }).locator('input[type=date]').fill('2026-10-05');
  await card.getByRole('button', { name: 'Add away time' }).click();

  // A new row appears, with no server error.
  await expect(rows).toHaveCount(before + 1);
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Edit the new row's "To" date (the 2nd .inline-num date input) and blur.
  const newRow = rows.last();
  const toInput = newRow.locator('.inline-num').nth(1);
  await toInput.fill('2026-10-07');
  await toInput.blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Delete it with the ✕ button; the row goes away.
  await newRow.getByRole('button', { name: '✕' }).click();
  await expect(rows).toHaveCount(before);
  await expect(page.locator('.banner.error')).toHaveCount(0);
});

test('employee sees their away time read-only on My Requests', async ({ page }) => {
  // Add an away range for the second roster user (an employee), then switch to
  // them and confirm the read-only "Scheduled away" card shows it with no
  // controls to edit or delete.
  await gotoAdmin(page);
  const card = awayCard(page);
  const employee = card.locator('label', { hasText: 'Employee' }).locator('select');

  // Prefer a non-admin (the 2nd option) when one exists; else use the first.
  const optionCount = await employee.locator('option').count();
  const idx = optionCount > 1 ? 1 : 0;
  const targetValue = await employee.locator('option').nth(idx).getAttribute('value');
  const targetLabel = await employee.locator('option').nth(idx).innerText();
  await employee.selectOption(targetValue);

  // Add a range for this employee.
  await card.locator('label', { hasText: 'From' }).locator('input[type=date]').fill('2026-11-03');
  await card.locator('label', { hasText: 'To' }).locator('input[type=date]').fill('2026-11-06');
  await card.getByRole('button', { name: 'Add away time' }).click();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Switch the top-bar user to that employee and open My Requests.
  await page.locator('.user-switch select').selectOption({ label: targetLabel });
  await page.locator('.tab', { hasText: 'Preferences' }).click();

  // The read-only "Scheduled away (set by your manager)" card is visible.
  const away = myRequestsAwayCard(page);
  await expect(away).toBeVisible();
  await expect(away.getByText(/set by your manager/i)).toBeVisible();
  // It is read-only: no editable inputs and no delete buttons inside the card.
  await expect(away.locator('input')).toHaveCount(0);
  await expect(away.locator('button')).toHaveCount(0);
});
