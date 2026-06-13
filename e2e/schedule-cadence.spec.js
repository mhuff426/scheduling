import { test, expect } from '@playwright/test';

// These tests mutate the dev data file (data/data.json) — generating real
// schedules and persisting a cadence. A later phase restores the data file.
//
// App context (no auth): the first roster user is an admin (seed "Admin").
// The top bar has a .user-switch select; tabs are .tab buttons; server errors
// surface in .banner.error. The Admin tab renders an "⚙️ Settings" card with
// the cadence form and an "✨ Generate Schedule" card.

// ----- date helpers (local YYYY-MM-DD, mirrors shared/blocks.js) -----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayYmd = () => ymd(new Date());
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
};

// ----- locators -----
const settingsCard = (page) => page.locator('.card', { has: page.getByRole('heading', { name: /Settings/ }) });
const generateCard = (page) => page.locator('.card', { has: page.getByRole('heading', { name: /Generate Schedule/ }) });

async function gotoAdmin(page) {
  await page.goto('/');
  // First user is the admin; the Admin tab is only rendered for admins.
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible();
}

// The cadence form inputs, scoped to the Settings card.
function cadenceInputs(page) {
  const card = settingsCard(page);
  return {
    card,
    length: card.locator('label', { hasText: 'Length' }).locator('input'),
    unit: card.locator('label', { hasText: 'Unit' }).locator('select'),
    anchor: card.locator('label', { hasText: 'Anchor start date' }).locator('input'),
    save: card.getByRole('button', { name: 'Save cadence' }),
  };
}

test('happy path: set a cadence then generate a block', async ({ page }) => {
  await gotoAdmin(page);
  const c = cadenceInputs(page);

  // Fill the cadence form: every 2 weeks, anchored today (first-time setup
  // allows today-or-later).
  await c.length.fill('2');
  await c.unit.selectOption('weeks');
  await c.anchor.fill(todayYmd());
  await expect(c.save).toBeEnabled();
  await c.save.click();

  // Persisted: the "Currently: ..." summary appears.
  await expect(settingsCard(page).getByText(/Currently: every 2 weeks/)).toBeVisible();

  // Generate Schedule now shows a populated block picker (5 options).
  const gen = generateCard(page);
  const blockSelect = gen.locator('label', { hasText: 'Schedule block' }).locator('select');
  await expect(blockSelect).toBeVisible();
  await expect(blockSelect.locator('option')).toHaveCount(5);

  // Pick the first (current) block and set a minimum.
  const firstValue = await blockSelect.locator('option').first().getAttribute('value');
  await blockSelect.selectOption(firstValue);
  await gen.locator('label', { hasText: 'Minimum shifts' }).locator('input').fill('1');

  await gen.getByRole('button', { name: /Generate schedule/ }).click();

  // Success: no error banner, and the "N schedules created" footer appears.
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(generateCard(page).getByText(/schedules? created so far/)).toBeVisible();
});

test('duplicate block is rejected (already-generated option disabled)', async ({ page }) => {
  // Relies on the happy-path test having generated the current block. Ensure a
  // cadence exists; if not, set one and generate the first block.
  await gotoAdmin(page);
  const c = cadenceInputs(page);

  const hasCadence = await settingsCard(page).getByText(/Currently: every/).count();
  if (!hasCadence) {
    await c.length.fill('2');
    await c.unit.selectOption('weeks');
    await c.anchor.fill(todayYmd());
    await c.save.click();
    await expect(settingsCard(page).getByText(/Currently: every/)).toBeVisible();
  }

  const gen = generateCard(page);
  const blockSelect = gen.locator('label', { hasText: 'Schedule block' }).locator('select');
  await expect(blockSelect).toBeVisible();

  const firstOption = blockSelect.locator('option').first();
  const firstValue = await firstOption.getAttribute('value');

  // If the current block hasn't been generated yet, generate it first so we can
  // then prove the duplicate is rejected. Read the DOM `disabled` property
  // directly — Playwright's disabled helpers are unreliable on <option>.
  const alreadyDisabled = await firstOption.evaluate((o) => o.disabled);
  if (!alreadyDisabled) {
    await blockSelect.selectOption(firstValue);
    await gen.getByRole('button', { name: /Generate schedule/ }).click();
    await expect(page.locator('.banner.error')).toHaveCount(0);
  }

  // Now the first option is marked "already generated" and disabled in the UI.
  await expect(generateCard(page).locator('label', { hasText: 'Schedule block' })
    .locator('option').first()).toContainText('already generated');
  // toBeDisabled() is unreliable on <option> elements; assert the DOM
  // `disabled` property directly, which is dependable for HTMLOptionElement.
  await expect(generateCard(page).locator('label', { hasText: 'Schedule block' })
    .locator('option').first()).toHaveJSProperty('disabled', true);
});

test('change-cadence rule: past anchor disabled, future anchor accepted', async ({ page }) => {
  await gotoAdmin(page);
  const c = cadenceInputs(page);

  // Ensure a cadence already exists (so the strictly-future rule applies).
  const hasCadence = await settingsCard(page).getByText(/Currently: every/).count();
  if (!hasCadence) {
    await c.length.fill('2');
    await c.unit.selectOption('weeks');
    await c.anchor.fill(todayYmd());
    await c.save.click();
    await expect(settingsCard(page).getByText(/Currently: every/)).toBeVisible();
  }

  // A past anchor disables Save (changing an existing cadence needs a strictly
  // future anchor).
  await c.anchor.fill(addDays(-1));
  await expect(c.save).toBeDisabled();

  // Today is also not strictly future for an existing cadence -> still disabled.
  await c.anchor.fill(todayYmd());
  await expect(c.save).toBeDisabled();

  // A future anchor is accepted: Save enables and persists.
  const future = addDays(30);
  await c.length.fill('3');
  await c.unit.selectOption('weeks');
  await c.anchor.fill(future);
  await expect(c.save).toBeEnabled();
  await c.save.click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(settingsCard(page).getByText(new RegExp(`anchored ${future}`))).toBeVisible();
});

// Empty-state coverage. Simulating "no cadence" requires resetting persisted
// data, which the shared dev data file makes brittle; if a cadence already
// exists this is skipped (and noted).
test('empty state when no cadence is configured', async ({ page }) => {
  await gotoAdmin(page);
  const hasCadence = await settingsCard(page).getByText(/Currently: every/).count();
  test.skip(hasCadence > 0, 'A cadence is already configured in the shared dev data; cannot simulate the empty state without resetting data.');

  await expect(
    generateCard(page).getByText('Set a schedule cadence in Settings first.')
  ).toBeVisible();
});
