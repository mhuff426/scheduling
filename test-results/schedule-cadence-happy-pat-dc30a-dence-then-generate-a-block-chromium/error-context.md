# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: schedule-cadence.spec.js >> happy path: set a cadence then generate a block
- Location: e2e\schedule-cadence.spec.js:45:1

# Error details

```
Error: expect(locator).toBeEnabled() failed

Locator:  locator('.card').filter({ has: getByRole('heading', { name: /Settings/ }) }).getByRole('button', { name: 'Save cadence' })
Expected: enabled
Received: disabled
Timeout:  5000ms

Call log:
  - Expect "toBeEnabled" with timeout 5000ms
  - waiting for locator('.card').filter({ has: getByRole('heading', { name: /Settings/ }) }).getByRole('button', { name: 'Save cadence' })
    14 × locator resolved to <button disabled class="btn primary">Save cadence</button>
       - unexpected value "disabled"

```

```yaml
- button "Save cadence" [disabled]
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | // These tests mutate the dev data file (data/data.json) — generating real
  4   | // schedules and persisting a cadence. A later phase restores the data file.
  5   | //
  6   | // App context (no auth): the first roster user is an admin (seed "Admin").
  7   | // The top bar has a .user-switch select; tabs are .tab buttons; server errors
  8   | // surface in .banner.error. The Admin tab renders an "⚙️ Settings" card with
  9   | // the cadence form and an "✨ Generate Schedule" card.
  10  | 
  11  | // ----- date helpers (local YYYY-MM-DD, mirrors shared/blocks.js) -----
  12  | const pad = (n) => String(n).padStart(2, '0');
  13  | const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  14  | const todayYmd = () => ymd(new Date());
  15  | const addDays = (n) => {
  16  |   const d = new Date();
  17  |   d.setDate(d.getDate() + n);
  18  |   return ymd(d);
  19  | };
  20  | 
  21  | // ----- locators -----
  22  | const settingsCard = (page) => page.locator('.card', { has: page.getByRole('heading', { name: /Settings/ }) });
  23  | const generateCard = (page) => page.locator('.card', { has: page.getByRole('heading', { name: /Generate Schedule/ }) });
  24  | 
  25  | async function gotoAdmin(page) {
  26  |   await page.goto('/');
  27  |   // First user is the admin; the Admin tab is only rendered for admins.
  28  |   await expect(page.locator('.user-switch select')).toBeVisible();
  29  |   await page.locator('.tab', { hasText: 'Admin' }).click();
  30  |   await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible();
  31  | }
  32  | 
  33  | // The cadence form inputs, scoped to the Settings card.
  34  | function cadenceInputs(page) {
  35  |   const card = settingsCard(page);
  36  |   return {
  37  |     card,
  38  |     length: card.locator('label', { hasText: 'Length' }).locator('input'),
  39  |     unit: card.locator('label', { hasText: 'Unit' }).locator('select'),
  40  |     anchor: card.locator('label', { hasText: 'Anchor start date' }).locator('input'),
  41  |     save: card.getByRole('button', { name: 'Save cadence' }),
  42  |   };
  43  | }
  44  | 
  45  | test('happy path: set a cadence then generate a block', async ({ page }) => {
  46  |   await gotoAdmin(page);
  47  |   const c = cadenceInputs(page);
  48  | 
  49  |   // Fill the cadence form: every 2 weeks, anchored today (first-time setup
  50  |   // allows today-or-later).
  51  |   await c.length.fill('2');
  52  |   await c.unit.selectOption('weeks');
  53  |   await c.anchor.fill(todayYmd());
> 54  |   await expect(c.save).toBeEnabled();
      |                        ^ Error: expect(locator).toBeEnabled() failed
  55  |   await c.save.click();
  56  | 
  57  |   // Persisted: the "Currently: ..." summary appears.
  58  |   await expect(settingsCard(page).getByText(/Currently: every 2 weeks/)).toBeVisible();
  59  | 
  60  |   // Generate Schedule now shows a populated block picker (5 options).
  61  |   const gen = generateCard(page);
  62  |   const blockSelect = gen.locator('label', { hasText: 'Schedule block' }).locator('select');
  63  |   await expect(blockSelect).toBeVisible();
  64  |   await expect(blockSelect.locator('option')).toHaveCount(5);
  65  | 
  66  |   // Pick the first (current) block. Shift counts are now per-employee settings,
  67  |   // so the generate form no longer takes a minimum.
  68  |   const firstValue = await blockSelect.locator('option').first().getAttribute('value');
  69  |   await blockSelect.selectOption(firstValue);
  70  | 
  71  |   await gen.getByRole('button', { name: /Generate schedule/ }).click();
  72  | 
  73  |   // Success: no error banner, and the "N schedules created" footer appears.
  74  |   await expect(page.locator('.banner.error')).toHaveCount(0);
  75  |   await expect(generateCard(page).getByText(/schedules? created so far/)).toBeVisible();
  76  | });
  77  | 
  78  | test('duplicate block is rejected (already-generated option disabled)', async ({ page }) => {
  79  |   // Relies on the happy-path test having generated the current block. Ensure a
  80  |   // cadence exists; if not, set one and generate the first block.
  81  |   await gotoAdmin(page);
  82  |   const c = cadenceInputs(page);
  83  | 
  84  |   const hasCadence = await settingsCard(page).getByText(/Currently: every/).count();
  85  |   if (!hasCadence) {
  86  |     await c.length.fill('2');
  87  |     await c.unit.selectOption('weeks');
  88  |     await c.anchor.fill(todayYmd());
  89  |     await c.save.click();
  90  |     await expect(settingsCard(page).getByText(/Currently: every/)).toBeVisible();
  91  |   }
  92  | 
  93  |   const gen = generateCard(page);
  94  |   const blockSelect = gen.locator('label', { hasText: 'Schedule block' }).locator('select');
  95  |   await expect(blockSelect).toBeVisible();
  96  | 
  97  |   const firstOption = blockSelect.locator('option').first();
  98  |   const firstValue = await firstOption.getAttribute('value');
  99  | 
  100 |   // If the current block hasn't been generated yet, generate it first so we can
  101 |   // then prove the duplicate is rejected. Read the DOM `disabled` property
  102 |   // directly — Playwright's disabled helpers are unreliable on <option>.
  103 |   const alreadyDisabled = await firstOption.evaluate((o) => o.disabled);
  104 |   if (!alreadyDisabled) {
  105 |     await blockSelect.selectOption(firstValue);
  106 |     await gen.getByRole('button', { name: /Generate schedule/ }).click();
  107 |     await expect(page.locator('.banner.error')).toHaveCount(0);
  108 |   }
  109 | 
  110 |   // Now the first option is marked "already generated" and disabled in the UI.
  111 |   await expect(generateCard(page).locator('label', { hasText: 'Schedule block' })
  112 |     .locator('option').first()).toContainText('already generated');
  113 |   // toBeDisabled() is unreliable on <option> elements; assert the DOM
  114 |   // `disabled` property directly, which is dependable for HTMLOptionElement.
  115 |   await expect(generateCard(page).locator('label', { hasText: 'Schedule block' })
  116 |     .locator('option').first()).toHaveJSProperty('disabled', true);
  117 | });
  118 | 
  119 | test('change-cadence rule: past anchor disabled, future anchor accepted', async ({ page }) => {
  120 |   await gotoAdmin(page);
  121 |   const c = cadenceInputs(page);
  122 | 
  123 |   // Ensure a cadence already exists (so the strictly-future rule applies).
  124 |   const hasCadence = await settingsCard(page).getByText(/Currently: every/).count();
  125 |   if (!hasCadence) {
  126 |     await c.length.fill('2');
  127 |     await c.unit.selectOption('weeks');
  128 |     await c.anchor.fill(todayYmd());
  129 |     await c.save.click();
  130 |     await expect(settingsCard(page).getByText(/Currently: every/)).toBeVisible();
  131 |   }
  132 | 
  133 |   // A past anchor disables Save (changing an existing cadence needs a strictly
  134 |   // future anchor).
  135 |   await c.anchor.fill(addDays(-1));
  136 |   await expect(c.save).toBeDisabled();
  137 | 
  138 |   // Today is also not strictly future for an existing cadence -> still disabled.
  139 |   await c.anchor.fill(todayYmd());
  140 |   await expect(c.save).toBeDisabled();
  141 | 
  142 |   // A future anchor is accepted: Save enables and persists.
  143 |   const future = addDays(30);
  144 |   await c.length.fill('3');
  145 |   await c.unit.selectOption('weeks');
  146 |   await c.anchor.fill(future);
  147 |   await expect(c.save).toBeEnabled();
  148 |   await c.save.click();
  149 |   await expect(page.locator('.banner.error')).toHaveCount(0);
  150 |   await expect(settingsCard(page).getByText(new RegExp(`anchored ${future}`))).toBeVisible();
  151 | });
  152 | 
  153 | // Empty-state coverage. Simulating "no cadence" requires resetting persisted
  154 | // data, which the shared dev data file makes brittle; if a cadence already
```