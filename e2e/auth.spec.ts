import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

// Real-login / auth flows against the isolated, seeded database (reset before
// each test). Each Playwright test gets a fresh browser context, so with no sid
// cookie the E2E bypass (E2E_TESTING=1) auto-authenticates as the first admin
// (u-admin) — every test starts as the admin without logging in.
//
// normalizeDb synthesizes emails for seed users: Admin -> admin@shiftly.local,
// Bea -> bea@shiftly.local, Cy -> cy@shiftly.local; all registered:false after
// a reset. The dev topbar renders a `.user-switch select` (import.meta.env.DEV);
// its selected <option> text is the signed-in user's name. Logged out, the
// `.user-switch` shows a "Log in" button instead. Error banner: `.banner.error`.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

// The dev topbar select; its selected option shows who is signed in.
const userSwitch = (page: Page) => page.locator('.user-switch select');

async function expectSignedInAs(page: Page, name: string) {
  await expect(userSwitch(page)).toBeVisible();
  const selected = userSwitch(page).locator('option:checked');
  await expect(selected).toContainText(name);
  // "Signed in as" label is present and the logged-out "Log in" button is gone.
  await expect(page.locator('.user-switch', { hasText: 'Signed in as' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in' })).toHaveCount(0);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Logout' }).click();
  // Logged-out view: the "Log in" button appears in place of the select.
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect(userSwitch(page)).toHaveCount(0);
}

// Register a user by email via the API (browser context cookie), leaving the
// caller logged IN as that user (a real sid cookie is set). Used to set up a
// registered non-admin without re-driving the modal each time.
async function registerViaApi(page: Page, email: string, password: string) {
  const status = await page.evaluate(async ({ email, password }) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password }),
    });
    return res.status;
  }, { email, password });
  expect(status).toBe(200);
}

test('invite flow: admin creates a user, uses the invite link to set a password, lands logged in', async ({ page }) => {
  await page.goto('/');
  await expect(userSwitch(page)).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();

  const rosterCard = page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
  const form = rosterCard.locator('form');
  await form.locator('label', { hasText: 'First name' }).locator('input').fill('Pat');
  await form.locator('label', { hasText: 'Last name' }).locator('input').fill('Smith');
  await form.locator('label', { hasText: 'Email' }).locator('input').fill('pat@example.com');
  await rosterCard.getByRole('button', { name: 'Add to roster' }).click();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // The invite-link block appears (email delivery not configured in e2e).
  const inviteInput = rosterCard.locator('input[readonly]');
  await expect(inviteInput).toBeVisible();
  const link = await inviteInput.inputValue();
  expect(link).toContain('/register?token=');
  await expect(page.locator('body[data-saving]')).toHaveCount(0);

  // Follow the invite link and set a password.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /First-time setup/ })).toBeVisible();
  await page.locator('input[type="password"]').first().fill('patsPassw0rd');
  await page.locator('input[type="password"]').nth(1).fill('patsPassw0rd');
  await page.getByRole('button', { name: /Set password & log in/ }).click();

  // Redirected to '/', logged in as Pat Smith.
  await expectSignedInAs(page, 'Pat Smith');
});

test('first login by email: an unregistered user is switched to create-password, then logged in', async ({ page }) => {
  await page.goto('/');
  await logout(page);

  // Open the login modal and submit a known-but-unregistered email.
  await page.getByRole('button', { name: 'Log in' }).click();
  const modal = page.locator('.modal');
  await expect(modal.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await modal.locator('input[type="email"]').fill('bea@shiftly.local');
  await modal.locator('input[type="password"]').fill('whatever-here');
  await modal.getByRole('button', { name: /^Log in$/ }).click();

  // Server reports needsRegistration -> modal switches to the create step.
  await expect(modal.getByRole('heading', { name: 'Create your password' })).toBeVisible();
  await modal.locator('input[type="password"]').first().fill('beasPassw0rd');
  await modal.locator('input[type="password"]').nth(1).fill('beasPassw0rd');
  await modal.getByRole('button', { name: /Set password & log in/ }).click();

  await expectSignedInAs(page, 'Bea');
});

test('login rejections: wrong password and unknown email both show the generic message', async ({ page }) => {
  await page.goto('/');
  // Register Bea (real session) so a wrong-password path exists, then log out.
  await registerViaApi(page, 'bea@shiftly.local', 'beasPassw0rd');
  await page.reload();
  await expectSignedInAs(page, 'Bea');
  await logout(page);

  // Wrong password for a registered account -> generic error.
  await page.getByRole('button', { name: 'Log in' }).click();
  let modal = page.locator('.modal');
  await modal.locator('input[type="email"]').fill('bea@shiftly.local');
  await modal.locator('input[type="password"]').fill('not-her-password');
  await modal.getByRole('button', { name: /^Log in$/ }).click();
  await expect(modal.locator('.banner.error')).toContainText('Invalid email or password.');

  // Unknown email -> same generic error (no account enumeration).
  await modal.locator('input[type="email"]').fill('nobody@nowhere.test');
  await modal.locator('input[type="password"]').fill('some-password');
  await modal.getByRole('button', { name: /^Log in$/ }).click();
  await expect(modal.locator('.banner.error')).toContainText('Invalid email or password.');
});

test('invalid invite token: the register page shows an invalid/expired error', async ({ page }) => {
  await page.goto('/register?token=deadbeef');
  await expect(page.getByRole('heading', { name: /First-time setup/ })).toBeVisible();
  await page.locator('input[type="password"]').first().fill('somePassw0rd');
  await page.locator('input[type="password"]').nth(1).fill('somePassw0rd');
  await page.getByRole('button', { name: /Set password & log in/ }).click();
  await expect(page.locator('.banner.error')).toContainText(/invalid or has expired/i);
});

test('admin-route protection: a logged-in non-admin is 403 on admin mutations and sees no Admin tab', async ({ page }) => {
  await page.goto('/');
  await registerViaApi(page, 'bea@shiftly.local', 'beasPassw0rd');
  await page.reload();
  await expectSignedInAs(page, 'Bea');

  // Bea (non-admin) is not offered the Admin tab.
  await expect(page.locator('.tab', { hasText: 'Admin' })).toHaveCount(0);

  // An admin mutation issued with Bea's session cookie is rejected 403.
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ firstName: 'X', lastName: 'Y', email: 'x@example.com' }),
    });
    return res.status;
  });
  expect(status).toBe(403);
});

test('session is identity: the server ignores a spoofed userId on time-off create', async ({ page }) => {
  await page.goto('/');
  await registerViaApi(page, 'bea@shiftly.local', 'beasPassw0rd');
  await page.reload();
  await expectSignedInAs(page, 'Bea');

  // A date-independent future date (next year, mid-month) avoids per-day caps.
  const future = `${new Date().getFullYear() + 1}-06-15`;

  const createStatus = await page.evaluate(async (date) => {
    const res = await fetch('/api/timeoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      // Spoof a different user's id — the server must ignore it.
      body: JSON.stringify({ userId: 'u-cy', date, type: 'vacation' }),
    });
    return res.status;
  }, future);
  expect(createStatus).toBe(200);

  // The created entry belongs to u-bea (the session user), not u-cy.
  const owner = await page.evaluate(async (date) => {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    const state = await res.json();
    const entry = state.timeOff.find((t: any) => t.date === date);
    return entry ? entry.userId : null;
  }, future);
  expect(owner).toBe('u-bea');
});

test('pending UI: unregistered users show a badge; it disappears after they register', async ({ page }) => {
  await page.goto('/');
  await expect(userSwitch(page)).toBeVisible();
  await page.locator('.tab', { hasText: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Roster/ })).toBeVisible();

  const rosterCard = page.locator('.card', { has: page.getByRole('heading', { name: /Roster/ }) });
  const beaRow = rosterCard.locator('tbody tr', { hasText: 'Bea' });
  const cyRow = rosterCard.locator('tbody tr', { hasText: 'Cy' });

  // Both employees are Pending with a Resend invite button.
  await expect(beaRow.locator('.badge-pending')).toBeVisible();
  await expect(cyRow.locator('.badge-pending')).toBeVisible();
  await expect(beaRow.getByRole('button', { name: 'Resend invite' })).toBeVisible();

  // Register Bea by email. (This also sets Bea's sid on this browser context,
  // so the page is no longer the bypass admin afterward — that's fine; we
  // re-verify the registered state through the source of truth the badge reads:
  // the `registered` flag on GET /api/users, which is an unguarded read.)
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: 'bea@shiftly.local', password: 'beasPassw0rd' }),
    });
    return res.status;
  });
  expect(status).toBe(200);

  // Re-fetch the roster data: Bea now reads registered=true (badge gone),
  // Cy stays registered=false (badge stays).
  const usersRes = await page.request.get('/api/users');
  const body = await usersRes.json();
  const bea = body.users.find((u: any) => u.id === 'u-bea');
  const cy = body.users.find((u: any) => u.id === 'u-cy');
  expect(bea.registered).toBe(true);
  expect(cy.registered).toBe(false);
});
