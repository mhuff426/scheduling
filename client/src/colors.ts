import type { User } from '../../shared/types.js';

// The color a shift assignment should display as for a given viewer.
// Precedence: per-shift-type override > viewer's own shifts > others (shared or
// distinct) > neutral fallback.
export function displayColor(
  viewer: User,
  assignedUser: User | undefined,
  shiftTypeId: string,
): string {
  const override = viewer.shiftColors?.[shiftTypeId];
  if (override) return override;
  if (assignedUser && assignedUser.id === viewer.id) return assignedUser.color;
  if (viewer.othersColorMode === 'shared') return viewer.othersSharedColor ?? '#9ca3af';
  return assignedUser?.color ?? '#9ca3af';
}
