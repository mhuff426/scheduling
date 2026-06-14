// Shared data-model types for the JSON datastore (server/db.js) and the API
// payloads the client renders. Imported with `import type` on both sides.
// Kept deliberately loose where the runtime is loose (optional fields that older
// data files may omit) — this mirrors the defensive `??`/`|| 0` reads in the code.

export type Role = 'admin' | 'employee';
export type Frequency = 'daily' | 'weekly';
export type TimeOffType = 'vacation' | 'preferred';
export type LengthUnit = 'days' | 'weeks' | 'months' | 'quarters' | 'years';
export type TradeType = 'open' | 'direct' | 'giveaway';
export type TradeStatus = 'open' | 'completed' | 'expired' | 'rejected' | 'cancelled';

export interface User {
  id: string;
  name: string;
  role: Role;
  vacationDays: number;
  color: string;
  // Per-employee floor (null/absent = no minimum) and ceiling (null/absent =
  // unlimited), plus an optional personal consecutive-night cap.
  requiredShifts?: number | null;
  maxShiftsOverride?: number | null;
  maxConsecutiveNights?: number | null;
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
}

export interface TimeOff {
  id: string;
  userId: string;
  date: string; // "YYYY-MM-DD"
  type: TimeOffType;
}

export interface Cadence {
  anchorDate: string; // "YYYY-MM-DD"
  lengthUnit: LengthUnit;
  lengthValue: number;
}

export interface Settings {
  maxVacationPerDay: number;
  overnightWeight?: number;
  cadence?: Cadence | null;
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
  createdAt: string;
}

export interface Meta {
  rotationCursor: number;
}

export interface Db {
  users: User[];
  shiftTypes: ShiftType[];
  settings: Settings;
  timeOff: TimeOff[];
  schedules: Schedule[];
  trades: Trade[];
  notifications: Notification[];
  meta: Meta;
}

// What GET /api/state returns: the whole db plus a derived, never-persisted map.
export type AppState = Db & { preferenceStandings?: Record<string, number> };
