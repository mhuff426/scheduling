import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// These tests exercise the Holidays feature against an ISOLATED, seeded data
// file (see playwright.config.cjs DATA_FILE/E2E_TESTING). The beforeEach below
// resets the DB to e2e/seed.json before every test so each case starts from the
// same known state. Tests that need pre-seeded holidays/schedules POST a
// modified copy of SEED (spread + override `holidays`/`schedules`).
//
// App context (no auth): the first roster user is an admin (seed "Admin"). The
// top bar has a .user-switch select; tabs are .tab buttons; server errors
// surface in .banner.error. The Admin tab renders a "🎉 Holidays" card
// (HolidaysManager) — a table (Name input, a "Repeats" recurrence editor with a
// human-readable summary, a Workable checkbox, a ✕ delete per row) plus an add
// form (Name, the same recurrence editor, Workable, "Add holiday" button,
// disabled until a name is set). Holidays carry a recurrence rule: `yearly`
// (month/day), `nth-weekday` (ordinal 1-4 or Last), or `one-off` (a date).
// The Settings card has a "Holidays required per year" number input. Both
// calendars render a `.chip-holiday` showing "🎉 {name}"; on the preferences
// calendar a non-workable one also shows "(closed)".

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const oneOff = (id: string, name: string, date: string, workable: boolean) =>
  ({ id, name, workable, recurrence: { type: 'one-off', date } });

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

// ----- locators -----
const holidaysCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Holidays/ }) });
const settingsCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Settings/ }) });

async function gotoAdmin(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Holidays/ })).toBeVisible();
}

async function gotoPrefs(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(page.getByRole('heading', { name: /Theme/ })).toBeVisible();
}

// The add form is the .form-grid that holds the "Add holiday" button (each row
// and the nested recurrence editor are also .form-grids, so scope by the button).
function addForm(page) {
  const card = holidaysCard(page);
  const add = card.getByRole('button', { name: 'Add holiday' });
  const grid = card.locator('.holiday-add');
  return {
    card,
    grid,
    add,
    // Anchor sub-field labels to the start: the "Repeats" <select> option text
    // ("…same date", "…weekday rule") would otherwise match 'Date'/'Weekday'.
    name: grid.locator('label', { hasText: /^Name/ }).locator('input[type=text]'),
    repeats: grid.locator('label', { hasText: /^Repeats/ }).locator('select'),
    date: grid.locator('label', { hasText: /^Date/ }).locator('input[type=date]'),
    which: grid.locator('label', { hasText: /^Which/ }).locator('select'),
    weekday: grid.locator('label', { hasText: /^Weekday/ }).locator('select'),
    month: grid.locator('label', { hasText: /^Month/ }).locator('select'),
    workable: grid.locator('label', { hasText: 'Workable' }).locator('input[type=checkbox]'),
  };
}

test('holiday CRUD in Admin: add (yearly), toggle workable, delete — no error banner', async ({ page }) => {
  await gotoAdmin(page);
  const f = addForm(page);
  const rows = f.card.locator('tbody tr');
  const before = await rows.count(); // seed has none, but stay robust

  // Add button is disabled until a name is set.
  await expect(f.add).toBeDisabled();
  await f.name.fill('Christmas');
  // Default recurrence is yearly; set its date to Dec 25.
  await expect(f.repeats).toHaveValue('yearly');
  await f.date.fill('2026-12-25');
  await f.workable.check();
  await expect(f.add).toBeEnabled();
  await f.add.click();

  // A new row appears with no server error, and shows the yearly summary.
  await expect(rows).toHaveCount(before + 1);
  await expect(page.locator('.banner.error')).toHaveCount(0);
  const newRow = rows.last();
  await expect(newRow.locator('input[type=text]').first()).toHaveValue('Christmas');
  await expect(newRow).toContainText('Every Dec 25');

  // Toggle workable off. The row checkbox is controlled via an async server
  // round-trip, so click and assert the post-refresh state (uncheck() expects a
  // synchronous flip, which controlled inputs don't give).
  const rowWorkable = newRow.locator('input[type=checkbox]');
  await expect(rowWorkable).toBeChecked();
  await rowWorkable.click();
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(rowWorkable).not.toBeChecked();

  // Delete via ✕; the row count returns to the original.
  await newRow.getByRole('button', { name: '✕' }).click();
  await expect(rows).toHaveCount(before);
  await expect(page.locator('.banner.error')).toHaveCount(0);
});

test('an Nth-weekday recurrence resolves to the right day on the calendar', async ({ page }) => {
  await gotoAdmin(page);
  const f = addForm(page);

  // Add "Thanksgiving" = 4th Thursday of November.
  await f.name.fill('Thanksgiving');
  await f.repeats.selectOption('nth-weekday');
  await f.which.selectOption({ label: '4th' });
  await f.weekday.selectOption({ label: 'Thu' });
  await f.month.selectOption({ label: 'November' });
  await f.add.click();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // The Admin table shows the human-readable summary.
  await expect(f.card.locator('tbody tr').last()).toContainText('4th Thu of Nov');

  // On the schedule calendar (no auth, Schedule is default), navigate to
  // November 2026 and confirm the badge lands on Nov 26 (4th Thursday, 2026).
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await expect(page.getByRole('heading', { name: /Theme/ })).toBeVisible();
  const next = page.locator('.cal-nav button', { hasText: '›' });
  // Preferences opens on the current month (June 2026); step to November.
  for (let i = 0; i < 5; i++) await next.click();
  await expect(page.locator('.cal-nav h2')).toContainText('November 2026');
  const badge = page.locator('.chip-holiday', { hasText: 'Thanksgiving' });
  await expect(badge).toBeVisible();
  const cell = page.locator('.cal-cell', { has: badge });
  await expect(cell.locator('.cal-day')).toHaveText('26');
});

test('org-wide "Holidays required per year" persists across reload', async ({ page }) => {
  await gotoAdmin(page);
  const req = settingsCard(page)
    .locator('label', { hasText: 'Holidays required per year' })
    .locator('input[type=number]');
  await expect(req).toBeVisible();

  await req.fill('2');
  await req.blur();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  await page.reload();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible();
  const reqAfter = settingsCard(page)
    .locator('label', { hasText: 'Holidays required per year' })
    .locator('input[type=number]');
  await expect(reqAfter).toHaveValue('2');
});

test('preferences calendar shows the holiday badge; non-workable shows (closed)', async ({ request, page }) => {
  // Seed a non-workable holiday in the current month (June 2026).
  await request.post('/api/test/reset', {
    data: { ...SEED, holidays: [oneOff('h-closed', 'Founders Day', '2026-06-22', false)] },
  });

  await gotoPrefs(page);
  const badge = page.locator('.chip-holiday', { hasText: 'Founders Day' });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('(closed)');
});

test('schedule calendar shows the holiday badge on the holiday day', async ({ request, page }) => {
  // Seed a workable holiday plus a schedule spanning it. (Direct schedule
  // seeding over Admin→Generate: the month view opens on the schedule's start
  // month, making the badge deterministically visible.)
  await request.post('/api/test/reset', {
    data: {
      ...SEED,
      holidays: [oneOff('h-open', 'Labor Day', '2026-06-10', true)],
      schedules: [{
        id: 's-1', createdAt: '2026-06-01T00:00:00Z',
        startDate: '2026-06-08', endDate: '2026-06-14',
        userIds: ['u-admin', 'u-bea', 'u-cy'],
        assignments: [{ date: '2026-06-10', shiftTypeId: 's-day', userId: 'u-admin' }],
        unfilled: [], counts: { 'u-admin': 1, 'u-bea': 0, 'u-cy': 0 }, warnings: [],
      }],
    },
  });

  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.getByRole('button', { name: /Month/ }).click();

  const badge = page.locator('.chip-holiday', { hasText: 'Labor Day' });
  await expect(badge).toBeVisible();
});

test('a workable holiday can still be marked must-have-off on the preferences calendar', async ({ request, page }) => {
  // Seed a workable holiday on a FUTURE day this month so it is clickable.
  await request.post('/api/test/reset', {
    data: { ...SEED, holidays: [oneOff('h-open', 'Bank Holiday', '2026-06-29', true)] },
  });

  await gotoPrefs(page);
  const badge = page.locator('.chip-holiday', { hasText: 'Bank Holiday' });
  await expect(badge).toBeVisible();
  await expect(badge).not.toContainText('(closed)');

  // Click the holiday day cell to add a must-have-off request.
  const cell = page.locator('.cal-cell.clickable', { has: badge });
  await cell.click();
  await expect(cell.locator('.chip-vac')).toBeVisible();
  await expect(page.locator('.banner.error')).toHaveCount(0);
});
