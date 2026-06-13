import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { DOW, MONTHS, monthGrid, prettyDate, formatTime, addDays, weekStart } from '../dates.js';
import { settlementFor } from '../shiftMath.js';

const HOUR_H = 28; // px per hour in the week view
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export default function ScheduleView({ db, currentUser, act, isAdmin }) {
  const schedules = [...db.schedules].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [scheduleId, setScheduleId] = useState(schedules[0]?.id || null);
  const schedule = schedules.find((s) => s.id === scheduleId) || schedules[0];
  const [view, setView] = useState('month');
  const [listUserId, setListUserId] = useState(currentUser?.id);
  const [monthCursor, setMonthCursor] = useState(() =>
    schedule ? schedule.startDate.slice(0, 7) : new Date().toISOString().slice(0, 7)
  );
  const [weekCursor, setWeekCursor] = useState(() =>
    weekStart(schedule ? schedule.startDate : new Date().toISOString().slice(0, 10))
  );
  // Filters: '' / null mean "show everything".
  const [typeFilter, setTypeFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState(null);
  // Which chip is being edited by the admin: `${date}|${shiftTypeId}|${userId or 'open'}`
  const [editKey, setEditKey] = useState(null);

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
          {isAdmin
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

  const byDate = {};
  for (const a of visibleAssignments) (byDate[a.date] ||= []).push(a);
  const openByDate = {};
  for (const s of visibleOpen) (openByDate[s.date] ||= []).push(s);

  const move = async (m) => {
    setEditKey(null);
    await act(() => api.reassign(schedule.id, m));
  };

  const RoleSelect = ({ date, shiftTypeId, fromUserId }) => (
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
  const shiftMonth = (delta) => {
    const d = new Date(year, month - 1 + delta, 1);
    setMonthCursor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const listUser = userById[listUserId] || currentUser;
  const myAssignments = schedule.assignments
    .filter((a) => a.userId === listUser?.id)
    .sort((a, b) => a.date.localeCompare(b.date));

  const exportIcs = (userId) => {
    window.location.href = `/api/schedules/${schedule.id}/ics?userId=${encodeURIComponent(userId)}`;
  };

  const legendUsers = Array.isArray(schedule.userIds)
    ? db.users.filter((u) => schedule.userIds.includes(u.id))
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
        {isAdmin && (
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

      {schedule.warnings?.length > 0 && isAdmin && (
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
            <span className="dot" style={{ background: u.color }} /> {u.name}
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
                  {date && (byDate[date] || []).map((a, j) => {
                    const u = userById[a.userId];
                    const st = shiftById[a.shiftTypeId];
                    if (!st) return null;
                    const key = `${a.date}|${a.shiftTypeId}|${a.userId}`;
                    if (isAdmin && editKey === key) {
                      return <RoleSelect key={j} date={a.date} shiftTypeId={a.shiftTypeId} fromUserId={a.userId} />;
                    }
                    return (
                      <div
                        key={j}
                        className={`chip ${a.userId === currentUser.id ? 'mine' : ''} ${isAdmin ? 'editable' : ''}`}
                        style={{ background: u ? u.color : '#9ca3af' }}
                        title={`${u ? u.name : 'Former employee'} — ${st.name} (${formatTime(st.startTime)}–${formatTime(st.endTime)})${isAdmin ? ' — click to reassign' : ''}`}
                        onClick={() => isAdmin && setEditKey(key)}
                      >
                        {(u ? u.name : '?').split(' ')[0]} · {st.name}
                      </div>
                    );
                  })}
                  {date && (openByDate[date] || []).map((s, j) => {
                    const st = shiftById[s.shiftTypeId];
                    if (!st) return null;
                    const key = `${s.date}|${s.shiftTypeId}|open`;
                    if (isAdmin && editKey === key) {
                      return <RoleSelect key={`o${j}`} date={s.date} shiftTypeId={s.shiftTypeId} fromUserId={null} />;
                    }
                    return (
                      <div
                        key={`o${j}`}
                        className={`chip chip-open ${isAdmin ? 'editable' : ''}`}
                        title={`Open shift: ${st.name} (${formatTime(st.startTime)}–${formatTime(st.endTime)})${isAdmin ? ' — click to assign' : ''}`}
                        onClick={() => isAdmin && setEditKey(key)}
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
                        <span className="dot" style={{ background: listUser.color }} /> {st?.name}
                      </td>
                      <td>{st ? `${formatTime(st.startTime)} – ${formatTime(st.endTime)}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted small">
            Total: {myAssignments.length} shift{myAssignments.length === 1 ? '' : 's'}
            {schedule.minShifts ? ` (minimum for this schedule: ${schedule.minShifts})` : ''}
            {' · '}Extra shifts picked up via trades:{' '}
            {(db.trades || []).filter(
              (t) =>
                t.type === 'giveaway' &&
                t.status === 'completed' &&
                t.scheduleId === schedule.id &&
                t.claimedBy === listUser?.id
            ).length}
          </p>
        </div>
        {listUser && (
          <SettlementCard
            key={`${schedule.id}|${listUser.id}`}
            db={db} schedule={schedule} user={listUser}
            self={listUser.id === currentUser.id} act={act}
          />
        )}
        {isAdmin && <AdminSettlementTable db={db} schedule={schedule} users={legendUsers} />}
        </>
      )}
    </div>
  );
}

// Per-person settlement for one schedule: shifts worked vs required, vacation
// days charged, and extra days — which the employee can split into extra
// vacation or incentive pay.
function SettlementCard({ db, schedule, user, self, act }) {
  const s = settlementFor(db, schedule, user);
  const [vac, setVac] = useState(s.election.vacation);
  const [inc, setInc] = useState(s.election.incentive);
  const dirty = vac !== s.election.vacation || inc !== s.election.incentive;
  const unallocated = s.extra - s.election.vacation - s.election.incentive;

  return (
    <div className="card">
      <h2>🧾 Schedule settlement — {user.name}</h2>
      <p className="muted small">
        Worked <strong>{s.count}</strong> of <strong>{s.required}</strong> required
        {' · '}vacation days taken: <strong>{s.charged}</strong>
        {' · '}extra days: <strong>{s.extra}</strong>
        {s.extra > 0 && unallocated > 0 && ` (${unallocated} not yet allocated)`}
      </p>
      {self && s.extra > 0 && (
        <div className="row spread">
          <label className="row small">
            Extra vacation
            <input
              className="inline-num" type="number" min="0" max={s.extra}
              value={vac} onChange={(e) => setVac(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <label className="row small">
            Incentive pay
            <input
              className="inline-num" type="number" min="0" max={s.extra}
              value={inc} onChange={(e) => setInc(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <button
            className="btn primary sm"
            disabled={!dirty || vac + inc > s.extra}
            onClick={() => act(() => api.electExtra(schedule.id, { userId: user.id, vacation: vac, incentive: inc }))}
          >
            Save split
          </button>
          {vac + inc > s.extra && <span className="muted small">only {s.extra} to allocate</span>}
        </div>
      )}
      {self && s.extra > 0 && (
        <p className="muted small">
          Split your extra days: extra vacation adds to this year's allowance; incentive pay is
          paid out by HR.
        </p>
      )}
      {!self && (s.election.vacation > 0 || s.election.incentive > 0) && (
        <p className="muted small">
          Elected: {s.election.vacation} extra vacation, {s.election.incentive} incentive pay.
        </p>
      )}
    </div>
  );
}

// Admin/HR overview: settlement for every person in the block.
function AdminSettlementTable({ db, schedule, users }) {
  return (
    <div className="card">
      <h2>📊 Settlement overview (admin)</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Employee</th><th>Worked</th><th>Required</th>
            <th>Vacation taken</th><th>Extra days</th>
            <th>→ Extra vacation</th><th>→ Incentive pay</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const s = settlementFor(db, schedule, u);
            return (
              <tr key={u.id}>
                <td><span className="dot" style={{ background: u.color }} /> {u.name}</td>
                <td>{s.count}</td>
                <td>{s.required}</td>
                <td>{s.charged}</td>
                <td>{s.extra}</td>
                <td>{s.election.vacation}</td>
                <td>{s.election.incentive}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Hour-by-hour week view: each day is a 24h column; shifts render as timed
// blocks colored by employee. Overnight shifts split at midnight and continue
// in the next day's column.
function WeekView({ weekCursor, setWeekCursor, schedule, assignments, openSlots, shiftById, userById, currentUser }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekCursor, i));

  // date -> [{ start, end (minutes), a, st, open, cont }]
  const segs = Object.fromEntries(days.map((d) => [d, []]));
  const push = (date, start, end, item) => {
    if (segs[date]) segs[date].push({ start, end, ...item });
  };
  const addItem = (date, st, item) => {
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
    const laneEnds = [];
    for (const s of list) {
      let lane = laneEnds.findIndex((e) => e <= s.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = s.end;
      s.lane = lane;
    }
    const n = Math.max(1, laneEnds.length);
    list.forEach((s) => { s.lanes = n; });
  }

  const fmtDayHead = (d) => {
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
                  const width = 100 / s.lanes;
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
                        left: `${s.lane * width}%`,
                        width: `calc(${width}% - 3px)`,
                        background: s.open ? undefined : (u ? u.color : '#9ca3af'),
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
