// Shared data-model types for the JSON datastore (server/db.js) and the API
// payloads the client renders. Imported with `import type` on both sides.
// Kept deliberately loose where the runtime is loose (optional fields that older
// data files may omit) — this mirrors the defensive `??`/`|| 0` reads in the code.

// `version` fields support optimistic concurrency: clients echo the version
// they read as `expectedVersion` on updates; the server rejects (409) when it
// no longer matches, and bumps it on every successful edit.
export interface RoleTag { id: string; name: string; system?: boolean; version?: number; }
export type Frequency = 'daily' | 'weekly';
export type TimeOffType = 'vacation' | 'preferred';
export type LengthUnit = 'days' | 'weeks' | 'months' | 'quarters' | 'years';
export type TradeType = 'open' | 'direct' | 'giveaway';
export type TradeStatus = 'open' | 'completed' | 'expired' | 'rejected' | 'cancelled';

export interface User {
  id: string;
  name: string;
  roles: string[];
  vacationDays: number;
  color: string;
  // Per-employee floor (null/absent = no minimum) and ceiling (null/absent =
  // unlimited), plus an optional personal consecutive-night cap.
  requiredShifts?: number | null;
  maxShiftsOverride?: number | null;
  maxConsecutiveNights?: number | null;
  startDate?: string | null;
  theme?: 'light' | 'dark';
  version?: number;
  // Identity fields (stored in users table, synced to/from name).
  firstName?: string;
  lastName?: string;
  email?: string;
  employeeId?: string | null;
  // `registered` is derived — the server merges it into API responses; it is
  // NOT persisted on the users table (it lives in user_credentials.registered).
  // Credentials (password hash, tokens) never ride on this type.
  registered?: boolean;
}

export interface ShiftType {
  id: string;
  name: string;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  frequency: Frequency;
  dayOfWeek: number | null; // 0-6 for weekly, null for daily
  staffRequired: number;
  minRun?: number;
  maxRun?: number | null;
  weight?: number | null; // null/absent = automatic; 0 = uncounted standby
  allowedRoles?: string[]; // role ids; empty/absent = anyone
  version?: number;
}

export interface TimeOff {
  id: string;
  userId: string;
  date: string; // "YYYY-MM-DD"
  type: TimeOffType;
}

export interface AwayTime {
  id: string;
  userId: string;
  start: string; // "YYYY-MM-DD" inclusive
  end: string;   // "YYYY-MM-DD" inclusive
  label?: string; // shown to the employee (calendar chip, away card)
  memo?: string;  // admin-only note explaining the away time
  version?: number;
}

// How a holiday recurs. `yearly` = same month/day every year; `nth-weekday` =
// e.g. the 4th Thursday of November (ordinal -1 means the LAST such weekday);
// `one-off` = a single explicit date, that year only.
export type HolidayRecurrence =
  | { type: 'yearly'; month: number; day: number }                          // month 1-12, day 1-31
  | { type: 'nth-weekday'; month: number; weekday: number; ordinal: number } // weekday 0=Sun..6=Sat; ordinal 1-4 or -1=last
  | { type: 'one-off'; date: string };                                      // "YYYY-MM-DD"

export interface Holiday {
  id: string;
  name: string;
  workable: boolean; // true = staffed & counts for fairness; false = closed (no shifts)
  recurrence: HolidayRecurrence;
  version?: number;
}

export interface Cadence {
  anchorDate: string; // "YYYY-MM-DD"
  lengthUnit: LengthUnit;
  lengthValue: number;
}

export interface Settings {
  maxVacationPerDay: number;
  cadence?: Cadence | null;
  holidaysRequiredPerYear?: number;
  version?: number;
}

// A concrete shift occurrence (a slot, filled or not).
export interface Slot {
  date: string;
  shiftTypeId: string;
}

export interface Assignment extends Slot {
  userId: string;
}

export interface ExtraElection {
  vacation: number;
  incentive: number;
}

export interface PreferenceStats {
  asks: Record<string, number>;
  median: number;
}

// The fields produced/consumed while a schedule is being generated or
// recomputed — a superset of what's persisted minus the identity fields.
export interface ScheduleDraft {
  startDate: string;
  endDate: string;
  userIds: string[];
  assignments: Assignment[];
  unfilled: Slot[];
  counts?: Record<string, number>;
  warnings?: string[];
  vacationCharged?: Record<string, number>;
  extraElections?: Record<string, ExtraElection>;
  preferenceStats?: PreferenceStats;
}

export interface Schedule extends ScheduleDraft {
  id: string;
  createdAt: string;
  counts: Record<string, number>;
  warnings: string[];
}

export interface TradeResponse {
  userId: string;
  date: string;
  shiftTypeId: string;
  at: string;
}

export interface Trade {
  id: string;
  scheduleId: string;
  type: TradeType;
  status: TradeStatus;
  fromUserId: string;
  offered: Slot;
  toUserId: string | null;
  requested: Slot | null;
  responses: TradeResponse[];
  claimedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Notification {
  id: string;
  userId: string;
  message: string;
  tradeId?: string;
  read: boolean;
  dismissed?: boolean;
  createdAt: string;
}

export interface Meta {
  rotationCursor: number;
}

export interface Db {
  users: User[];
  roles: RoleTag[];
  shiftTypes: ShiftType[];
  settings: Settings;
  timeOff: TimeOff[];
  schedules: Schedule[];
  trades: Trade[];
  notifications: Notification[];
  awayTime: AwayTime[];
  holidays: Holiday[];
  meta: Meta;
}

// What GET /api/state returns: the whole db plus a derived, never-persisted map.
export type AppState = Db & { preferenceStandings?: Record<string, number> };
