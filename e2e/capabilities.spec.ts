import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The UI shows controls from the capabilities the server sends it (ADR 0002):
// the current-user endpoint and every user-list poll carry the viewer's
// capabilities. Seed: u-admin (admin), u-bea and u-cy (employees).
//
// Under E2E_TESTING a request with NO sid cookie is auto-authenticated as the
// first admin, so the bare `request` fixture acts as u-admin.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const BASE = 'http://localhost:5173';
const ALL = ['managePeople', 'configureScheduling', 'manageAwayTime', 'buildSchedules', 'manageOthersTimeOff', 'seeEveryonesRecords'];

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

const signedInAs = async (playwright, userId: string) => {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  expect((await ctx.post('/api/dev/impersonate', { data: { userId } })).ok()).toBeTruthy();
  return ctx;
};

const setRoles = async (request, userId: string, roles: string[]) => {
  const res = await request.put(`/api/users/${userId}`, { data: { roles } });
  expect(res.ok(), await res.text()).toBeTruthy();
};

test('an admin is sent every capability by the current-user endpoint and the user list', async ({ playwright }) => {
  const admin = await signedInAs(playwright, 'u-admin');
  const me = await (await admin.get('/api/auth/me')).json();
  expect(me.user.id).toBe('u-admin');
  expect(me.capabilities).toEqual(ALL);
  const list = await (await admin.get('/api/users')).json();
  expect(list.viewer).toEqual({ capabilities: ALL });
  await admin.dispose();
});

test('an employee is sent no capabilities by the current-user endpoint and the user list', async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  const me = await (await bea.get('/api/auth/me')).json();
  expect(me.user.id).toBe('u-bea');
  expect(me.capabilities).toEqual([]);
  const list = await (await bea.get('/api/users')).json();
  expect(list.viewer).toEqual({ capabilities: [] });
  await bea.dispose();
});

test('an employee sees no Admin tab and no schedule-building controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.tab', { hasText: 'Admin' })).toBeVisible();
  await page.locator('.user-switch select').selectOption('u-bea');
  await expect(page.locator('.user-switch select')).toHaveValue('u-bea');
  await expect(page.locator('.tab', { hasText: 'Schedule' })).toBeVisible();
  await expect(page.locator('.tab', { hasText: 'Admin' })).toHaveCount(0);
  await expect(page.locator('.chip.editable')).toHaveCount(0);
});

test('an admin whose role is removed mid-session leaves the Admin tab on the next poll', async ({ page, request }) => {
  // Bea becomes a second admin, so removing her role isn't the last-admin case.
  await setRoles(request, 'u-bea', ['role-admin', 'role-employee']);
  await page.goto('/');
  await page.locator('.user-switch select').selectOption('u-bea');
  await expect(page.locator('.user-switch select')).toHaveValue('u-bea');
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();

  // u-admin removes Bea's admin role elsewhere; her next poll picks it up.
  await setRoles(request, 'u-bea', ['role-employee']);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect(page.locator('.tab', { hasText: 'Admin' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Roster/ })).toHaveCount(0);
  await expect(page.locator('.tab.active', { hasText: 'Schedule' })).toBeVisible();
});
