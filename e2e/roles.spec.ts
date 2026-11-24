import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Exercises the custom-employee-roles feature against the isolated, seeded
// database (reset before each test). No auth: the first roster user
// is an admin. The Admin tab renders a "🏷️ Roles" card, a "👥 Roster" card
// (each employee row has a roles multi-select combobox, class .ms), and a
// "⏰ Shift Types" card. Unique names (Date.now) keep reruns independent.
// The rules themselves (Employee kept, cascade to shift types, duplicates)
// are unit-tested in server/people.test.ts; this keeps one happy path and one
// refusal.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

const rolesCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roles/ }) });
const rosterCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
const firstRosterRow = (page) => rosterCard(page).locator('tbody tr').first();

async function gotoAdmin(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
}

async function addRole(page, name) {
  const card = rolesCard(page);
  await card.locator('label', { hasText: 'New role' }).locator('input').fill(name);
  await card.getByRole('button', { name: 'Add role' }).click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
}

test('system roles are protected; a custom role can be renamed and deleted (cascade)', async ({ page }) => {
  await gotoAdmin(page);
  const card = rolesCard(page);

  // System roles are marked "(system)" and offer no delete control.
  await expect(card.getByText('(system)').first()).toBeVisible();
  await expect(card.locator('tbody tr', { hasText: 'Employee' }).getByRole('button')).toHaveCount(0);

  // Add a custom role — it's appended as the last row of the Roles card (input + ✕).
  const name = `Temp ${Date.now()}`;
  await addRole(page, name);
  const lastRow = () => card.locator('tbody tr').last();
  await expect(lastRow().locator('input')).toHaveValue(name);

  // Assign it to the first employee via the roster combobox (becomes a pill).
  const ms = firstRosterRow(page).locator('.ms');
  await ms.locator('.ms-control').click();
  await ms.locator('.ms-option', { hasText: name }).click();
  await expect(firstRosterRow(page).locator('.ms-pill', { hasText: name })).toBeVisible();

  // Rename it in the Roles card; the assigned pill reflects the new name.
  const renamed = `${name} v2`;
  await lastRow().locator('input').fill(renamed);
  await lastRow().locator('input').blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(firstRosterRow(page).locator('.ms-pill', { hasText: renamed })).toBeVisible();

  // Delete it (accept the confirm) — it cascades off the employee's pills.
  page.on('dialog', (d) => d.accept());
  await lastRow().getByRole('button').click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(firstRosterRow(page).locator('.ms-pill', { hasText: renamed })).toHaveCount(0);
});

test('a role name already in use is refused', async ({ page }) => {
  await gotoAdmin(page);
  const card = rolesCard(page);
  const rows = card.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  // Names compare case-insensitively, so this collides with the Employee system role.
  await card.locator('label', { hasText: 'New role' }).locator('input').fill('employee');
  await card.getByRole('button', { name: 'Add role' }).click();
  await expect(page.locator('.banner.error')).toContainText('A role with that name already exists.');
  await expect(rows).toHaveCount(before);
});
