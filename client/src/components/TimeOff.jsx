import React, { useState } from 'react';
import { api } from '../api.js';
import { DOW, MONTHS, monthGrid, todayYmd } from '../dates.js';
import { vacationSummary } from '../shiftMath.js';

export default function TimeOff({ db, currentUser, act }) {
  const now = new Date();
  const [cursor, setCursor] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [mode, setMode] = useState('vacation');

  const [year, month] = cursor.split('-').map(Number);
  const weeks = monthGrid(year, month - 1);
  const shiftMonth = (delta) => {
    const d = new Date(year, month - 1 + delta, 1);
    setCursor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const mine = db.timeOff.filter((t) => t.userId === currentUser.id);
  const mineByDate = Object.fromEntries(mine.map((t) => [t.date, t]));
  // Vacation is settled from schedule outcomes: charged when must-off days
  // kept you under your required shifts, earned back via extra-day elections.
  const { used, earned, available } = vacationSummary(db, currentUser, year);
  const mustOffThisYear = mine.filter(
    (t) => t.type === 'vacation' && t.date.startsWith(String(year))
  ).length;

  // Vacation headcount per date across all users, to show full days.
  const vacationPerDay = {};
  for (const t of db.timeOff) {
    if (t.type === 'vacation') vacationPerDay[t.date] = (vacationPerDay[t.date] || 0) + 1;
  }

  const today = todayYmd();

  const clickDay = (date) => {
    const existing = mineByDate[date];
    if (existing) {
      act(() => api.deleteTimeOff(existing.id));
    } else {
      act(() => api.addTimeOff({ userId: currentUser.id, date, type: mode }));
    }
  };

  return (
    <div>
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
        <div className="stat">
          <label className="stat-label" htmlFor="max-nights">max overnight shifts in a row</label>
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
          <div className="stat-label">a hard cap — you'll never be scheduled more overnight shifts back-to-back than this</div>
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
