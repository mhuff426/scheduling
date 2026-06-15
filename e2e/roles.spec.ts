import { test, expect } from '@playwright/test';

// Exercises the custom-employee-roles feature against the dev data file
// (data/data.json); a later phase restores it. No auth: the first roster user
// is an admin. The Admin tab renders a "🏷️ Roles" card, a "👥 Roster" card
// (each employee row has a roles checkbox group), and a "⏰ Shift Types" card
// whose create form has a "Roles that can fill this shift" checkbox group.
// Unique names (Date.now) keep reruns independent on the shared dev data.

const rolesCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roles/ }) });
const rosterCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
const shiftTypesCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Shift Types/ }) });
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

test('admin creates a role, assigns it to an employee, and it persists', async ({ page }) => {
  await gotoAdmin(page);
  const name = `QA Role ${Date.now()}`;
  await addRole(page, name);

  // The new role appears as a checkbox in the roster row; check it.
  const box = firstRosterRow(page).locator('label', { hasText: name }).locator('input[type="checkbox"]');
  await expect(box).toBeVisible();
  // Controlled checkbox: click, then wait for the act()-refresh to reflect it.
  await box.click();
  await expect(box).toBeChecked();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Persisted across a reload.
  await page.reload();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();
  const box2 = firstRosterRow(page).locator('label', { hasText: name }).locator('input[type="checkbox"]');
  await expect(box2).toBeChecked();
});

test('system roles are protected; a custom role can be renamed and deleted (cascade)', async ({ page }) => {
  await gotoAdmin(page);
  const card = rolesCard(page);

  // System roles are marked "(system)" and offer no delete control.
  await expect(card.getByText('(system)').first()).toBeVisible();
  await expect(card.locator('tbody tr', { hasText: 'Employee' }).getByRole('button')).toHaveCount(0);

  // Add a custom role — it's appended as the last row (input + ✕).
  const name = `Temp ${Date.now()}`;
  await addRole(page, name);
  const lastRow = () => card.locator('tbody tr').last();
  await expect(lastRow().locator('input')).toHaveValue(name);

  // Rename it.
  const renamed = `${name} v2`;
  await lastRow().locator('input').fill(renamed);
  await lastRow().locator('input').blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(firstRosterRow(page).locator('label', { hasText: renamed })).toBeVisible();

  // Delete it (accept the confirm) — it disappears from the roster checkboxes.
  page.on('dialog', (d) => d.accept());
  await lastRow().getByRole('button').click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(firstRosterRow(page).locator('label', { hasText: renamed })).toHaveCount(0);
});

test('a shift type can be restricted to a role and shows it in the table', async ({ page }) => {
  await gotoAdmin(page);
  const role = `Cook ${Date.now()}`;
  await addRole(page, role);

  const card = shiftTypesCard(page);
  const form = card.locator('form');
  const shiftName = `Grill ${Date.now()}`;
  await form.locator('label', { hasText: 'Name' }).locator('input').fill(shiftName);
  // Tag the shift with the new role (scope to the inner role-tag label so the
  // outer "Roles that can fill this shift" wrapper label isn't also matched).
  await form.locator('label.role-tag', { hasText: role }).locator('input[type="checkbox"]').check();
  await card.getByRole('button', { name: 'Add shift type' }).click();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // The new shift row lists the role in its Roles cell (not "Anyone").
  const shiftRow = card.locator('tbody tr', { hasText: shiftName });
  await expect(shiftRow).toContainText(role);
});
