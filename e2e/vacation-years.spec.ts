import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Per-day vacation years (#37): when a schedule spans New Year, the employee
// chooses which vacation year their elected extra vacation goes to, and may
// split it across both. A schedule inside one year keeps a single field.
//
// Seed: u-admin (bypass-authenticated admin, no required shifts, 15 vacation
// days a year), u-bea, u-cy. Dates in 2099/2100 stay in the future.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

const A = (userId: string, date: string, shiftTypeId = 's-day') => ({ userId, date, shiftTypeId });
const mkSchedule = (id: string, startDate: string, endDate: string, dates: string[]) => ({
  id,
  createdAt: '2099-01-01T00:00:00.000Z',
  startDate,
  endDate,
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  // u-admin has no required shifts, so every shift is an extra day.
  assignments: dates.map((d) => A('u-admin', d)),
  unfilled: [],
  counts: {},
  warnings: [],
});
const spanning = mkSchedule('sch-ny', '2099-12-28', '2100-01-10', ['2099-12-29', '2099-12-30', '2100-01-05']);
const single = mkSchedule('sch-jun', '2099-06-01', '2099-06-14', ['2099-06-02', '2099-06-03']);

const reset = async (request, extra: object) => {
  const res = await request.post('/api/test/reset', { data: { ...SEED, ...extra } });
  expect(res.ok()).toBeTruthy();
};
// The full dump is admin-only: read it through an impersonated admin session.
const state = async (playwright) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });
  try {
    expect((await ctx.post('/api/dev/impersonate', { data: { userId: 'u-admin' } })).ok()).toBeTruthy();
    return await (await ctx.get('/api/state')).json();
  } finally {
    await ctx.dispose();
  }
};

async function openMyShifts(page) {
  await page.goto('/');
  await expect(page.locator('.user-switch select')).toBeVisible();
  await page.getByRole('button', { name: /My Shifts/ }).click();
}

test('a schedule spanning New Year lets the employee split elected vacation across both years', async ({ page, request, playwright }) => {
  await reset(request, { schedules: [spanning] });
  await openMyShifts(page);

  const y2099 = page.getByLabel('As vacation for 2099');
  const y2100 = page.getByLabel('As vacation for 2100');
  await expect(y2099).toBeVisible();
  await expect(y2100).toBeVisible();
  await expect(page.getByText(/spans 2099 and 2100/)).toBeVisible();

  await y2099.fill('1');
  await y2100.fill('2');
  await page.getByRole('button', { name: 'Save extra-day election' }).click();

  await expect.poll(async () => (await state(playwright)).schedules[0].extraElections['u-admin']).toEqual({
    vacationByYear: { 2099: 1, 2100: 2 }, incentive: 0,
  });
  // The admin overview shows the per-year breakdown.
  const overview = page.locator('.card', { hasText: 'Settlement overview' });
  await expect(overview.locator('tbody tr', { hasText: 'Admin' })).toContainText('3 (2099: 1, 2100: 2)');
});

test('all elected vacation can go to the later year', async ({ page, request, playwright }) => {
  await reset(request, { schedules: [spanning] });
  await openMyShifts(page);
  await page.getByLabel('As vacation for 2100').fill('3');
  await page.getByRole('button', { name: 'Save extra-day election' }).click();
  await expect.poll(async () => (await state(playwright)).schedules[0].extraElections['u-admin']).toEqual({
    vacationByYear: { 2100: 3 }, incentive: 0,
  });
});

test('a schedule inside one vacation year shows a single vacation field', async ({ page, request, playwright }) => {
  await reset(request, { schedules: [single] });
  await openMyShifts(page);
  await expect(page.getByLabel('As vacation for 2099')).toHaveCount(0);
  await page.getByLabel('As vacation', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save extra-day election' }).click();
  await expect.poll(async () => (await state(playwright)).schedules[0].extraElections['u-admin']).toEqual({
    vacationByYear: { 2099: 2 }, incentive: 0,
  });
});

test('legacy charge counts and elections migrate without changing a year balance', async ({ request, playwright }) => {
  // The old per-schedule shape: counts, and elections with one vacation number.
  const legacy = {
    ...spanning,
    vacationCharged: { 'u-bea': 2 },
    extraElections: { 'u-admin': { vacation: 2, incentive: 1 } },
  };
  await reset(request, { schedules: [legacy] });
  const s = (await state(playwright)).schedules[0];
  expect(s.vacationCharged).toBeUndefined();
  expect(s.vacationCharges).toEqual([
    { userId: 'u-bea', date: '2099-12-28', cause: 'legacy' },
    { userId: 'u-bea', date: '2099-12-28', cause: 'legacy' },
  ]);
  expect(s.extraElections['u-admin']).toEqual({ vacationByYear: { 2099: 2 }, incentive: 1 });
});

test('the old single `vacation` election field is refused, not silently ignored', async ({ request }) => {
  await reset(request, { schedules: [single] });
  const res = await request.put('/api/schedules/sch-jun/extra-election', { data: { vacation: 1, incentive: 0 } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain('vacationByYear');
});
