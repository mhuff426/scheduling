import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Admin reassign under the admin reassign policy (ADR 0001): hard rules and
// must-off days block; the shift maximum and consecutive-night limit are
// eligibility warnings the admin confirms. Confirmation contract: a request
// that triggers warnings is refused with code `eligibility_warnings` carrying
// the warnings, until it is resent with `confirmedWarnings` listing their kinds.
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

const reassign = (request, slot: { date: string; shiftTypeId: string }, confirmedWarnings?: string[]) =>
  request.post('/api/schedules/sch-2099/reassign', {
    data: { ...slot, fromUserId: null, toUserId: 'u-bea', ...(confirmedWarnings ? { confirmedWarnings } : {}) },
  });

const dayShift = { date: '2099-01-12', shiftTypeId: 's-day' };
const nightShift = { date: '2099-01-10', shiftTypeId: 's-night' };
const atMax = 'Bea is already at their maximum of 2 shifts for this schedule.';
const pastNights = 'Bea would exceed their 1-night limit on consecutive overnight shifts.';

test('reassigning past the shift maximum is refused until confirmed', async ({ request }) => {
  await reset(request, { maxShiftsOverride: 2 });
  const refused = await reassign(request, dayShift);
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({
    error: atMax, code: 'eligibility_warnings', warnings: [{ kind: 'shift maximum', message: atMax }],
  });

  const ok = await reassign(request, dayShift, ['shift maximum']);
  expect(ok.ok()).toBeTruthy();
  const saved = await ok.json();
  expect(saved.assignments).toContainEqual(A('u-bea', '2099-01-12', 's-day'));
});

test('reassigning past the consecutive-night limit is refused until confirmed', async ({ request }) => {
  await reset(request, { maxConsecutiveNights: 1 });
  const refused = await reassign(request, nightShift);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).warnings).toEqual([{ kind: 'consecutive-night limit', message: pastNights }]);

  const ok = await reassign(request, nightShift, ['consecutive-night limit']);
  expect(ok.ok()).toBeTruthy();
  expect((await ok.json()).assignments).toContainEqual(A('u-bea', '2099-01-10', 's-night'));
});

test('a reassign past both limits lists both warnings, and a new one is refused again', async ({ request }) => {
  await reset(request, { maxConsecutiveNights: 1, maxShiftsOverride: 2 });
  const refused = await reassign(request, nightShift);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).warnings).toEqual([
    { kind: 'consecutive-night limit', message: pastNights },
    { kind: 'shift maximum', message: atMax },
  ]);

  // Confirming only one of them isn't enough: refused again with the full list.
  const partly = await reassign(request, nightShift, ['shift maximum']);
  expect(partly.status()).toBe(409);
  expect((await partly.json()).warnings).toHaveLength(2);

  const ok = await reassign(request, nightShift, ['consecutive-night limit', 'shift maximum']);
  expect(ok.ok()).toBeTruthy();
});

test('a confirmed reassign is still refused when a hard rule now blocks', async ({ request }) => {
  await reset(request, { maxShiftsOverride: 2 });
  expect((await reassign(request, dayShift)).status()).toBe(409);
  // Meanwhile Bea is put on away time that day.
  const away = await request.post('/api/awaytime', { data: { userId: 'u-bea', start: '2099-01-12', end: '2099-01-12' } });
  expect(away.ok()).toBeTruthy();

  const refused = await reassign(request, dayShift, ['shift maximum']);
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toEqual({ error: 'Bea is on away time that day.' });
});

test('reassigning onto a must-off day the person can afford is refused', async ({ request }) => {
  await reset(request, {}, {
    timeOff: [{ id: 't-1', userId: 'u-bea', date: '2099-01-12', type: 'vacation' }],
  });
  const refused = await reassign(request, dayShift, ['shift maximum', 'consecutive-night limit', 'must-off day']);
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toEqual({ error: 'Bea is on vacation that day.' });
});

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

test('a reassign with no warnings goes through with no dialog', async ({ page, request }) => {
  await reset(request);
  await page.goto('/');
  await expect(page.locator('.cal-grid')).toBeVisible();
  // Let the first load's fetches settle: a re-render remounts the chip's select.
  await page.waitForLoadState('networkidle');
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.accept(); });

  await page.locator('.chip-open', { hasText: 'Day' }).click();
  await page.locator('select.chip-edit').selectOption('u-bea');
  await expect(page.locator('.chip', { hasText: 'Bea · Day' })).toHaveCount(2);
  expect(dialogs).toBe(0);
});
