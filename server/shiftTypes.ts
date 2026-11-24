// Shift-type commands (ADR 0003): create, edit and delete, for whoever can
// configure scheduling.
import { newId } from './db.js';
import { can } from './capabilities.js';
import { ok, refuse, type CommandContext, type Outcome } from './outcome.js';
import { staleRefusal, bumpVersion } from './staleness.js';
import type { Db, ShiftType } from '../shared/types.js';

const isTime = (s: unknown) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

const FORBIDDEN = 'Admin access required.';
const NOT_FOUND = 'Shift type not found.';

// Validate and normalize the shift-type fields shared by create and edit.
// Returns { error } on failure or { fields } on success.
export function parseShiftType(body: any): { error: string; fields?: undefined } | { error?: undefined; fields: Omit<ShiftType, 'id'> } {
  const { name, startTime, endTime, frequency, dayOfWeek, staffRequired, minRun, maxRun, weight, allowedRoles } = body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return { error: 'Shift name is required.' };
  if (!isTime(startTime) || !isTime(endTime))
    return { error: 'Start and end times are required (HH:MM).' };
  const freq = frequency === 'weekly' ? 'weekly' : 'daily';
  // Run target: a person stays on this shift type between minRun and maxRun
  // consecutive days. Blank = no grouping (min 1, no max).
  const min = Math.max(1, Number(minRun) || 1);
  const maxNum = Number(maxRun);
  const max = Number.isFinite(maxNum) && maxNum >= 1 ? Math.max(min, maxNum) : null;
  // Fairness weight: blank = automatic (1, or the overnight default for
  // overnight shifts). 0 is allowed and means standby duty that doesn't count
  // toward anyone's shift count.
  const wNum = Number(weight);
  const w = weight === '' || weight == null || !Number.isFinite(wNum) ? null : Math.max(0, wNum);
  return {
    fields: {
      weight: w,
      name: name.trim(),
      startTime,
      endTime,
      frequency: freq,
      dayOfWeek: freq === 'weekly' ? Math.min(6, Math.max(0, Number(dayOfWeek) || 0)) : null,
      staffRequired: Math.max(1, Number(staffRequired) || 1),
      minRun: min,
      maxRun: max,
      allowedRoles: Array.isArray(allowedRoles) ? allowedRoles.filter((r: any) => typeof r === 'string') : [],
    },
  };
}

export function createShiftType(db: Db, { actor }: CommandContext, input: unknown): Outcome<ShiftType> {
  if (!can(actor, 'configureScheduling')) return refuse('forbidden', FORBIDDEN);
  const { error, fields } = parseShiftType(input);
  if (error) return refuse('invalid', error);
  const st: ShiftType = { id: newId('s'), ...fields! };
  db.shiftTypes.push(st);
  return ok(st);
}

export function editShiftType(
  db: Db, { actor }: CommandContext, input: { id: string; expectedVersion?: unknown; [field: string]: unknown }
): Outcome<ShiftType> {
  if (!can(actor, 'configureScheduling')) return refuse('forbidden', FORBIDDEN);
  const st = db.shiftTypes.find((s) => s.id === input.id);
  if (!st) return refuse('not_found', NOT_FOUND);
  const stale = staleRefusal(st, input.expectedVersion, `The shift type "${st.name}"`);
  if (stale) return stale;
  const { error, fields } = parseShiftType(input);
  if (error) return refuse('invalid', error);
  // Mutate in place so existing schedules keep referencing the same id.
  Object.assign(st, fields!);
  bumpVersion(st);
  return ok(st);
}

export function deleteShiftType(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  if (!can(actor, 'configureScheduling')) return refuse('forbidden', FORBIDDEN);
  const idx = db.shiftTypes.findIndex((s) => s.id === id);
  if (idx === -1) return refuse('not_found', NOT_FOUND);
  db.shiftTypes.splice(idx, 1);
  return ok({ ok: true as const });
}
