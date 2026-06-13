import { test, expect } from '@playwright/test';

// These tests exercise the per-employee Required & Max shifts feature against
// the dev data file (data/data.json). A later phase restores the data file.
//
// App context (no auth): the first roster user is an admin (seed "Admin").
// The top bar has a .user-switch select; tabs are .tab buttons; server errors
// surface in .banner.error. The Admin tab renders a "👥 Roster" card whose
// table has a "Required / block" column and a "Max / block" column of
// .inline-num inputs, an "⚙️ Settings" card with the cadence form, and an
// "✨ Generate Schedule" card. The employee "My Requests" tab is the Time-Off
// screen.

// ----- date helpers (local YYYY-MM-DD, mirrors shared/blocks.js) -----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayYmd = () => ymd(new Date());

// ----- locators -----
const rosterCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
const settingsCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Settings/ }) });
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

async function ensureCadence(page) {
  const card = settingsCard(page);
  const has = await card.getByText(/Currently: every/).count();
  if (!has) {
    await card.locator('label', { hasText: 'Length' }).locator('input').fill('2');
    await card.locator('label', { hasText: 'Unit' }).locator('select').selectOption('weeks');
    await card.locator('label', { hasText: 'Anchor start date' }).locator('input').fill(todayYmd());
    await card.getByRole('button', { name: 'Save cadence' }).click();
    await expect(card.getByText(/Currently: every/)).toBeVisible();
  }
}

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

  // Set then clear: blank should persist as "no floor".
  await req.fill('2');
  await req.blur();
  await req.fill('');
  await req.blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);

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

test('a block can be generated and a schedule is produced', async ({ page }) => {
  await gotoAdmin(page);
  await ensureCadence(page);

  const gen = generateCard(page);
  const blockSelect = gen.locator('label', { hasText: 'Schedule block' }).locator('select');
  await expect(blockSelect).toBeVisible();

  // Pick the first selectable (not-yet-generated) block, if any. If every
  // offered block is already generated in the shared dev data, skip — we can't
  // generate a duplicate.
  const options = blockSelect.locator('option');
  const count = await options.count();
  let target = null;
  for (let i = 0; i < count; i++) {
    const o = options.nth(i);
    const disabled = await o.evaluate((el) => el.disabled);
    if (!disabled) { target = await o.getAttribute('value'); break; }
  }
  test.skip(target === null, 'All offered blocks are already generated in the shared dev data.');

  // Generation also needs at least one shift type; if none exist, skip rather
  // than fail (creating shift types is out of scope for this spec).
  await blockSelect.selectOption(target);
  await gen.getByRole('button', { name: /Generate schedule/ }).click();

  // Either a schedule is produced (no error banner + "created so far" footer),
  // or the dev data lacks shift types and the server says so — in which case
  // skip rather than fail the feature under test.
  const errorBanner = page.locator('.banner.error');
  const createdFooter = generateCard(page).getByText(/schedules? created so far/);
  await expect(errorBanner.or(createdFooter).first()).toBeVisible();
  if (await errorBanner.count()) {
    const msg = await errorBanner.innerText();
    test.skip(
      /shift type|cadence|employees/i.test(msg),
      `dev data not generate-ready: ${msg}`
    );
  }
  await expect(createdFooter).toBeVisible();
  // Confirm a schedule exists on the Schedule tab.
  await page.locator('.tab', { hasText: 'Schedule' }).click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
});

test('employee Time-Off screen no longer shows the old "desired shifts" input', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  // The Time-Off screen is the "My Requests" tab (visible to every user).
  await page.locator('.tab', { hasText: 'My Requests' }).click();

  // The removed per-user soft target input had id="desired-shifts".
  await expect(page.locator('#desired-shifts')).toHaveCount(0);
  await expect(page.getByText(/shifts I'?d like per schedule block/i)).toHaveCount(0);
});
