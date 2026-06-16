# Plan — "My Requests" → "Preferences" (user preferences screen)

Status: **awaiting approval** (dev-orchestrator Phase 2 → 3). No app code is written until the plan is approved.

## 1. Context & goal

Today the **"My Requests"** tab (internal id `timeoff`) renders
`client/src/components/TimeOff.tsx`: a vacation/preferred-off calendar, vacation
stat tiles, the "max overnight shifts in a row" input (`#max-nights` →
`maxConsecutiveNights`), and a read-only "Scheduled away" card.

We are renaming this tab to **"Preferences"** and turning it into a
user-preferences screen while **retaining** the requested-days-off calendar and
the away card. New preferences: **theme (dark/light)**, **color settings**
(own color, others shared-vs-distinct, per-shift-type colors), and the existing
**max overnight shifts** control.

## 2. Decisions (locked with the user)

- **Theme is per-user, server-persisted** → it follows the top-bar user switch.
- **"Shared others" color is user-picked** (`othersSharedColor`), shown only when the others-mode toggle is "shared".
- **Per-shift-type color is per-viewer** (stored on `User.shiftColors`), not a global `ShiftType` property — "the color a shift shows as *for them*".
- **Flat fields on `User`** (consistent with existing `color`, `maxConsecutiveNights`), not a nested `prefs` object.
- **Tab fully renamed**: visible label `"Preferences"` AND internal id `timeoff` → `preferences`; component file renamed to `Preferences.tsx`. Visible to all users (as today).
- **Color precedence** (highest first): per-shift-type override → viewer's own shifts use the viewer's own color → other users use the shared color (shared mode) or their own color (distinct mode) → `#9ca3af` fallback (former/unknown user).
- The roster **legend keeps each user's true `color`** (it's an identity key, not a per-viewer display color).

## 3. Data model (`shared/types.ts`)

Add to `interface User` (all optional, defensive `??` reads elsewhere):

```ts
theme?: 'light' | 'dark';                 // default 'light'
othersColorMode?: 'distinct' | 'shared';  // default 'distinct'
othersSharedColor?: string;               // hex; default '#9ca3af'; used only in 'shared' mode
shiftColors?: Record<string, string>;     // shiftTypeId -> hex; per-viewer overrides; default {}
```

`color` (own color) and `maxConsecutiveNights` already exist and are unchanged.

## 4. Migration (`server/db.ts`)

In `loadDb()`, inside the existing `for (const u of loaded.users)` loop, add:

```ts
u.theme ??= 'light';
u.othersColorMode ??= 'distinct';
u.othersSharedColor ??= '#9ca3af';
u.shiftColors ??= {};
```

Additive and backward-compatible; existing `data.json` needs no destructive
rewrite. Optionally add `theme: 'light'` to the seed `u-admin` in `DEFAULT_DATA`
for clarity (not required).

## 5. Server API (`server/index.ts`, `PUT /api/users/:id`)

Extend the field whitelist (mirrors the existing per-field pattern). Note `color`
becomes editable for the first time (previously only set at creation):

```ts
if (req.body.color !== undefined && typeof req.body.color === 'string') user.color = req.body.color;
if (req.body.theme !== undefined) user.theme = req.body.theme === 'dark' ? 'dark' : 'light';
if (req.body.othersColorMode !== undefined) user.othersColorMode = req.body.othersColorMode === 'shared' ? 'shared' : 'distinct';
if (req.body.othersSharedColor !== undefined && typeof req.body.othersSharedColor === 'string') user.othersSharedColor = req.body.othersSharedColor;
if (req.body.shiftColors !== undefined && req.body.shiftColors && typeof req.body.shiftColors === 'object') user.shiftColors = req.body.shiftColors;
```

`client/src/api.ts` needs no change — `updateUser(id, partial)` already forwards
arbitrary fields.

## 6. Theme mechanism

- Apply `data-theme="dark"` (or remove it for light) on `document.documentElement`.
- `client/src/styles.css`: add a `:root[data-theme="dark"] { … }` block that
  overrides the existing custom properties (`--bg`, `--card`, `--ink`, `--muted`,
  `--line`, `--accent-ink`, `--vac`, `--pref`, etc.) with dark values. Because
  nearly all components consume these variables, dark mode largely "just works."
  Audit/tokenize the few hard-coded literals so they adapt: `.tab:hover` `#e9ebf3`,
  `.cal-cell` `#fbfcfe`, `req-vacation`/`req-preferred`, `.banner.error`,
  `.chip-vac/.chip-pref/.chip-full`, `.notif-list li.unread` `#eef2ff`,
  `.legend-btn.active` `#eef2ff`, `.ms-option:hover`/`.ms-open` `#eef2ff`. (First
  pass: override the core variables; literal cleanup is incremental polish.)
- `client/src/App.tsx`: apply on a `useEffect` keyed on the current user's theme:

```ts
useEffect(() => {
  const t = currentUser?.theme ?? 'light';
  document.documentElement.setAttribute('data-theme', t);
}, [currentUser?.theme]);
```

  Runs after `currentUser` resolves (first load), on user switch, and after the
  Preferences toggle saves (the `act()` wrapper refreshes `db` → `currentUser`).

## 7. Color rendering

New helper `client/src/colors.ts`:

```ts
import type { User } from '../../shared/types.js';

export function displayColor(
  viewer: User,
  assignedUser: User | undefined,
  shiftTypeId: string,
): string {
  const override = viewer.shiftColors?.[shiftTypeId];
  if (override) return override;                                  // 1 per-shift-type
  if (assignedUser && assignedUser.id === viewer.id) return assignedUser.color; // 2 self
  if (viewer.othersColorMode === 'shared') return viewer.othersSharedColor ?? '#9ca3af'; // 3 shared
  return assignedUser?.color ?? '#9ca3af';                       // 4 distinct / fallback
}
```

Apply in `client/src/components/ScheduleView.tsx`:
- **Month chip**: replace `style={{ background: u ? u.color : '#9ca3af' }}` with
  `displayColor(currentUser, u, a.shiftTypeId)`.
- **Week block** (`WeekView`, which already receives `currentUser`): replace
  `s.open ? undefined : (u ? u.color : '#9ca3af')` with
  `s.open ? undefined : displayColor(currentUser, u, s.st.id)`.
- **List view** dot: `displayColor(currentUser, listUser, a.shiftTypeId)`.
- **Legend**: leave as each user's `u.color` (roster identity key).
- Top-bar dot (`App.tsx`) and Admin dots (`Admin.tsx`): leave as `u.color`
  (identity/roster contexts, not the viewer's schedule).

## 8. Screen restructure (`TimeOff.tsx` → `Preferences.tsx`)

Rename the file to `client/src/components/Preferences.tsx` and the default export
to `Preferences`. Sections (top to bottom):

1. **Theme** — a `.card` with a light/dark segmented toggle (`.seg` style) →
   `act(() => api.updateUser(currentUser.id, { theme: next }))`.
2. **Colors** — a `.card`:
   - `<input type="color">` for `currentUser.color` → `updateUser({ color })`.
   - Toggle for `othersColorMode` ('distinct'|'shared'); when 'shared', a
     `<input type="color">` for `othersSharedColor`.
   - Per-shift-type list: iterate `db.shiftTypes`; each row = name + `<input
     type="color">` bound to `currentUser.shiftColors?.[st.id]` + a "reset"
     control that deletes the override. Save the merged `shiftColors` object via
     `updateUser({ shiftColors })`.
3. **Scheduling limits** — keep the existing `#max-nights` /
   `maxConsecutiveNights` input (its own card or row).
4. **Requested days off** — keep the existing vacation/preferred calendar,
   the mode toggle, and the vacation stat tiles **verbatim** (preserves
   `vacationSummary`, `mineByDate`, `clickDay`, `vacationPerDay`,
   `db.settings.maxVacationPerDay`).
5. **Scheduled away (read-only)** — keep exactly as-is. **Do not add any
   `input`/`button` inside that card** — `e2e/away-start.spec.ts` asserts zero
   inputs/buttons inside the `/Scheduled away/` card.

`client/src/App.tsx`:
- Tab definition label `'My Requests'` → `'Preferences'`, id `'timeoff'` →
  `'preferences'`.
- Update the render guard `tab === 'timeoff'` → `tab === 'preferences'` and any
  `openTab` references; import/use `Preferences` instead of `TimeOff`.

## 9. Files to touch

| File | Change |
|---|---|
| `shared/types.ts` | add `theme`, `othersColorMode`, `othersSharedColor`, `shiftColors` to `User` |
| `server/db.ts` | `loadDb` migration defaults (optional `DEFAULT_DATA` seed) |
| `server/index.ts` | extend `PUT /api/users/:id` whitelist (incl. `color`) |
| `client/src/colors.ts` | new — `displayColor` helper |
| `client/src/components/Preferences.tsx` | renamed from `TimeOff.tsx`; restructured into sections |
| `client/src/components/ScheduleView.tsx` | use `displayColor` in month/week/list |
| `client/src/App.tsx` | tab rename (label+id), import rename, theme `useEffect` |
| `client/src/styles.css` | `:root[data-theme="dark"]` overrides + new control styles + literal tokenization |
| `e2e/required-max-shifts.spec.ts` | `hasText: 'My Requests'` → `'Preferences'` |
| `e2e/away-start.spec.ts` | `hasText: 'My Requests'` → `'Preferences'` |
| `e2e/preferences.spec.ts` | new — theme + color e2e (Phase 5) |
| `server/*.test.ts` | new unit assertions for migration + `displayColor` (Phase 5) |

## 10. Edge cases / risks

- **Theme on first load & user switch**: effect keys on `currentUser?.theme`;
  resets to `'light'` for users without a theme. Switching users changes the
  theme (intended — per-user).
- **Precedence conflicts**: resolved by the documented order in §2/§7
  (shift-type override is strongest, including for self/shared).
- **Stale `shiftColors` keys** for deleted shift types: harmless — render only
  reads keys for live assignments, and the Preferences list iterates live
  `db.shiftTypes`. Optional pruning on shift-type delete (not required).
- **`color` now mutable** via `PUT /api/users/:id`: cosmetic only, no
  referential concerns.
- **Don't break** the away card e2e (no controls inside it) or vacation
  accounting (calendar logic unchanged).
- **e2e "My Requests" references** must all flip to "Preferences".
- Known pre-existing flake: `schedule-cadence.spec.ts` happy-path fails on a
  non-empty dev DB — unrelated; ignore.

## 11. Verification

**Unit (tsx + `node:assert`):**
- Migration: a `db` missing the new fields → `loadDb()` yields `theme='light'`,
  `othersColorMode='distinct'`, `othersSharedColor` set, `shiftColors={}`.
- `displayColor`: one assertion per precedence branch (override, self, shared,
  distinct, fallback).

**e2e (Playwright):**
- Update the two specs' label references; confirm they still pass.
- `preferences.spec.ts`: toggle dark mode → `document.documentElement` has
  `data-theme="dark"`, persists when re-selecting that user, reverts for a
  light-theme user; set own color + a per-shift color → a Schedule chip's
  `background` reflects it; turn on "shared" → other users' chips collapse to
  the shared color while the viewer's own chips keep the viewer color.

**Pipeline finish:** run `npm run typecheck`, `npm test`, `npm run test:e2e`,
then restore the dev DB from the snapshot
(`C:\Users\mhuff\AppData\Local\Temp\mdo-prefs-snapshot\data.json`, 153,428 B).
