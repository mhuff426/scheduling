import { test, expect, type Locator } from '@playwright/test';

// Exercises the renamed "Preferences" screen (was "My Requests") against the
// dev data file; a later phase restores it. No auth: the top bar
// `.user-switch select` chooses the current user; tabs are `.tab` buttons.
// The Preferences screen has Theme, Colors, Scheduling limits, the requested
// days-off calendar, and a read-only away card. Theme is applied as a
// `data-theme` attribute on <html> and persists per user.

const prefsCard = (page, name: RegExp) =>
  page.locator('.card', { has: page.getByRole('heading', { name }) });

async function gotoPrefs(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(page.getByRole('heading', { name: /Theme/ })).toBeVisible();
}

// Color <input type="color"> can't be .fill()'d; set the value and fire the
// events React's onChange/onBlur listen for (focusout drives onBlur).
async function setColor(input: Locator, value: string) {
  await input.focus();
  await input.evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await input.blur(); // real blur fires React's onBlur, which saves the color
}

test('the tab is renamed to Preferences and shows the preference sections', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await expect(page.locator('.tab', { hasText: 'Preferences' })).toBeVisible();
  await expect(page.locator('.tab', { hasText: 'My Requests' })).toHaveCount(0);

  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(page.getByRole('heading', { name: /Theme/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Colors/ })).toBeVisible();
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

test('colors: the personal color picker persists after reload', async ({ page }) => {
  await gotoPrefs(page);
  const colors = prefsCard(page, /Colors/);
  const own = colors.locator('.color-row', { hasText: 'Your color' }).locator('input[type="color"]');
  await setColor(own, '#ff0000');
  await expect(page.locator('.banner.error')).toHaveCount(0);

  await page.reload();
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  const own2 = prefsCard(page, /Colors/).locator('.color-row', { hasText: 'Your color' }).locator('input[type="color"]');
  await expect(own2).toHaveValue('#ff0000');
});

test('colors: shared-others mode reveals a shared color and persists; per-shift override shows Reset', async ({ page }) => {
  await gotoPrefs(page);
  const colors = prefsCard(page, /Colors/);

  // Turn on "Shared" — a shared-color picker appears.
  await colors.getByRole('button', { name: 'Shared' }).click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  const othersRow = colors.locator('.color-row', { hasText: "Other people" });
  await expect(othersRow.locator('input[type="color"]')).toBeVisible();

  // Persists across reload (Shared stays active).
  await page.reload();
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(prefsCard(page, /Colors/).getByRole('button', { name: 'Shared' })).toHaveClass(/active/);

  // Per-shift override (only when shift types exist): setting one reveals Reset.
  const colors2 = prefsCard(page, /Colors/);
  const shiftRows = colors2.locator('.color-row')
    .filter({ hasNotText: 'Your color' })
    .filter({ hasNotText: 'Other people' });
  const n = await shiftRows.count();
  test.skip(n === 0, 'no shift types in the dev data to override');
  const firstShift = shiftRows.first();
  await setColor(firstShift.locator('input[type="color"]'), '#00ff00');
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(firstShift.getByRole('button', { name: 'Reset' })).toBeVisible();
});
