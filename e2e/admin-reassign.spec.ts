import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Admin reassign under the admin reassign policy (ADR 0001): hard rules and
// affordable must-off days block; an unaffordable must-off day, the shift
// maximum and the consecutive-night limit are eligibility warnings the admin
// confirms. Confirmation contract: a request that triggers warnings is refused
// with code `eligibility_warnings` carrying the warnings, until it is resent
// with `confirmedWarnings` listing their messages.
//
// The rules themselves are unit-tested in server/schedules.test.ts; this spec
// keeps one confirmed reassign and one declined one, through the UI.
//
// Runs against the isolated, seeded e2e database (reset before each test). The
// default `request` fixture is auto-authenticated as the admin (u-admin).

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

const night = { id: 's-night', name: 'Night', startTime: '22:00', endTime: '06:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1, allowedRoles: [] };
const A = (userId: string, date: string, shiftTypeId: string) => ({ userId, date, shiftTypeId });
const schedule = {
  id: 'sch-2099',
  createdAt: '2099-01-01T00:00:00.000Z',
  startDate: '2099-01-01',
  endDate: '2099-01-31',
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  assignments: [A('u-bea', '2099-01-05', 's-day'), A('u-bea', '2099-01-09', 's-night')],
  unfilled: [{ date: '2099-01-12', shiftTypeId: 's-day' }, { date: '2099-01-10', shiftTypeId: 's-night' }],
  counts: {},
  warnings: [],
};

async function reset(request, bea: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const users = SEED.users.map((u) => (u.id === 'u-bea' ? { ...u, ...bea } : u));
  const res = await request.post('/api/test/reset', {
    data: { ...SEED, users, shiftTypes: [...SEED.shiftTypes, night], schedules: [schedule], ...extra },
  });
  expect(res.ok()).toBeTruthy();
}

const atMax = 'Bea is already at their maximum of 2 shifts for this schedule.';

test('admin reassigns past the shift maximum through the confirm dialog', async ({ page, request }) => {
  await reset(request, { maxShiftsOverride: 2 });
  await page.goto('/');
  await expect(page.locator('.cal-grid')).toBeVisible();
  // Let the first load's fetches settle: a re-render remounts the chip's select.
  await page.waitForLoadState('networkidle');

  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  await page.locator('.chip-open', { hasText: 'Day' }).click();
  await page.locator('select.chip-edit').selectOption('u-bea');

  await expect(page.locator('.chip', { hasText: 'Bea · Day' })).toHaveCount(2);
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain(atMax);
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Saved: still there after a reload.
  await page.reload();
  await expect(page.locator('.chip', { hasText: 'Bea · Day' })).toHaveCount(2);
  await expect(page.locator('.chip-open', { hasText: 'Day' })).toHaveCount(0);
});

test('declining the confirm dialog leaves the schedule unchanged, with no error', async ({ page, request }) => {
  await reset(request, { maxShiftsOverride: 2 });
  await page.goto('/');
  await expect(page.locator('.cal-grid')).toBeVisible();
  // Let the first load's fetches settle: a re-render remounts the chip's select.
  await page.waitForLoadState('networkidle');

  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  await page.locator('.chip-open', { hasText: 'Day' }).click();
  await page.locator('select.chip-edit').selectOption('u-bea');

  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain(atMax);
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(page.locator('.chip-open', { hasText: 'Day' })).toHaveCount(1);
  await expect(page.locator('.chip', { hasText: 'Bea · Day' })).toHaveCount(1);

  // Nothing saved.
  await page.reload();
  await expect(page.locator('.chip-open', { hasText: 'Day' })).toHaveCount(1);
});
