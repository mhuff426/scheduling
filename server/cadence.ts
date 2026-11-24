// The settings command (ADR 0003): the per-day limit for must-off days, the
// holidays required per year, and the cadence. The cadence change rule is
// shared with the Settings form (shared/blocks.ts).
import { can } from './capabilities.js';
import { ok, refuse, type CommandContext, type Outcome } from './outcome.js';
import { cadenceChangeProblem, isValidCadence } from '../shared/blocks.js';
import type { Db, Settings } from '../shared/types.js';

export interface SettingsInput {
  maxVacationPerDay?: unknown;
  holidaysRequiredPerYear?: unknown;
  cadence?: unknown;
  expectedVersion?: unknown;
}

export function updateSettings(db: Db, { actor, today }: CommandContext, input: SettingsInput): Outcome<Settings> {
  if (!can(actor, 'configureScheduling')) return refuse('forbidden', 'Admin access required.');
  const settings = db.settings;
  const { expectedVersion, maxVacationPerDay, holidaysRequiredPerYear, cadence } = input;
  if (expectedVersion !== undefined && Number(expectedVersion) !== (settings.version ?? 1))
    return refuse('stale', 'Settings was changed by someone else — the view has been refreshed with the latest data. Please retry.');

  // Check the cadence before changing anything, so a refusal leaves the data as it was.
  if (cadence !== undefined) {
    if (!isValidCadence(cadence))
      return refuse('invalid', 'Invalid cadence: need an anchor date, a positive whole number, and a unit.');
    const problem = cadenceChangeProblem(settings.cadence, cadence, today);
    if (problem) return refuse('invalid', problem);
  }

  if (maxVacationPerDay !== undefined)
    settings.maxVacationPerDay = Math.max(1, Number(maxVacationPerDay) || 1);
  if (holidaysRequiredPerYear !== undefined)
    settings.holidaysRequiredPerYear = Math.max(0, Number(holidaysRequiredPerYear) || 0);
  if (isValidCadence(cadence))
    settings.cadence = { anchorDate: cadence.anchorDate, lengthUnit: cadence.lengthUnit, lengthValue: cadence.lengthValue };
  settings.version = (settings.version ?? 1) + 1;
  return ok(settings);
}
