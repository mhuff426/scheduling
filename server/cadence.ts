// The settings command (ADR 0003): the per-day limit for must-off days, the
// holidays required per year, and the cadence. The cadence change rule is
// shared with the Settings form (shared/blocks.ts).
import { ok, refuse, requireCan, type CommandContext, type Outcome } from './outcome.js';
import { bumpVersion, staleRefusal } from './staleness.js';
import { cadenceChangeProblem, isValidCadence } from '../shared/blocks.js';
import type { Db, Settings } from '../shared/types.js';

export interface SettingsInput {
  maxVacationPerDay?: unknown;
  holidaysRequiredPerYear?: unknown;
  cadence?: unknown;
  expectedVersion?: unknown;
}

export function updateSettings(db: Db, { actor, today }: CommandContext, input: SettingsInput): Outcome<Settings> {
  const no = requireCan(actor, 'configureScheduling');
  if (no) return no;
  const settings = db.settings;
  const { expectedVersion, maxVacationPerDay, holidaysRequiredPerYear, cadence } = input;
  const stale = staleRefusal(settings, expectedVersion, 'Settings');
  if (stale) return stale;

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
  bumpVersion(settings);
  return ok(settings);
}
