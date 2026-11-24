import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Must-off days are private to their owner and the admins (ADR 0002). An
// employee's reads carry only their own must-off days plus the full days, and
// the Preferences calendar greys full days out from that list.
//
// Seed: u-admin, u-bea, u-cy; per-day limit 2. Under E2E_TESTING a request with
// no cookie is the admin, so the seeding below needs no session.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const BASE = 'http://localhost:5173';

const pad = (n: number) => String(n).padStart(2, '0');
const next = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
const NEXT_MONTH = `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
const FULL_DAY = `${NEXT_MONTH}-14`; // admin + cy: full
const CY_ONLY = `${NEXT_MONTH}-15`; // cy alone: not full
const BEA_DAY = `${NEXT_MONTH}-20`;

test.beforeEach(async ({ request }) => {
  const seed = structuredClone(SEED);
  seed.timeOff = [
    { id: 't-admin', userId: 'u-admin', date: FULL_DAY, type: 'vacation' },
    { id: 't-cy1', userId: 'u-cy', date: FULL_DAY, type: 'vacation' },
    { id: 't-cy2', userId: 'u-cy', date: CY_ONLY, type: 'vacation' },
    { id: 't-bea', userId: 'u-bea', date: BEA_DAY, type: 'vacation' },
  ];
  const res = await request.post('/api/test/reset', { data: seed });
  expect(res.ok()).toBeTruthy();
});

const signedInAs = async (playwright, userId: string) => {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  expect((await ctx.post('/api/dev/impersonate', { data: { userId } })).ok()).toBeTruthy();
  return ctx;
};

test("an employee's preferences read holds only their own must-off days, plus the full days", async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  const res = await bea.get('/api/tabs/preferences');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.timeOff.map((t) => t.userId)).toEqual(['u-bea']);
  expect(body.fullDays).toEqual([FULL_DAY]);
  expect(JSON.stringify(body)).not.toContain('t-cy');
  await bea.dispose();
});

test('an admin still sees every must-off day', async ({ playwright }) => {
  const admin = await signedInAs(playwright, 'u-admin');
  const prefs = await (await admin.get('/api/tabs/preferences')).json();
  expect(prefs.timeOff.map((t) => t.id).sort()).toEqual(['t-admin', 't-bea', 't-cy1', 't-cy2']);
  const tab = await (await admin.get('/api/tabs/admin')).json();
  expect(tab.timeOff.length).toBe(4);
  await admin.dispose();
});

test("the Preferences calendar shows a full day and refuses a must-off request on it", async ({ page }) => {
  await page.goto('/');
  await page.locator('.user-switch select').selectOption('u-bea');
  await page.locator('.tab', { hasText: 'Preferences' }).click();
  await page.locator('.cal-nav button').last().click();

  const cell = (day: number) => page.locator('.cal-cell').filter({ has: page.locator('.cal-day', { hasText: new RegExp(`^${day}$`) }) });
  await expect(cell(14).locator('.chip', { hasText: 'Day full' })).toBeVisible();
  await expect(cell(15).locator('.chip', { hasText: 'Day full' })).toHaveCount(0);
  await expect(cell(20).locator('.chip', { hasText: 'Must off' })).toBeVisible();

  await cell(14).click();
  await expect(page.locator('.banner.error')).toContainText('full');
  await expect(cell(14).locator('.chip', { hasText: 'Must off' })).toHaveCount(0);
});

test('a must-off request on a full day is refused without saying how many people are off', async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  const res = await bea.post('/api/timeoff', { data: { date: FULL_DAY, type: 'vacation' } });
  expect(res.status()).toBe(400);
  const { error } = await res.json();
  expect(error).toContain('full');
  expect(error).not.toMatch(/\d/);
  await bea.dispose();
});
