import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Exercises dismissing Trades-screen notifications against the ISOLATED,
// seeded data file (see playwright.config.cjs DATA_FILE/E2E_TESTING). The
// Trades screen early-returns an empty state when no schedule exists, so the
// reset payload includes a minimal (empty-assignment) schedule alongside
// notifications for the default user (seed "Admin") and one for Bea, which
// proves dismissal is per-user. Each notification row has a ✕ (.notif-dismiss)
// and the panel header (.notif-head) has a "Clear all" button; dismissed
// notifications are hidden for good (flagged, not deleted, server-side).

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

const schedule = {
  id: 'sch-e2e',
  createdAt: '2026-01-01T00:00:00.000Z',
  startDate: '2026-07-01',
  endDate: '2026-09-30',
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  assignments: [],
  unfilled: [],
  counts: {},
  warnings: [],
};

const notif = (id: string, userId: string, message: string, minutesAgo: number) => ({
  id,
  userId,
  message,
  read: false,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', {
    data: {
      ...SEED,
      schedules: [schedule],
      notifications: [
        notif('n-a1', 'u-admin', 'Older admin notification', 2),
        notif('n-a2', 'u-admin', 'Newer admin notification', 1),
        notif('n-b1', 'u-bea', 'Bea notification', 3),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
});

const notifCard = (page) =>
  page.locator('.card', { has: page.getByRole('heading', { name: /Notifications/ }) });

async function gotoTrades(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.locator('.tab', { hasText: 'Trades' }).click();
  await expect(page.getByRole('heading', { name: /Notifications/ })).toBeVisible();
}

test('dismissing one notification removes it, keeps the rest, and persists', async ({ page }) => {
  await gotoTrades(page);
  const items = notifCard(page).locator('.notif-list li');
  await expect(items).toHaveCount(2);

  // Newest first; dismiss it via its ✕.
  await expect(items.first()).toContainText('Newer admin notification');
  await items.first().locator('.notif-dismiss').click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Older admin notification');
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Still gone after a reload.
  await page.reload();
  await page.locator('.tab', { hasText: 'Trades' }).click();
  await expect(notifCard(page).locator('.notif-list li')).toHaveCount(1);
  await expect(notifCard(page)).toContainText('Older admin notification');
  await expect(notifCard(page)).not.toContainText('Newer admin notification');
});

test('Clear all empties the inbox for the current user only', async ({ page }) => {
  await gotoTrades(page);
  await expect(notifCard(page).locator('.notif-list li')).toHaveCount(2);

  await notifCard(page).getByRole('button', { name: 'Clear all' }).click();
  await expect(notifCard(page)).toContainText('Nothing yet');
  await expect(notifCard(page).locator('.notif-list li')).toHaveCount(0);
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Still empty after a reload…
  await page.reload();
  await page.locator('.tab', { hasText: 'Trades' }).click();
  await expect(notifCard(page)).toContainText('Nothing yet');

  // …and Bea's notification is untouched.
  const select = page.locator('.user-switch select');
  await select.selectOption('u-bea');
  await page.locator('.tab', { hasText: 'Trades' }).click();
  await expect(notifCard(page).locator('.notif-list li')).toHaveCount(1);
  await expect(notifCard(page)).toContainText('Bea notification');
});
