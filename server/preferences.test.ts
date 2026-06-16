// Smoke test: tsx server/preferences.test.ts
//
// Covers client/src/colors.ts `displayColor`. The module is pure (its only
// import is a type, erased at runtime), so tsx resolves and runs it from here.
import assert from 'assert';
import { displayColor } from '../client/src/colors.js';
import type { User } from '../shared/types.js';

// ----- fixtures -----
// A minimal User factory: only the fields displayColor reads matter, but we
// keep the shape valid so the cast is honest.
const mkUser = (id: string, color: string, extra: Partial<User> = {}): User => ({
  id, name: id.toUpperCase(), roles: ['role-employee'], vacationDays: 0, color, ...extra,
});

// ---- (1) per-shift-type override wins — even for self, even in shared mode
{
  const viewer = mkUser('v', '#111111', {
    othersColorMode: 'shared',
    othersSharedColor: '#555555',
    shiftColors: { s1: '#abcabc' },
  });
  const self = viewer; // assignedUser is the viewer themselves
  const other = mkUser('o', '#222222');
  assert.strictEqual(
    displayColor(viewer, self, 's1'), '#abcabc',
    'override beats the self rule for the overridden shift type',
  );
  assert.strictEqual(
    displayColor(viewer, other, 's1'), '#abcabc',
    'override beats the shared rule for the overridden shift type',
  );
  assert.strictEqual(
    displayColor(viewer, undefined, 's1'), '#abcabc',
    'override applies even when there is no assigned user',
  );
}

// ---- (2) self with no override -> the viewer's own color
{
  const viewer = mkUser('v', '#111111', { othersColorMode: 'distinct', shiftColors: {} });
  assert.strictEqual(
    displayColor(viewer, viewer, 's1'), '#111111',
    "the viewer's own shifts use the viewer's own color",
  );
}

// ---- (3) other user, distinct mode -> that user's own color
{
  const viewer = mkUser('v', '#111111', { othersColorMode: 'distinct' });
  const other = mkUser('o', '#222222');
  assert.strictEqual(
    displayColor(viewer, other, 's1'), '#222222',
    "in distinct mode another user's shifts show that user's color",
  );
}

// ---- (4) other user, shared mode -> the shared color
{
  const viewer = mkUser('v', '#111111', { othersColorMode: 'shared', othersSharedColor: '#333333' });
  const other = mkUser('o', '#222222');
  assert.strictEqual(
    displayColor(viewer, other, 's1'), '#333333',
    "in shared mode another user's shifts collapse to the shared color",
  );
}

// ---- (5) shared mode but othersSharedColor undefined -> the neutral fallback
{
  const viewer = mkUser('v', '#111111', { othersColorMode: 'shared' }); // no othersSharedColor
  const other = mkUser('o', '#222222');
  assert.strictEqual(
    displayColor(viewer, other, 's1'), '#9ca3af',
    'shared mode with no shared color picked falls back to #9ca3af',
  );
}

// ---- (6) assignedUser undefined (open/former), no override, distinct -> fallback
{
  const viewer = mkUser('v', '#111111', { othersColorMode: 'distinct' });
  assert.strictEqual(
    displayColor(viewer, undefined, 's1'), '#9ca3af',
    'a former/open assignment with no override and distinct mode is the neutral fallback',
  );
}

// ---- (7) a shiftTypeId NOT in shiftColors falls through to the normal rules
{
  const viewer = mkUser('v', '#111111', {
    othersColorMode: 'shared',
    othersSharedColor: '#444444',
    shiftColors: { s1: '#abcabc' }, // only s1 is overridden
  });
  const other = mkUser('o', '#222222');
  // self with a non-overridden type -> own color (not the s1 override)
  assert.strictEqual(
    displayColor(viewer, viewer, 's2'), '#111111',
    'a non-overridden type still uses the self rule for the viewer',
  );
  // other with a non-overridden type in shared mode -> shared color
  assert.strictEqual(
    displayColor(viewer, other, 's2'), '#444444',
    'a non-overridden type still uses the shared rule for others',
  );
}

console.log('All preferences tests passed.');
