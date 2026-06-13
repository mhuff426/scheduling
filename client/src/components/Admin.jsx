import React, { useState } from 'react';
import { api } from '../api.js';
import { DOW, formatTime, todayYmd, prettyDate } from '../dates.js';
import { UNITS, upcomingBlocks, isValidCadence } from '../../../shared/blocks.js';

export default function Admin({ db, act }) {
  return (
    <div className="admin-grid">
      <ShiftTypes db={db} act={act} />
      <Roster db={db} act={act} />
      <Settings db={db} act={act} />
      <GenerateSchedule db={db} act={act} />
    </div>
  );
}

const BLANK_SHIFT = {
  name: '', startTime: '08:00', endTime: '16:00',
  frequency: 'daily', dayOfWeek: 1, staffRequired: 1,
  minRun: '', maxRun: '', weight: '',
};

const isOvernightShift = (s) => s.endTime <= s.startTime && s.endTime !== '00:00';

// Effective fairness weight shown in the table: explicit weight wins, else
// the overnight default from settings, else 1.
function weightLabel(s, settings) {
  const w = Number(s.weight);
  if (Number.isFinite(w) && w >= 0 && s.weight !== null && s.weight !== undefined) {
    return w === 0 ? '0 (uncounted)' : String(w);
  }
  return isOvernightShift(s) ? `${settings.overnightWeight ?? 1.5} (auto 🌙)` : '1';
}

function ShiftTypes({ db, act }) {
  const [form, setForm] = useState(BLANK_SHIFT);
  const [editingId, setEditingId] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      startTime: s.startTime,
      endTime: s.endTime,
      frequency: s.frequency,
      dayOfWeek: s.dayOfWeek ?? 1,
      staffRequired: s.staffRequired,
      // Show blank rather than the implicit "1" default so the form keeps its
      // "blank = no grouping" meaning.
      minRun: s.minRun > 1 ? s.minRun : '',
      maxRun: s.maxRun ?? '',
      weight: s.weight ?? '',
    });
  };
  const cancelEdit = () => { setEditingId(null); setForm(BLANK_SHIFT); };

  const submit = async (e) => {
    e.preventDefault();
    const ok = await act(() =>
      editingId ? api.updateShiftType(editingId, form) : api.addShiftType(form)
    );
    if (ok) cancelEdit();
  };

  return (
    <section className="card">
      <h2>⏰ Shift Types</h2>
      <p className="muted small">Each shift type repeats on its frequency and needs the listed headcount every occurrence.</p>
      {db.shiftTypes.length > 0 && (
        <table className="table">
          <thead><tr><th>Name</th><th>Time</th><th>Repeats</th><th>People</th><th title="Consecutive days one person stays on this shift type">Run</th><th title="Fairness weight: how much one of these shifts counts toward someone's load and shift count. 0 = standby duty that doesn't count at all.">Weight</th><th /></tr></thead>
          <tbody>
            {db.shiftTypes.map((s) => (
              <tr key={s.id} className={editingId === s.id ? 'row-editing' : ''}>
                <td>{s.name}</td>
                <td>
                  {formatTime(s.startTime)} – {formatTime(s.endTime)}
                  {s.endTime <= s.startTime && s.endTime !== '00:00' && (
                    <span title="Overnight — weighted higher for fairness"> 🌙</span>
                  )}
                </td>
                <td>{s.frequency === 'daily' ? 'Every day' : `Weekly (${DOW[s.dayOfWeek]})`}</td>
                <td>{s.staffRequired}</td>
                <td>{runLabel(s)}</td>
                <td>{weightLabel(s, db.settings)}</td>
                <td className="row-actions">
                  <button className="btn ghost sm" onClick={() => startEdit(s)}>Edit</button>
                  <button
                    className="btn danger ghost sm"
                    title="Delete shift type"
                    onClick={() => {
                      if (confirm(`Delete the "${s.name}" shift type?`)) act(() => api.deleteShiftType(s.id));
                    }}
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editingId && (
        <p className="muted small editing-note">✏️ Editing an existing shift type. Changes apply to its name, times, and rules everywhere it appears.</p>
      )}
      <form onSubmit={submit} className="form-grid">
        <label>Name<input required value={form.name} onChange={set('name')} placeholder="Day shift" /></label>
        <label>Start<input type="time" required value={form.startTime} onChange={set('startTime')} /></label>
        <label>End<input type="time" required value={form.endTime} onChange={set('endTime')} /></label>
        <label>Frequency
          <select value={form.frequency} onChange={set('frequency')}>
            <option value="daily">Every 24 hours (daily)</option>
            <option value="weekly">Every week</option>
          </select>
        </label>
        {form.frequency === 'weekly' && (
          <label>Day of week
            <select value={form.dayOfWeek} onChange={set('dayOfWeek')}>
              {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </label>
        )}
        <label>People needed<input type="number" min="1" value={form.staffRequired} onChange={set('staffRequired')} /></label>
        <label title="Aim to keep one person on this shift this many days in a row. Blank = no grouping.">
          Min run (days)<input type="number" min="1" value={form.minRun} onChange={set('minRun')} placeholder="—" />
        </label>
        <label title="Force a switch after this many consecutive days. Blank = no cap.">
          Max run (days)<input type="number" min="1" value={form.maxRun} onChange={set('maxRun')} placeholder="—" />
        </label>
        <label title="How much one of these shifts counts when balancing workload. Blank = automatic (1, or the overnight default). 0 = standby/backup duty: still scheduled and blocks the day, but doesn't count toward minimums, maximums, or load.">
          Weight<input type="number" min="0" step="0.1" value={form.weight} onChange={set('weight')} placeholder="auto" />
        </label>
        <button className="btn primary" type="submit">{editingId ? 'Save changes' : 'Add shift type'}</button>
        {editingId && <button className="btn ghost" type="button" onClick={cancelEdit}>Cancel</button>}
      </form>
      <p className="muted small">
        Overnight shifts are fine — an end time at or before the start time rolls to the next day.
        Set a run range (e.g. 5–7) to keep the same person on a shift several days running; the work
        still rotates across the team between runs. Leave blank for no grouping.
      </p>
    </section>
  );
}

function runLabel(s) {
  const min = Number(s.minRun) || 1;
  const max = Number(s.maxRun);
  const hasMax = Number.isFinite(max) && max >= 1;
  if (min <= 1 && !hasMax) return '—';
  if (hasMax) return min === max ? `${min}` : `${min}–${max}`;
  return `${min}+`;
}

function standingClass(s) {
  if (s === undefined || s === null) return '';
  if (s < 0.8) return 'standing-low';
  if (s > 1.1) return 'standing-high';
  return '';
}

function Roster({ db, act }) {
  const [form, setForm] = useState({ name: '', role: 'employee', vacationDays: 10 });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await act(() => api.addUser(form));
    if (ok) setForm({ ...form, name: '' });
  };

  const yearNow = new Date().getFullYear();
  const usedFor = (u) =>
    db.timeOff.filter(
      (t) => t.userId === u.id && t.type === 'vacation' && t.date.startsWith(String(yearNow))
    ).length;

  return (
    <section className="card">
      <h2>👥 Roster</h2>
      <table className="table">
        <thead><tr><th>Employee</th><th>Role</th><th>Vacation days / yr</th><th>Used ({yearNow})</th><th>Required / block</th><th title="Hard cap on this person's shifts per schedule block. Blank = unlimited (no cap).">Max / block</th><th title="Preference standing: 1.00 is neutral. Drops when someone consistently asks for more preferred days off than the roster norm; recovers after a few normal blocks. Read-only.">Pref standing</th><th /></tr></thead>
        <tbody>
          {db.users.map((u) => (
            <tr key={u.id}>
              <td><span className="dot" style={{ background: u.color }} /> {u.name}</td>
              <td>
                <select
                  value={u.role}
                  onChange={(e) => act(() => api.updateUser(u.id, { role: e.target.value }))}
                >
                  <option value="employee">Employee</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td>
                <input
                  className="inline-num"
                  type="number" min="0" defaultValue={u.vacationDays}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v !== u.vacationDays) act(() => api.updateUser(u.id, { vacationDays: v }));
                  }}
                />
              </td>
              <td>{usedFor(u)}</td>
              <td>
                <input
                  className="inline-num"
                  type="number" min="0" placeholder="—"
                  defaultValue={u.requiredShifts ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value);
                    if (v !== (u.requiredShifts ?? null))
                      act(() => api.updateUser(u.id, { requiredShifts: v }));
                  }}
                />
              </td>
              <td>
                <input
                  className="inline-num"
                  type="number" min="1" placeholder="—"
                  defaultValue={u.maxShiftsOverride ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value);
                    if (v !== (u.maxShiftsOverride ?? null))
                      act(() => api.updateUser(u.id, { maxShiftsOverride: v }));
                  }}
                />
              </td>
              <td className={standingClass(db.preferenceStandings?.[u.id])}>
                {(db.preferenceStandings?.[u.id] ?? 1).toFixed(2)}
              </td>
              <td>
                <button
                  className="btn danger ghost sm"
                  onClick={() => {
                    if (confirm(`Remove ${u.name} from the roster? Their time-off requests will be deleted.`))
                      act(() => api.deleteUser(u.id));
                  }}
                >✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={submit} className="form-grid">
        <label>Name<input required value={form.name} onChange={set('name')} placeholder="Jane Smith" /></label>
        <label>Role
          <select value={form.role} onChange={set('role')}>
            <option value="employee">Employee</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>Vacation days / year<input type="number" min="0" value={form.vacationDays} onChange={set('vacationDays')} /></label>
        <button className="btn primary" type="submit">Add to roster</button>
      </form>
    </section>
  );
}

function Settings({ db, act }) {
  const existingCadence = db.settings.cadence;
  const [cadenceForm, setCadenceForm] = useState(() => ({
    lengthValue: existingCadence?.lengthValue ?? 2,
    lengthUnit: existingCadence?.lengthUnit ?? 'weeks',
    anchorDate: existingCadence?.anchorDate ?? todayYmd(),
  }));
  const [cadenceError, setCadenceError] = useState(null);
  const setC = (k) => (e) => setCadenceForm((prev) => ({ ...prev, [k]: e.target.value }));

  const saveCadence = async () => {
    setCadenceError(null);
    const payload = {
      anchorDate: cadenceForm.anchorDate,
      lengthUnit: cadenceForm.lengthUnit,
      lengthValue: Number(cadenceForm.lengthValue),
    };
    if (!isValidCadence(payload)) {
      setCadenceError('Please enter a valid anchor date, a whole number ≥ 1, and a unit.');
      return;
    }
    if (existingCadence && payload.anchorDate <= todayYmd()) {
      setCadenceError('A new schedule start date must be in the future.');
      return;
    }
    if (!existingCadence && payload.anchorDate < todayYmd()) {
      setCadenceError('The schedule start date cannot be in the past.');
      return;
    }
    await act(() => api.updateSettings({ cadence: payload }));
  };

  const cadenceSaveDisabled =
    (existingCadence && cadenceForm.anchorDate <= todayYmd()) ||
    (!existingCadence && cadenceForm.anchorDate < todayYmd()) ||
    !cadenceForm.anchorDate ||
    Number(cadenceForm.lengthValue) < 1;

  return (
    <section className="card">
      <h2>⚙️ Settings</h2>
      <label className="row">
        Max people on vacation per day
        <input
          className="inline-num"
          type="number" min="1" defaultValue={db.settings.maxVacationPerDay}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v !== db.settings.maxVacationPerDay)
              act(() => api.updateSettings({ maxVacationPerDay: v }));
          }}
        />
      </label>
      <p className="muted small">
        Once this many people have claimed vacation on a date, further vacation requests for that date are rejected.
      </p>
      <label className="row">
        Overnight shift weight
        <input
          className="inline-num"
          type="number" min="1" step="0.1" defaultValue={db.settings.overnightWeight}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v !== db.settings.overnightWeight)
              act(() => api.updateSettings({ overnightWeight: v }));
          }}
        />
      </label>
      <p className="muted small">
        Default weight for overnight shifts (🌙 crosses midnight) that don't set their own weight in
        Shift Types. 1 = same as any shift; 1.5 = one overnight ≈ a shift and a half. A per-shift-type
        weight always wins over this default. Overnights are also spread evenly head-for-head.
      </p>
      <h3 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Schedule cadence</h3>
      {existingCadence && (
        <p className="muted small">
          Currently: every {existingCadence.lengthValue} {existingCadence.lengthUnit}, anchored {existingCadence.anchorDate}
        </p>
      )}
      <div className="form-grid">
        <label>
          Length
          <input
            type="number" min="1" step="1"
            value={cadenceForm.lengthValue}
            onChange={setC('lengthValue')}
          />
        </label>
        <label>
          Unit
          <select value={cadenceForm.lengthUnit} onChange={setC('lengthUnit')}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label>
          Anchor start date
          <input
            type="date"
            value={cadenceForm.anchorDate}
            onChange={setC('anchorDate')}
          />
        </label>
      </div>
      {cadenceError && <p className="muted small" style={{ color: 'var(--color-danger, red)' }}>{cadenceError}</p>}
      <button
        className="btn primary"
        style={{ marginTop: '0.5rem' }}
        disabled={cadenceSaveDisabled}
        onClick={saveCadence}
      >
        Save cadence
      </button>
      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        Changing the cadence does not affect schedules already generated.
        {existingCadence ? ' Updating the anchor date requires a strictly-future date.' : ''}
      </p>
    </section>
  );
}

function GenerateSchedule({ db, act }) {
  const cadence = db.settings.cadence;
  const blocks = cadence ? upcomingBlocks(cadence, todayYmd(), 5) : [];
  const [form, setForm] = useState(() => ({
    blockIndex: blocks.length > 0 ? blocks[0].index : 0,
  }));
  const set = (k) => (e) => setForm((prev) => ({ ...prev, [k]: e.target.value }));
  const [busy, setBusy] = useState(false);
  // Everyone is in the block by default; the admin unchecks people (any role,
  // manager included) who shouldn't be scheduled.
  const [included, setIncluded] = useState(() => new Set(db.users.map((u) => u.id)));
  const toggle = (id) => {
    const next = new Set(included);
    next.has(id) ? next.delete(id) : next.add(id);
    setIncluded(next);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await act(() => api.createSchedule({
      blockIndex: Number(form.blockIndex),
      userIds: [...included],
    }));
    setBusy(false);
  };

  return (
    <section className="card">
      <h2>✨ Generate Schedule</h2>
      <p className="muted small">
        Fills every shift in the range. Vacation days are never scheduled over; preferred-off days are
        avoided when coverage allows; everyone is pushed toward the minimum shift count.
      </p>
      {!cadence ? (
        <p className="muted small">Set a schedule cadence in Settings first.</p>
      ) : (
        <form onSubmit={submit}>
          <div className="form-grid">
            <label>
              Schedule block
              <select value={form.blockIndex} onChange={set('blockIndex')}>
                {blocks.map((b) => {
                  const alreadyGenerated = db.schedules.some((s) => s.startDate === b.startDate);
                  return (
                    <option key={b.index} value={b.index} disabled={alreadyGenerated}>
                      {prettyDate(b.startDate)} → {prettyDate(b.endDate)}{alreadyGenerated ? ' — already generated' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
          <div className="include-list">
            <div className="muted small" style={{ width: '100%' }}>Who can be scheduled in this block:</div>
            {db.users.map((u) => (
              <label key={u.id} className="include-item">
                <input
                  type="checkbox"
                  checked={included.has(u.id)}
                  onChange={() => toggle(u.id)}
                />
                <span className="dot" style={{ background: u.color }} /> {u.name}
              </label>
            ))}
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Generating…' : 'Generate schedule'}
          </button>
        </form>
      )}
      {db.schedules.length > 0 && (
        <p className="muted small">{db.schedules.length} schedule{db.schedules.length > 1 ? 's' : ''} created so far — view them on the Schedule tab.</p>
      )}
    </section>
  );
}
