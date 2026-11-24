// The read projection (ADR 0002): every data read goes through `project`,
// which takes the data, the viewer (or no viewer) and what was asked for, and
// returns what that viewer may see. Read routes are thin adapters over it.
// No HTTP here: refusals are values the route turns into status codes.
//
// Extending it: what an employee may see of each collection lives in
// EMPLOYEE_VIEWS, one function per collection. A collection's view takes the
// rows and the viewer context and returns the rows that viewer may see.
// Admins see every collection whole.
import type { AppState, Db, Schedule, User } from '../shared/types.js';
import type { CollectionKey } from './mysql.js';
import { preferenceStandings } from './scheduler.js';
import { DEFAULT_DATA } from './db.js';
import { can } from './capabilities.js';

export const TAB_KEYS = {
  schedule: ['schedules', 'shiftTypes', 'holidays', 'trades', 'settings'],
  preferences: ['timeOff', 'awayTime', 'holidays', 'settings', 'schedules'],
  trades: ['schedules', 'trades', 'shiftTypes'],
  admin: ['roles', 'shiftTypes', 'settings', 'timeOff', 'schedules', 'awayTime', 'holidays'],
} satisfies Record<string, CollectionKey[]>;

export type TabName = keyof typeof TAB_KEYS;

export type ReadRequest =
  | { kind: 'state' }
  | { kind: 'tab'; tab: string }
  // `registered` (from the credential store, not the Db) is merged into each user record.
  | { kind: 'users'; registered: Record<string, boolean> };

export type Refusal = 'unauthenticated' | 'forbidden' | 'not_found';

export type Projection =
  | { refused: Refusal }
  | { state: AppState }
  // Admins get each record with `registered`; employees get no registration status.
  | { users: User[] };

/** Who is reading, resolved once per read and handed to every collection view. */
export type ViewContext = { viewer: User; db: Db };

type CollectionView<K extends CollectionKey> = (rows: Db[K], ctx: ViewContext) => Db[K];

const whole = <T,>(rows: T): T => rows;

// Away time is private to the person and the admins; the away memo is admin-only,
// so even the person's own away time reaches them with its label but no memo.
const ownAwayTimeWithoutMemo: CollectionView<'awayTime'> = (rows, { viewer }) =>
  rows.filter((a) => a.userId === viewer.id).map(({ memo: _memo, ...rest }) => rest);

// Trades an employee may see: ones they offered (posted, or offered a shift in
// reply to), were offered or claimed, whatever their status; plus coworkers'
// open trades and giveaways that are still open. Direct trades between two
// other people and coworkers' finished trades are hidden.
const tradesOpenToViewer: CollectionView<'trades'> = (trades, { viewer }) =>
  trades.filter((t) =>
    t.fromUserId === viewer.id ||
    t.toUserId === viewer.id ||
    t.claimedBy === viewer.id ||
    t.responses.some((r) => r.userId === viewer.id) ||
    (t.status === 'open' && (t.type === 'open' || t.type === 'giveaway')));

// Schedule settlement is private to the person and the admins: an employee's
// copy keeps the dates, people, assignments and unfilled slots, plus only
// their own vacation charges and extra-day election. The schedule's
// warnings, counts and preference stats are admin-only and left out.
const ownSettlement: CollectionView<'schedules'> = (rows, { viewer }) =>
  rows.map((s): Schedule => {
    const { warnings: _warnings, counts: _counts, preferenceStats: _stats, ...own } = s;
    if (s.vacationCharges) own.vacationCharges = s.vacationCharges.filter((c) => c.userId === viewer.id);
    if (s.extraElections) {
      const el = s.extraElections[viewer.id];
      own.extraElections = el ? { [viewer.id]: el } : {};
    }
    return own;
  });

// Coworkers appear by name and colour only (ADR 0002); the viewer's own record
// stays complete. The client must treat other users' other fields as absent.
const coworkersByName: CollectionView<'users'> = (rows, { viewer }) =>
  rows.map((u) => (u.id === viewer.id ? u : ({ id: u.id, name: u.name, color: u.color } as User)));

// What an employee may see of each collection. Every key must be listed, so a
// new collection can't reach employees until someone decides its view.
// Later tickets narrow these per ADR 0002.
const EMPLOYEE_VIEWS: { [K in CollectionKey]: CollectionView<K> } = {
  users: coworkersByName,
  roles: whole,
  shiftTypes: whole,
  settings: whole,
  // Must-off days are private to their owner (ADR 0002); coworkers learn only
  // which days are full, from `fullDays` on the tab read.
  timeOff: (rows, { viewer }) => rows.filter((t) => t.userId === viewer.id),
  schedules: ownSettlement,
  trades: tradesOpenToViewer,
  notifications: whole,
  awayTime: ownAwayTimeWithoutMemo,
  holidays: whole,
  meta: whole,
};

// Admins see every collection whole: the "see everyone's records" capability.
const isAdmin = (u: User) => can(u, 'seeEveryonesRecords');

function viewOf<K extends CollectionKey>(key: K, ctx: ViewContext): Db[K] {
  if (isAdmin(ctx.viewer)) return ctx.db[key];
  return EMPLOYEE_VIEWS[key](ctx.db[key], ctx);
}

// Tab responses keep the full AppState shape (components index collections
// without guards); unrequested keys are empty/default.
function emptyState(): AppState {
  return {
    users: [], roles: [], shiftTypes: [], timeOff: [], schedules: [],
    trades: [], notifications: [], awayTime: [], holidays: [],
    settings: structuredClone(DEFAULT_DATA.settings),
    meta: { rotationCursor: 0 },
  };
}

// Full days: dates where everyone's must-off days reach the per-day limit.
// Sent instead of the must-off days themselves, so nobody learns who is off
// or how many.
export function fullDays(db: Db): string[] {
  const perDay = new Map<string, number>();
  for (const t of db.timeOff) if (t.type === 'vacation') perDay.set(t.date, (perDay.get(t.date) || 0) + 1);
  return [...perDay].filter(([, n]) => n >= db.settings.maxVacationPerDay).map(([d]) => d).sort();
}

const isTab = (t: string): t is TabName => Object.prototype.hasOwnProperty.call(TAB_KEYS, t);

export function project(db: Db, viewerId: string | null, request: ReadRequest): Projection {
  const viewer = viewerId ? db.users.find((u) => u.id === viewerId) : undefined;
  if (!viewer) return { refused: 'unauthenticated' };
  const ctx: ViewContext = { viewer, db };

  switch (request.kind) {
    case 'state':
      if (!isAdmin(viewer)) return { refused: 'forbidden' };
      return { state: { ...db, preferenceStandings: preferenceStandings(db) } };

    case 'tab': {
      if (!isTab(request.tab)) return { refused: 'not_found' };
      if (request.tab === 'admin' && !isAdmin(viewer)) return { refused: 'forbidden' };
      const out = emptyState();
      for (const k of TAB_KEYS[request.tab] as CollectionKey[]) (out as any)[k] = viewOf(k, ctx);
      if ((TAB_KEYS[request.tab] as CollectionKey[]).includes('timeOff')) out.fullDays = fullDays(db);
      if (request.tab === 'admin') out.preferenceStandings = preferenceStandings(db);
      return { state: out };
    }

    case 'users':
      // Registration status goes to admins only.
      if (!isAdmin(viewer)) return { users: viewOf('users', ctx) };
      return {
        users: viewOf('users', ctx).map((u) => ({ ...u, registered: !!request.registered[u.id] })),
      };
  }
}
