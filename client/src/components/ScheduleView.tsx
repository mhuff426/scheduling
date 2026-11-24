import { useMemo, useState } from 'react';
import { api } from '../api';
import { DOW, MONTHS, monthGrid, prettyDate, formatTime, addDays, weekStart } from '../dates';
import { shiftTypeBreakdown } from '../shiftMath';
import {
  countingShifts, electedVacation, electedVacationInYear, extraDays, requiredShifts, vacationCharged,
  vacationChargedInYear, vacationYearsOf,
} from '../../../shared/settlement.js';
import { safeBg, CHIP_INK } from '../contrast';
import { holidayDatesInRange } from '../../../shared/holidays.js';
import type { AppState, Assignment, Holiday, Schedule, Slot, User } from '../../../shared/types.js';
import type { Act } from '../App';
import type { Capability } from '../../../shared/capabilities.js';

// Neutral background for a shift with no current assignee (former/open).
const NO_USER = '#cbd5e1';

const HOUR_H = 28; // px per hour in the week view
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// `can` is the viewer's capabilities as the server sent them: a hint for which
// controls to show (the server checks every request).
interface Props { db: AppState; currentUser: User; act: Act; can: (c: Capability) => boolean; }

export default function ScheduleView({ db, currentUser, act, can }: Props) {
  const buildsSchedules = can('buildSchedules');
  const seesEveryonesRecords = can('seeEveryonesRecords');
  const schedules = [...db.schedules].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [scheduleId, setScheduleId] = useState<string | null>(schedules[0]?.id || null);
  const schedule = schedules.find((s) => s.id === scheduleId) || schedules[0];
  const [view, setView] = useState('month');
  const [listUserId, setListUserId] = useState<string | undefined>(currentUser?.id);
  const [monthCursor, setMonthCursor] = useState(() =>
    schedule ? schedule.startDate.slice(0, 7) : new Date().toISOString().slice(0, 7)
  );
  const [weekCursor, setWeekCursor] = useState(() =>
    weekStart(schedule ? schedule.startDate : new Date().toISOString().slice(0, 10))
  );
  // Filters: '' / null mean "show everything".
  const [typeFilter, setTypeFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState<string | null>(null);
  // Which chip is being edited by the admin: `${date}|${shiftTypeId}|${userId or 'open'}`
  const [editKey, setEditKey] = useState<string | null>(null);

  const userById = useMemo(
    () => Object.fromEntries(db.users.map((u) => [u.id, u])),
    [db.users]
  );
  const shiftById = useMemo(
    () => Object.fromEntries(db.shiftTypes.map((s) => [s.id, s])),
    [db.shiftTypes]
  );

  if (!schedule) {
    return (
      <div className="empty-state">
        <h2>No schedules yet</h2>
        <p>
          {buildsSchedules
            ? 'Head to Admin → Generate Schedule to create the first one.'
            : 'Your admin hasn’t published a schedule yet. Check back soon!'}
        </p>
      </div>
    );
  }

  const visibleAssignments = schedule.assignments.filter(
    (a) =>
      (!typeFilter || a.shiftTypeId === typeFilter) &&
      (!employeeFilter || a.userId === employeeFilter)
  );
  const visibleOpen = (schedule.unfilled || []).filter(
    (s) => (!typeFilter || s.shiftTypeId === typeFilter) && !employeeFilter
  );

  const byDate: Record<string, Assignment[]> = {};
  for (const a of visibleAssignments) (byDate[a.date] ||= []).push(a);
  const openByDate: Record<string, Slot[]> = {};
  for (const s of visibleOpen) (openByDate[s.date] ||= []).push(s);

  const move = async (m: any) => {
    setEditKey(null);
    await act(() => api.reassign(schedule.id, m));
  };

  const RoleSelect = ({ date, shiftTypeId, fromUserId }: { date: string; shiftTypeId: string; fromUserId: string | null }) => (
    <select
      autoFocus
      className="chip-edit"
      value={fromUserId || ''}
      onChange={(e) =>
        move({ date, shiftTypeId, fromUserId, toUserId: e.target.value || null })
      }
      onBlur={() => setEditKey(null)}
    >
      {!fromUserId && <option value="">— pick employee —</option>}
      {db.users.map((u) => (
        <option key={u.id} value={u.id}>{u.name}</option>
      ))}
      {fromUserId && <option value="">(unassign — mark open)</option>}
    </select>
  );

  const [year, month] = monthCursor.split('-').map(Number);
  const weeks = monthGrid(year, month - 1);
  // Holidays recur, so resolve them to concrete dates across the visible month.
  const visibleDates = weeks.flat().filter((d): d is string => !!d);
  const holidaysByDate: Record<string, Holiday> = {};
  if (visibleDates.length)
    for (const o of holidayDatesInRange(db.holidays || [], visibleDates[0], visibleDates[visibleDates.length - 1]))
      holidaysByDate[o.date] = o.holiday;
  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setMonthCursor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const listUser: User = userById[listUserId as string] || currentUser;
  // Settlement (the settlement card and extras picked up) is private to the
  // person and the admins (ADR 0002); a coworker's copy has none of it.
  const seesListUsersSettlement = listUser?.id === currentUser.id || seesEveryonesRecords;
  const myAssignments = schedule.assignments
    .filter((a) => a.userId === listUser?.id)
    .sort((a, b) => a.date.localeCompare(b.date));

  const exportIcs = (userId: string) => {
    window.location.href = `/api/schedules/${schedule.id}/ics?userId=${encodeURIComponent(userId)}`;
  };

  const scheduleUserIds = schedule.userIds;
  const legendUsers = Array.isArray(scheduleUserIds)
    ? db.users.filter((u) => scheduleUserIds.includes(u.id))
    : db.users;

  return (
    <div>
      <div className="toolbar">
        <select value={schedule.id} onChange={(e) => {
          setScheduleId(e.target.value);
          const s = schedules.find((x) => x.id === e.target.value);
          if (s) {
            setMonthCursor(s.startDate.slice(0, 7));
            setWeekCursor(weekStart(s.startDate));
          }
        }}>
          {schedules.map((s) => (
            <option key={s.id} value={s.id}>
              {prettyDate(s.startDate)} → {prettyDate(s.endDate)}
            </option>
          ))}
        </select>
        <div className="seg">
          <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>
            📅 Month
          </button>
          <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>
            🕐 Week
          </button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            📋 My Shifts
          </button>
        </div>
        {view !== 'list' && (
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All shift types</option>
            {db.shiftTypes.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        <button className="btn" onClick={() => exportIcs(currentUser.id)}>
          ⬇️ Add my shifts to calendar (.ics)
        </button>
        {buildsSchedules && (
          <button
            className="btn danger ghost"
            onClick={() => {
              if (confirm('Delete this schedule?')) act(() => api.deleteSchedule(schedule.id));
            }}
          >
            Delete schedule
          </button>
        )}
      </div>

      {/* Warnings are admin-only; an employee's schedules don't carry them. */}
      {seesEveryonesRecords && schedule.warnings && schedule.warnings.length > 0 && (
        <details className="warnings">
          <summary>⚠️ {schedule.warnings.length} scheduling warning{schedule.warnings.length > 1 ? 's' : ''}</summary>
          <ul>{schedule.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}

      <div className="legend">
        {legendUsers.map((u) => (
          <button
            key={u.id}
            className={`legend-item legend-btn ${employeeFilter === u.id ? 'active' : ''} ${employeeFilter && employeeFilter !== u.id ? 'dim' : ''}`}
            title={employeeFilter === u.id ? 'Click to show everyone' : `Show only ${u.name}'s shifts`}
            onClick={() => setEmployeeFilter(employeeFilter === u.id ? null : u.id)}
          >
            <span className="dot" style={{ background: safeBg(u.color) }} /> {u.name}
          </button>
        ))}
        {employeeFilter && (
          <button className="btn ghost sm" onClick={() => setEmployeeFilter(null)}>✕ Clear filter</button>
        )}
        {!employeeFilter && <span className="muted small">click a name to filter</span>}
      </div>

      {view === 'month' && (
        <div className="cal-wrap">
          <div className="cal-nav">
            <button className="btn ghost" onClick={() => shiftMonth(-1)}>‹</button>
            <h2>{MONTHS[month - 1]} {year}</h2>
            <button className="btn ghost" onClick={() => shiftMonth(1)}>›</button>
          </div>
          <div className="cal-grid">
            {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {weeks.flat().map((date, i) => {
              const inRange = date && date >= schedule.startDate && date <= schedule.endDate;
              return (
                <div key={i} className={`cal-cell ${!date ? 'blank' : ''} ${inRange ? '' : 'out'}`}>
                  {date && <div className="cal-day">{Number(date.slice(8))}</div>}
                  {date && holidaysByDate[date] && (
                    <div className="chip chip-holiday" title={holidaysByDate[date].workable ? 'Workable holiday' : 'Holiday — closed'}>
                      🎉 {holidaysByDate[date].name}
                    </div>
                  )}
                  {date && (byDate[date] || []).map((a, j) => {
                    const u = userById[a.userId];
                    const st = shiftById[a.shiftTypeId];
                    if (!st) return null;
                    const key = `${a.date}|${a.shiftTypeId}|${a.userId}`;
                    if (buildsSchedules && editKey === key) {
                      return <RoleSelect key={j} date={a.date} shiftTypeId={a.shiftTypeId} fromUserId={a.userId} />;
                    }
                    return (
                      <div
                        key={j}
                        className={`chip ${a.userId === currentUser.id ? 'mine' : ''} ${buildsSchedules ? 'editable' : ''}`}
                        style={{ background: safeBg(u ? u.color : NO_USER), color: CHIP_INK }}
                        title={`${u ? u.name : 'Former employee'} — ${st.name} (${formatTime(st.startTime)}–${formatTime(st.endTime)})${buildsSchedules ? ' — click to reassign' : ''}`}
                        onClick={() => buildsSchedules && setEditKey(key)}
                      >
                        {(u ? u.name : '?').split(' ')[0]} · {st.name}
                      </div>
                    );
                  })}
                  {date && (openByDate[date] || []).map((s, j) => {
                    const st = shiftById[s.shiftTypeId];
                    if (!st) return null;
                    const key = `${s.date}|${s.shiftTypeId}|open`;
                    if (buildsSchedules && editKey === key) {
                      return <RoleSelect key={`o${j}`} date={s.date} shiftTypeId={s.shiftTypeId} fromUserId={null} />;
                    }
                    return (
                      <div
                        key={`o${j}`}
                        className={`chip chip-open ${buildsSchedules ? 'editable' : ''}`}
                        title={`Open shift: ${st.name} (${formatTime(st.startTime)}–${formatTime(st.endTime)})${buildsSchedules ? ' — click to assign' : ''}`}
                        onClick={() => buildsSchedules && setEditKey(key)}
                      >
                        ⚠ OPEN · {st.name}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'week' && (
        <WeekView
          weekCursor={weekCursor}
          setWeekCursor={setWeekCursor}
          schedule={schedule}
          assignments={visibleAssignments}
          openSlots={visibleOpen}
          shiftById={shiftById}
          userById={userById}
          currentUser={currentUser}
        />
      )}

      {view === 'list' && (
        <>
        <div className="card">
          <div className="row spread">
            <h2>Shifts for</h2>
            <select value={listUser?.id} onChange={(e) => setListUserId(e.target.value)}>
              {db.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="btn ghost" onClick={() => exportIcs(listUser.id)}>⬇️ Export .ics</button>
          </div>
          {myAssignments.length === 0 ? (
            <p className="muted">No shifts assigned in this schedule.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Shift</th><th>Time</th></tr>
              </thead>
              <tbody>
                {myAssignments.map((a, i) => {
                  const st = shiftById[a.shiftTypeId];
                  return (
                    <tr key={i}>
                      <td>{prettyDate(a.date)}</td>
                      <td>
                        <span className="dot" style={{ background: safeBg(listUser.color) }} /> {st?.name}
                      </td>
                      <td>{st ? `${formatTime(st.startTime)} – ${formatTime(st.endTime)}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {listUser && (
            <ShiftBreakdownTable db={db} schedule={schedule} user={listUser} showExtras={seesListUsersSettlement} />
          )}
        </div>
        {listUser && seesListUsersSettlement && (
          <SettlementCard
            key={`${schedule.id}|${listUser.id}`}
            db={db} schedule={schedule} user={listUser}
            self={listUser.id === currentUser.id} act={act}
          />
        )}
        {seesEveryonesRecords && <AdminSettlementTable db={db} schedule={schedule} users={legendUsers} />}
        </>
      )}
    </div>
  );
}

// How many of each kind of shift the person works this block, and how many of
// those they picked up as extras via giveaways. Extras are part of the
// person's settlement, so `showExtras` is off for a coworker's breakdown.
function ShiftBreakdownTable({ db, schedule, user, showExtras }: { db: AppState; schedule: Schedule; user: User; showExtras: boolean }) {
  const { rows, total } = shiftTypeBreakdown(db, schedule, user.id);
  if (rows.length === 0) return null;
  return (
    <table className="table shift-breakdown">
      <thead>
        <tr>
          <th>Shift type</th><th>Shifts</th>
          {showExtras && <th title="Shifts picked up from coworkers' giveaways">Extra picked up</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.shiftTypeId}>
            <td>
              <span className="dot" style={{ background: safeBg(user.color) }} /> {r.name}
              {r.standby && (
                <span className="muted small" title="Standby duty doesn't count toward required shifts"> (standby)</span>
              )}
            </td>
            <td>{r.shifts}</td>
            {showExtras && <td>{r.extra}</td>}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><th>Total</th><th>{total.shifts}</th>{showExtras && <th>{total.extra}</th>}</tr>
      </tfoot>
    </table>
  );
}

// The figures the settlement card and admin table show, all from settlement.
// `years` is every vacation year the schedule spans (two across New Year).
// The per-year breakdowns ("2026: 1, 2027: 2") are '' for a schedule inside
// one vacation year, or when there's nothing to break down.
function settlementFor(db: AppState, schedule: Schedule, user: User) {
  const years = vacationYearsOf(schedule);
  const election = schedule.extraElections?.[user.id] || { vacationByYear: {}, incentive: 0 };
  const charged = vacationCharged(schedule, user.id);
  const vacation = electedVacation(election);
  const vacationIn = (year: number) => electedVacationInYear(election, year);
  return {
    years,
    count: countingShifts(db, schedule, user.id),
    required: requiredShifts(user),
    charged,
    chargedPerYear: charged > 0 ? perYear(years, (y) => vacationChargedInYear(schedule, user.id, y)) : '',
    extra: extraDays(db, schedule, user),
    election,
    vacation,
    vacationIn,
    vacationPerYear: vacation > 0 ? perYear(years, vacationIn) : '',
  };
}

// "2026: 1, 2027: 2" for a schedule spanning years; '' for a single year.
function perYear(years: number[], n: (year: number) => number) {
  return years.length > 1 ? years.map((y) => `${y}: ${n(y)}`).join(', ') : '';
}

// Per-person settlement for one schedule: shifts worked vs required, vacation
// days charged, and extra days, which the employee can split into extra
// vacation or incentive pay. When the schedule spans two vacation years, the
// employee picks which year the vacation days go to, or splits them.
function SettlementCard({ db, schedule, user, self, act }: { db: AppState; schedule: Schedule; user: User; self: boolean; act: Act }) {
  const s = settlementFor(db, schedule, user);
  const split = s.years.length > 1;
  const saved = () => Object.fromEntries(s.years.map((y) => [y, s.vacationIn(y)]));
  const [vacByYear, setVacByYear] = useState<Record<string, number>>(saved);
  const [inc, setInc] = useState(s.election.incentive);
  const vac = Object.values(vacByYear).reduce((t, n) => t + n, 0);
  const dirty = s.years.some((y) => (vacByYear[y] || 0) !== s.vacationIn(y)) || inc !== s.election.incentive;
  const unallocated = s.extra - s.vacation - s.election.incentive;
  const setYear = (year: number, n: number) => setVacByYear((v) => ({ ...v, [year]: Math.max(0, n) }));
  const vacationLabel = (y: number) => (split ? `As vacation for ${y}` : 'As vacation');

  return (
    <div className="card">
      <h2>🧾 Schedule settlement — {user.name}</h2>
      <p className="muted small">
        Worked <strong>{s.count}</strong> of <strong>{s.required}</strong> required
        {' · '}vacation charges: <strong>{s.charged}</strong>
        {s.chargedPerYear && ` (${s.chargedPerYear})`}
        {' · '}extra days: <strong>{s.extra}</strong>
        {s.extra > 0 && unallocated > 0 && ` (${unallocated} not yet elected)`}
      </p>
      {self && s.extra > 0 && (
        <div className="row spread">
          <span className="small">Extra-day election:</span>
          {s.years.map((y) => (
            <label key={y} className="row small">
              {vacationLabel(y)}
              <input
                className="inline-num" type="number" min="0" max={s.extra}
                aria-label={vacationLabel(y)}
                value={vacByYear[y] || 0} onChange={(e) => setYear(y, Number(e.target.value) || 0)}
              />
            </label>
          ))}
          <label className="row small">
            As incentive pay
            <input
              className="inline-num" type="number" min="0" max={s.extra}
              aria-label="As incentive pay"
              value={inc} onChange={(e) => setInc(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <button
            className="btn primary sm"
            disabled={!dirty || vac + inc > s.extra}
            onClick={() => act(() => api.electExtra(schedule.id, { userId: user.id, vacationByYear: vacByYear, incentive: inc }))}
          >
            Save extra-day election
          </button>
          {vac + inc > s.extra && <span className="muted small">only {s.extra} to elect</span>}
        </div>
      )}
      {self && s.extra > 0 && (
        <p className="muted small">
          {split
            ? `This schedule spans ${s.years.join(' and ')}: choose which year balance your days elected as vacation add to, or split them across both. `
            : 'Days elected as vacation add to this year balance. '}
          Incentive pay is paid out by HR.
        </p>
      )}
      {!self && (s.vacation > 0 || s.election.incentive > 0) && (
        <p className="muted small">
          Extra-day election: {s.vacation} as vacation{s.vacationPerYear && ` (${s.vacationPerYear})`}, {s.election.incentive} as incentive pay.
        </p>
      )}
    </div>
  );
}

// Admin/HR overview: settlement for every person in the block.
function AdminSettlementTable({ db, schedule, users }: { db: AppState; schedule: Schedule; users: User[] }) {
  return (
    <div className="card">
      <h2>📊 Settlement overview (admin)</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Employee</th><th>Worked</th><th>Required</th>
            <th>Vacation charges</th><th>Extra days</th>
            <th>→ Elected as vacation</th><th>→ Elected as incentive pay</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const s = settlementFor(db, schedule, u);
            return (
              <tr key={u.id}>
                <td><span className="dot" style={{ background: safeBg(u.color) }} /> {u.name}</td>
                <td>{s.count}</td>
                <td>{s.required}</td>
                <td>{s.charged}{s.chargedPerYear && <span className="muted small"> ({s.chargedPerYear})</span>}</td>
                <td>{s.extra}</td>
                <td>{s.vacation}{s.vacationPerYear && <span className="muted small"> ({s.vacationPerYear})</span>}</td>
                <td>{s.election.incentive}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface WeekSeg {
  start: number;
  end: number;
  a?: Assignment;
  st: import('../../../shared/types.js').ShiftType;
  open?: boolean;
  cont?: boolean;
  lane?: number;
  lanes?: number;
}

interface WeekViewProps {
  weekCursor: string;
  setWeekCursor: (v: string) => void;
  schedule: Schedule;
  assignments: Assignment[];
  openSlots: Slot[];
  shiftById: any;
  userById: any;
  currentUser: User;
}

// Hour-by-hour week view: each day is a 24h column; shifts render as timed
// blocks colored by employee. Overnight shifts split at midnight and continue
// in the next day's column.
function WeekView({ weekCursor, setWeekCursor, schedule, assignments, openSlots, shiftById, userById, currentUser }: WeekViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekCursor, i));

  // date -> [{ start, end (minutes), a, st, open, cont }]
  const segs: Record<string, WeekSeg[]> = Object.fromEntries(days.map((d) => [d, [] as WeekSeg[]]));
  const push = (date: string, start: number, end: number, item: Partial<WeekSeg>) => {
    if (segs[date]) segs[date].push({ start, end, ...item } as WeekSeg);
  };
  const addItem = (date: string, st: WeekSeg['st'], item: Partial<WeekSeg>) => {
    const start = toMin(st.startTime);
    const end = st.endTime <= st.startTime ? toMin(st.endTime) + 1440 : toMin(st.endTime);
    if (end <= 1440) {
      push(date, start, Math.max(end, start + 30), item);
    } else {
      push(date, start, 1440, item);
      push(addDays(date, 1), 0, end - 1440, { ...item, cont: true });
    }
  };
  for (const a of assignments) {
    const st = shiftById[a.shiftTypeId];
    if (st) addItem(a.date, st, { a, st });
  }
  for (const s of openSlots) {
    const st = shiftById[s.shiftTypeId];
    if (st) addItem(s.date, st, { st, open: true });
  }

  // Greedy lane packing so overlapping blocks share the column width.
  for (const d of days) {
    const list = segs[d].sort((x, y) => x.start - y.start || y.end - x.end);
    const laneEnds: number[] = [];
    for (const s of list) {
      let lane = laneEnds.findIndex((e) => e <= s.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = s.end;
      s.lane = lane;
    }
    const n = Math.max(1, laneEnds.length);
    list.forEach((s) => { s.lanes = n; });
  }

  const fmtDayHead = (d: string) => {
    const dt = new Date(d + 'T00:00:00');
    return `${DOW[dt.getDay()]} ${dt.getMonth() + 1}/${dt.getDate()}`;
  };
  const rangeLabel = `${prettyDate(days[0])} – ${prettyDate(days[6])}`;

  return (
    <div className="cal-wrap">
      <div className="cal-nav">
        <button className="btn ghost" onClick={() => setWeekCursor(addDays(weekCursor, -7))}>‹</button>
        <h2 className="week-label">{rangeLabel}</h2>
        <button className="btn ghost" onClick={() => setWeekCursor(addDays(weekCursor, 7))}>›</button>
      </div>
      <div className="week-grid">
        <div className="week-times">
          <div className="week-day-head" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="week-hour-label" style={{ height: HOUR_H }}>
              {h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`}
            </div>
          ))}
        </div>
        {days.map((d) => {
          const inRange = d >= schedule.startDate && d <= schedule.endDate;
          return (
            <div key={d} className={`week-day ${inRange ? '' : 'out'}`}>
              <div className="week-day-head">{fmtDayHead(d)}</div>
              <div className="week-day-body" style={{ height: 24 * HOUR_H }}>
                {segs[d].map((s, i) => {
                  const u = s.a ? userById[s.a.userId] : null;
                  const width = 100 / (s.lanes || 1);
                  const label = s.open
                    ? `OPEN · ${s.st.name}`
                    : `${(u ? u.name : '?').split(' ')[0]} · ${s.st.name}`;
                  const title = `${s.open ? 'Open shift' : (u ? u.name : 'Former employee')} — ${s.st.name} (${formatTime(s.st.startTime)}–${formatTime(s.st.endTime)})${s.cont ? ' (continued from previous day)' : ''}`;
                  return (
                    <div
                      key={i}
                      className={`week-block ${s.open ? 'open' : ''} ${s.a && s.a.userId === currentUser.id ? 'mine' : ''}`}
                      style={{
                        top: (s.start / 60) * HOUR_H,
                        height: Math.max(((s.end - s.start) / 60) * HOUR_H - 2, 14),
                        left: `${(s.lane || 0) * width}%`,
                        width: `calc(${width}% - 3px)`,
                        background: s.open ? undefined : safeBg(u ? u.color : NO_USER),
                        color: s.open ? undefined : CHIP_INK,
                      }}
                      title={title}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
