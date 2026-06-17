import { useState } from 'react';
import { api } from '../api';
import { DOW, MONTHS, monthGrid, todayYmd, prettyDate } from '../dates';
import { vacationSummary } from '../shiftMath';
import type { AppState, User } from '../../../shared/types.js';
import type { Act } from '../App';

interface Props { db: AppState; currentUser: User; act: Act; }

export default function Preferences({ db, currentUser, act }: Props) {
  const now = new Date();
  const [cursor, setCursor] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [mode, setMode] = useState('vacation');

  const [year, month] = cursor.split('-').map(Number);
  const weeks = monthGrid(year, month - 1);
  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setCursor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const mine = db.timeOff.filter((t) => t.userId === currentUser.id);
  const myAway = (db.awayTime || []).filter((a) => a.userId === currentUser.id);
  const mineByDate = Object.fromEntries(mine.map((t) => [t.date, t]));
  // Vacation is settled from schedule outcomes: charged when must-off days
  // kept you under your required shifts, earned back via extra-day elections.
  const { used, earned, available } = vacationSummary(db, currentUser, year);
  const mustOffThisYear = mine.filter(
    (t) => t.type === 'vacation' && t.date.startsWith(String(year))
  ).length;

  // Vacation headcount per date across all users, to show full days.
  const vacationPerDay: Record<string, number> = {};
  for (const t of db.timeOff) {
    if (t.type === 'vacation') vacationPerDay[t.date] = (vacationPerDay[t.date] || 0) + 1;
  }

  const today = todayYmd();

  const clickDay = (date: string) => {
    const existing = mineByDate[date];
    if (existing) {
      act(() => api.deleteTimeOff(existing.id));
    } else {
      act(() => api.addTimeOff({ userId: currentUser.id, date, type: mode }));
    }
  };

  return (
    <div>
      {/* Theme */}
      <div className="card">
        <h2>🎨 Theme</h2>
        <div className="seg">
          <button
            className={(!currentUser.theme || currentUser.theme === 'light') ? 'active' : ''}
            onClick={() => act(() => api.updateUser(currentUser.id, { theme: 'light' }))}
          >
            ☀️ Light
          </button>
          <button
            className={currentUser.theme === 'dark' ? 'active' : ''}
            onClick={() => act(() => api.updateUser(currentUser.id, { theme: 'dark' }))}
          >
            🌙 Dark
          </button>
        </div>
      </div>

      {/* Scheduling limits */}
      <div className="card">
        <h2>⏱ Scheduling limits</h2>
        <div className="color-row">
          <label className="stat-label" htmlFor="max-nights">Max overnight shifts in a row</label>
          <input
            id="max-nights"
            className="inline-num"
            type="number" min="1" placeholder="no limit"
            defaultValue={currentUser.maxConsecutiveNights ?? ''}
            onBlur={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value);
              if (v !== (currentUser.maxConsecutiveNights ?? null))
                act(() => api.updateUser(currentUser.id, { maxConsecutiveNights: v }));
            }}
          />
          <span className="muted small">a hard cap — you'll never be scheduled more overnight shifts back-to-back than this</span>
        </div>
      </div>

      {/* Requested days off */}
      <div className="card stats-row">
        <div className="stat">
          <div className="stat-num">{available}</div>
          <div className="stat-label">
            vacation days available in {year}
            {earned > 0 ? ` (incl. ${earned} earned from extra days)` : ''}
          </div>
        </div>
        <div className="stat">
          <div className="stat-num">{used}</div>
          <div className="stat-label">charged by schedules (of {currentUser.vacationDays} base)</div>
        </div>
        <div className="stat">
          <div className="stat-num">{mustOffThisYear}</div>
          <div className="stat-label">must-have-off days requested in {year}</div>
        </div>
        <div className="stat">
          <div className="stat-num">{mine.filter((t) => t.type === 'preferred').length}</div>
          <div className="stat-label">preferred-off days</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="seg">
          <button className={mode === 'vacation' ? 'active' : ''} onClick={() => setMode('vacation')}>
            🚫 Must have off (free up front)
          </button>
          <button className={mode === 'preferred' ? 'active' : ''} onClick={() => setMode('preferred')}>
            🤞 Prefer off (not guaranteed)
          </button>
        </div>
        <span className="muted small">
          Click a day to add a {mode === 'vacation' ? 'must-have-off' : 'preferred-off'} request; click an
          existing one to remove it. Must-have-off days don't use vacation up front — vacation is only
          charged after a schedule if those days keep you under your required shifts. Ask for more
          must-offs than you have vacation days left and they all become "strongly prefer off" instead.
          Max {db.settings.maxVacationPerDay} people may have the same day off.
        </span>
      </div>

      <div className="cal-wrap">
        <div className="cal-nav">
          <button className="btn ghost" onClick={() => shiftMonth(-1)}>‹</button>
          <h2>{MONTHS[month - 1]} {year}</h2>
          <button className="btn ghost" onClick={() => shiftMonth(1)}>›</button>
        </div>
        <div className="cal-grid">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
          {weeks.flat().map((date, i) => {
            if (!date) return <div key={i} className="cal-cell blank" />;
            const req = mineByDate[date];
            const past = date < today;
            const full = (vacationPerDay[date] || 0) >= db.settings.maxVacationPerDay && !req;
            const awayDay = myAway.some((a) => a.start <= date && date <= a.end);
            return (
              <div
                key={i}
                className={`cal-cell clickable ${past ? 'out' : ''} ${req ? `req-${req.type}` : ''}`}
                onClick={() => !past && clickDay(date)}
                title={
                  req
                    ? `${req.type === 'vacation' ? 'Must have off' : 'Preferred off'} — click to remove`
                    : full
                      ? 'This day is full'
                      : ''
                }
              >
                <div className="cal-day">{Number(date.slice(8))}</div>
                {req && (
                  <div className={`chip ${req.type === 'vacation' ? 'chip-vac' : 'chip-pref'}`}>
                    {req.type === 'vacation' ? '🚫 Must off' : '🤞 Prefer off'}
                  </div>
                )}
                {!req && full && <div className="chip chip-full">Day full</div>}
                {awayDay && <div className="chip chip-full">✈️ Away</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scheduled away (read-only) */}
      {myAway.length > 0 && (
        <div className="card">
          <h3 style={{ margin: '0 0 0.5rem' }}>✈️ Scheduled away (set by your manager)</h3>
          <ul className="muted small" style={{ margin: 0 }}>
            {myAway.map((a) => <li key={a.id}>{prettyDate(a.start)} → {prettyDate(a.end)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
