import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Exercises the renamed "Preferences" screen (was "My Requests") against the
// isolated, seeded database (reset before each test). No auth: the top bar
// `.user-switch select` chooses the current user; tabs are `.tab` buttons.
// The Preferences screen has Theme, Scheduling limits, the requested days-off
// calendar, and a read-only away card. Theme is applied as a `data-theme`
// attribute on <html> and persists per user.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

const prefsCard = (page, name: RegExp) =>
  page.locator('.card', { has: page.getByRole('heading', { name }) });

async function gotoPrefs(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(page.getByRole('heading', { name: /Theme/ })).toBeVisible();
}

test('the tab is renamed to Preferences and shows the preference sections', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await expect(page.locator('.tab', { hasText: 'Preferences' })).toBeVisible();
  await expect(page.locator('.tab', { hasText: 'My Requests' })).toHaveCount(0);

  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(page.getByRole('heading', { name: /Theme/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Scheduling limits/ })).toBeVisible();
  // the requested days-off calendar is retained
  await expect(page.locator('.cal-grid')).toBeVisible();
});

test('theme: dark toggles data-theme, persists per user, and follows the user switch', async ({ page }) => {
  await gotoPrefs(page);
  const theme = prefsCard(page, /Theme/);
  await theme.getByRole('button', { name: /Dark/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Persists for this user after a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Switching to a different user reverts to that user's theme (default light).
  const select = page.locator('.user-switch select');
  const current = await select.inputValue();
  const values = await select.locator('option').evaluateAll((opts) =>
    (opts as HTMLOptionElement[]).map((o) => o.value));
  const other = values.find((v) => v !== current);
  test.skip(!other, 'needs at least two users to verify per-user theme');
  await select.selectOption(other!);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Put the first user back to light so the dev data isn't left dark.
  await select.selectOption(current);
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await prefsCard(page, /Theme/).getByRole('button', { name: /Light/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
