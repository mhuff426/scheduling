import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The Trades screen's confirm dialog (confirmation contract, ADR 0001): an
// offerer who'd land on their own must-off day is asked before the direct
// swap is sent. Declining means nothing happened: no error, nothing posted,
// and the form keeps what was picked. Confirming sends it and clears the form.
//
// Seed: u-admin (the default, logged-in user), u-bea, u-cy; shift type s-day.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

const A = (userId: string, date: string, shiftTypeId: string) => ({ userId, date, shiftTypeId });
const schedule = {
  id: 'sch-2099',
  createdAt: '2099-01-01T00:00:00.000Z',
  startDate: '2099-01-01',
  endDate: '2099-01-31',
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  assignments: [A('u-admin', '2099-01-05', 's-day'), A('u-bea', '2099-01-12', 's-day')],
  unfilled: [],
  counts: {},
  warnings: [],
};

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', {
    data: {
      ...SEED,
      schedules: [schedule],
      // Admin would take Bea's 12th, one of Admin's must-off days.
      timeOff: [{ id: 't-1', userId: 'u-admin', date: '2099-01-12', type: 'vacation' }],
    },
  });
  expect(res.ok()).toBeTruthy();
});

const mustOff = "2099-01-12 is one of Admin's must-off days.";

test('declining the must-off warning sends nothing and keeps the form; confirming sends it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tab', { hasText: 'Trades' }).click();
  const card = page.locator('.card', { has: page.getByRole('heading', { name: /Start a trade/ }) });
  await expect(card).toBeVisible();
  await page.waitForLoadState('networkidle');

  const [myShift, partner, theirShift] = [card.locator('select').nth(0), card.locator('select').nth(1), card.locator('select').nth(2)];
  await myShift.selectOption({ index: 1 });
  await card.getByRole('button', { name: /Direct swap/ }).click();
  await partner.selectOption({ label: 'Bea' });
  await theirShift.selectOption({ index: 1 });
  await expect(theirShift.locator('option:checked')).toContainText(mustOff);

  const dialogs: string[] = [];
  let answer = false;
  page.on('dialog', (d) => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });

  await card.getByRole('button', { name: 'Send proposal' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain(mustOff);
  await expect(page.locator('.banner.error')).toHaveCount(0);
  // The form still holds the picks, so the person can send it after all.
  await expect(myShift).not.toHaveValue('');
  await expect(partner).toHaveValue('u-bea');
  await expect(theirShift).not.toHaveValue('');
  await expect(page.getByText(/Swap proposal to/)).toHaveCount(0);

  answer = true;
  await card.getByRole('button', { name: 'Send proposal' }).click();
  await expect(page.getByText(/Swap proposal to/)).toHaveCount(1);
  expect(dialogs).toHaveLength(2);
  await expect(myShift).toHaveValue('');
  await expect(page.locator('.banner.error')).toHaveCount(0);
});
