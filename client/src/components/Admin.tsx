import { useRef, useState } from 'react';
import { api } from '../api';
import { DOW, MONTHS, formatTime, todayYmd, prettyDate } from '../dates';
import { UNITS, upcomingBlocks, isValidCadence } from '../../../shared/blocks.js';
import RoleMultiSelect from './RoleMultiSelect';
import { safeBg } from '../contrast';
import { versionOf, settingsVersion } from '../versions';
import type { AppState, ShiftType, User, HolidayRecurrence } from '../../../shared/types.js';
import type { Act } from '../App';

interface Props { db: AppState; act: Act; }

export default function Admin({ db, act }: Props) {
  return (
    <div className="admin-grid">
      <ShiftTypes db={db} act={act} />
      <Roster db={db} act={act} />
      <RolesManager db={db} act={act} />
      <Settings db={db} act={act} />
      <GenerateSchedule db={db} act={act} />
      <AwayTimeManager db={db} act={act} />
      <HolidaysManager db={db} act={act} />
    </div>
  );
}

const BLANK_SHIFT = {
  name: '', startTime: '08:00', endTime: '16:00',
  frequency: 'daily', dayOfWeek: 1, staffRequired: 1,
  minRun: '', maxRun: '', weight: '', allowedRoles: [] as string[],
};

// Effective fairness weight shown in the table: an explicit weight wins,
// otherwise the default of 1.
function weightLabel(s: ShiftType) {
  const w = Number(s.weight);
  if (Number.isFinite(w) && w >= 0 && s.weight !== null && s.weight !== undefined) {
    return w === 0 ? '0 (uncounted)' : String(w);
  }
  return '1';
}

function ShiftTypes({ db, act }: Props) {
  const [form, setForm] = useState<any>(BLANK_SHIFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const roleName = (id: string) => db.roles.find((r) => r.id === id)?.name || id;

  const startEdit = (s: ShiftType) => {
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
      minRun: (s.minRun ?? 0) > 1 ? s.minRun : '',
      maxRun: s.maxRun ?? '',
      weight: s.weight ?? '',
      allowedRoles: s.allowedRoles ?? [],
    });
  };
  const cancelEdit = () => { setEditingId(null); setForm(BLANK_SHIFT); };

  const submit = async (e: any) => {
    e.preventDefault();
    const ok = await act(() =>
      editingId
        ? api.updateShiftType(editingId, { ...form, expectedVersion: versionOf('shiftTypes', editingId) })
        : api.addShiftType(form)
    );
    if (ok) cancelEdit();
  };

  return (
    <section className="card">
      <h2>⏰ Shift Types</h2>
      <p className="muted small">Each shift type repeats on its frequency and needs the listed headcount every occurrence.</p>
      {db.shiftTypes.length > 0 && (
        <table className="table">
          <thead><tr><th>Name</th><th>Time</th><th>Repeats</th><th>People</th><th title="Consecutive days one person stays on this shift type">Run</th><th title="Fairness weight: how much one of these shifts counts toward someone's load and shift count. 0 = standby duty that doesn't count at all.">Weight</th><th>Roles</th><th /></tr></thead>
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
                <td>{s.frequency === 'daily' ? 'Every day' : `Weekly (${DOW[s.dayOfWeek ?? 0]})`}</td>
                <td>{s.staffRequired}</td>
                <td>{runLabel(s)}</td>
                <td>{weightLabel(s)}</td>
                <td>{s.allowedRoles && s.allowedRoles.length ? s.allowedRoles.map(roleName).join(', ') : 'Anyone'}</td>
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
        <div className="role-pick">
          <span className="muted small">Roles that can fill this shift</span>
          <RoleMultiSelect
            roles={db.roles}
            selected={form.allowedRoles || []}
            onChange={(next) => setForm((prev: any) => ({ ...prev, allowedRoles: next }))}
            placeholder="Anyone (add roles to restrict)…"
          />
          <span className="muted small">None selected = anyone can fill it.</span>
        </div>
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

function runLabel(s: ShiftType) {
  const min = Number(s.minRun) || 1;
  const max = Number(s.maxRun);
  const hasMax = Number.isFinite(max) && max >= 1;
  if (min <= 1 && !hasMax) return '—';
  if (hasMax) return min === max ? `${min}` : `${min}–${max}`;
  return `${min}+`;
}

function standingClass(s: number | null | undefined) {
  if (s === undefined || s === null) return '';
  if (s < 0.8) return 'standing-low';
  if (s > 1.1) return 'standing-high';
  return '';
}

function Roster({ db, act }: Props) {
  const [form, setForm] = useState<any>({ firstName: '', lastName: '', email: '', employeeId: '', vacationDays: 10, startDate: '' });
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  // When email delivery isn't configured (dev default), the server returns
  // the invite link so the admin can hand it over manually.
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const inviteInputRef = useRef<HTMLInputElement>(null);

  const copyInvite = () => {
    if (!inviteLink) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(inviteLink).catch(() => inviteInputRef.current?.select());
    } else {
      inviteInputRef.current?.select();
    }
  };

  const submit = async (e: any) => {
    e.preventDefault();
    setInviteLink(null);
    const ok = await act(async () => {
      const r = await api.addUser(form);
      if (r.inviteLink) setInviteLink(r.inviteLink);
      return r;
    });
    if (ok) setForm({ ...form, firstName: '', lastName: '', email: '', employeeId: '' });
  };

  const resend = (u: User) => {
    setInviteLink(null);
    act(async () => {
      const r = await api.resendInvite(u.id);
      if (r.inviteLink) setInviteLink(r.inviteLink);
      return r;
    });
  };

  const addDisabled = !form.firstName.trim() || !form.lastName.trim() || !form.email.trim();

  const yearNow = new Date().getFullYear();
  const usedFor = (u: User) =>
    db.timeOff.filter(
      (t) => t.userId === u.id && t.type === 'vacation' && t.date.startsWith(String(yearNow))
    ).length;

  return (
    <section className="card">
      <h2>👥 Roster</h2>
      <table className="table">
        <thead><tr><th>Employee</th><th>Roles</th><th>Vacation days / yr</th><th>Used ({yearNow})</th><th>Required / block</th><th title="Hard cap on this person's shifts per schedule block. Blank = unlimited (no cap).">Max / block</th><th title="Preference standing: 1.00 is neutral. Drops when someone consistently asks for more preferred days off than the roster norm; recovers after a few normal blocks. Read-only.">Pref standing</th><th>Start date</th><th /></tr></thead>
        <tbody>
          {db.users.map((u) => (
            <tr key={u.id}>
              <td>
                <span className="dot" style={{ background: safeBg(u.color) }} /> {u.name}
                {u.registered === false && (
                  <span className="badge-pending" title="Has not set a password yet">Pending</span>
                )}
                {u.email && <div className="muted small">{u.email}</div>}
                {u.registered === false && (
                  <button className="btn ghost sm" type="button" onClick={() => resend(u)}>
                    Resend invite
                  </button>
                )}
              </td>
              <td>
                <RoleMultiSelect
                  roles={db.roles}
                  selected={u.roles || []}
                  lockedIds={['role-employee']}
                  onChange={(next) => { act(() => api.updateUser(u.id, { roles: next, expectedVersion: versionOf('users', u.id) })); }}
                />
              </td>
              <td>
                <input
                  className="inline-num"
                  type="number" min="0" defaultValue={u.vacationDays}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v !== u.vacationDays) act(() => api.updateUser(u.id, { vacationDays: v, expectedVersion: versionOf('users', u.id) }));
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
                      act(() => api.updateUser(u.id, { requiredShifts: v, expectedVersion: versionOf('users', u.id) }));
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
                      act(() => api.updateUser(u.id, { maxShiftsOverride: v, expectedVersion: versionOf('users', u.id) }));
                  }}
                />
              </td>
              <td className={standingClass(db.preferenceStandings?.[u.id])}>
                {(db.preferenceStandings?.[u.id] ?? 1).toFixed(2)}
              </td>
              <td>
                <input
                  className="inline-num"
                  type="date"
                  defaultValue={u.startDate ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value || null;
                    if (v !== (u.startDate ?? null)) act(() => api.updateUser(u.id, { startDate: v, expectedVersion: versionOf('users', u.id) }));
                  }}
                />
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
        <label>First name<input required value={form.firstName} onChange={set('firstName')} placeholder="Jane" /></label>
        <label>Last name<input required value={form.lastName} onChange={set('lastName')} placeholder="Smith" /></label>
        <label>Email<input type="email" required value={form.email} onChange={set('email')} placeholder="jane@example.com" /></label>
        <label>Employee ID (optional)<input value={form.employeeId} onChange={set('employeeId')} placeholder="—" /></label>
        <label>Vacation days / year<input type="number" min="0" value={form.vacationDays} onChange={set('vacationDays')} /></label>
        <label>Start date<input type="date" value={form.startDate} onChange={set('startDate')} /></label>
        <button className="btn primary" type="submit" disabled={addDisabled}>Add to roster</button>
      </form>
      {inviteLink && (
        <div className="muted small" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>Invite link (email not configured — share it manually):</span>
          <input
            ref={inviteInputRef}
            readOnly
            value={inviteLink}
            style={{ flex: 1, minWidth: 220 }}
            onFocus={(e) => e.target.select()}
          />
          <button className="btn ghost sm" type="button" onClick={copyInvite}>Copy</button>
          <button className="btn ghost sm" type="button" title="Dismiss" onClick={() => setInviteLink(null)}>✕</button>
        </div>
      )}
    </section>
  );
}

function Settings({ db, act }: Props) {
  const existingCadence = db.settings.cadence;
  const [cadenceForm, setCadenceForm] = useState<any>(() => ({
    lengthValue: existingCadence?.lengthValue ?? 2,
    lengthUnit: existingCadence?.lengthUnit ?? 'weeks',
    anchorDate: existingCadence?.anchorDate ?? todayYmd(),
  }));
  const [cadenceError, setCadenceError] = useState<string | null>(null);
  const setC = (k: string) => (e: any) => setCadenceForm((prev: any) => ({ ...prev, [k]: e.target.value }));

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
    await act(() => api.updateSettings({ cadence: payload, expectedVersion: settingsVersion() }));
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
              act(() => api.updateSettings({ maxVacationPerDay: v, expectedVersion: settingsVersion() }));
          }}
        />
      </label>
      <p className="muted small">
        Once this many people have claimed vacation on a date, further vacation requests for that date are rejected.
      </p>
      <label className="row">
        Holidays required per year
        <input
          className="inline-num"
          type="number" min="0" defaultValue={db.settings.holidaysRequiredPerYear ?? 0}
          onBlur={(e) => {
            const v = Math.max(0, Number(e.target.value) || 0);
            if (v !== (db.settings.holidaysRequiredPerYear ?? 0))
              act(() => api.updateSettings({ holidaysRequiredPerYear: v, expectedVersion: settingsVersion() }));
          }}
        />
      </label>
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

function AwayTimeManager({ db, act }: Props) {
  const [userId, setUserId] = useState(db.users[0]?.id || '');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const ranges = (db.awayTime || []).filter((a) => a.userId === userId);

  const add = async () => {
    if (!start || !end) return;
    const ok = await act(() => api.addAwayTime({ userId, start, end }));
    if (ok) { setStart(''); setEnd(''); }
  };

  return (
    <section className="card">
      <h2>🏝️ Away time</h2>
      <p className="muted small">
        Date ranges when an employee can't be scheduled at all. This does not use any vacation.
      </p>
      <label>Employee
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          {db.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
      {ranges.length > 0 ? (
        <table className="table">
          <thead><tr><th>From</th><th>To</th><th /></tr></thead>
          <tbody>
            {ranges.map((a) => (
              <tr key={a.id}>
                <td>
                  <input className="inline-num" type="date" defaultValue={a.start}
                    onBlur={(e) => { const v = e.target.value; if (v && v !== a.start) act(() => api.updateAwayTime(a.id, { start: v, expectedVersion: versionOf('awayTime', a.id) })); }} />
                </td>
                <td>
                  <input className="inline-num" type="date" defaultValue={a.end}
                    onBlur={(e) => { const v = e.target.value; if (v && v !== a.end) act(() => api.updateAwayTime(a.id, { end: v, expectedVersion: versionOf('awayTime', a.id) })); }} />
                </td>
                <td className="row-actions">
                  <button className="btn danger ghost sm" title="Remove away time" onClick={() => act(() => api.deleteAwayTime(a.id))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No away time set for this employee.</p>
      )}
      <div className="form-grid">
        <label>From<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>To<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <button className="btn primary" onClick={add} disabled={!start || !end || end < start}>Add away time</button>
      </div>
    </section>
  );
}

// Ordinals an "Nth weekday" holiday can pick (no explicit 5th; -1 = last).
const ORDINALS: { value: number; label: string }[] = [
  { value: 1, label: '1st' }, { value: 2, label: '2nd' }, { value: 3, label: '3rd' },
  { value: 4, label: '4th' }, { value: -1, label: 'Last' },
];

// Human-readable recurrence summary, e.g. "Every Dec 25", "4th Thu of Nov",
// "Last Mon of May", "One-off · Sat, Jul 4, 2026".
function describeRecurrence(r: HolidayRecurrence): string {
  if (r.type === 'one-off') return `One-off · ${prettyDate(r.date)}`;
  if (r.type === 'yearly') return `Every ${MONTHS[r.month - 1].slice(0, 3)} ${r.day}`;
  const ord = ORDINALS.find((o) => o.value === r.ordinal)?.label ?? String(r.ordinal);
  return `${ord} ${DOW[r.weekday]} of ${MONTHS[r.month - 1].slice(0, 3)}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// The recurrence editor: a type select plus the inputs that type needs. Emits a
// complete HolidayRecurrence via onChange; reused by the add form and each row.
function RecurrenceFields({ value, onChange }: { value: HolidayRecurrence; onChange: (r: HolidayRecurrence) => void }) {
  const refYear = new Date().getFullYear();
  const setType = (type: string) => {
    const now = new Date();
    if (type === 'yearly') onChange({ type: 'yearly', month: now.getMonth() + 1, day: now.getDate() });
    else if (type === 'nth-weekday') onChange({ type: 'nth-weekday', month: now.getMonth() + 1, weekday: 1, ordinal: 1 });
    else onChange({ type: 'one-off', date: todayYmd() });
  };
  return (
    <div className="form-grid">
      <label>Repeats
        <select value={value.type} onChange={(e) => setType(e.target.value)}>
          <option value="yearly">Every year · same date</option>
          <option value="nth-weekday">Every year · weekday rule</option>
          <option value="one-off">One-off (this year)</option>
        </select>
      </label>
      {value.type === 'yearly' && (
        <label>Date
          <input type="date" value={`${refYear}-${pad2(value.month)}-${pad2(value.day)}`}
            onChange={(e) => {
              const [, m, d] = e.target.value.split('-').map(Number);
              if (m && d) onChange({ type: 'yearly', month: m, day: d });
            }} />
        </label>
      )}
      {value.type === 'nth-weekday' && (
        <>
          <label>Which
            <select value={value.ordinal} onChange={(e) => onChange({ ...value, ordinal: Number(e.target.value) })}>
              {ORDINALS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>Weekday
            <select value={value.weekday} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>
              {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </label>
          <label>Month
            <select value={value.month} onChange={(e) => onChange({ ...value, month: Number(e.target.value) })}>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </label>
        </>
      )}
      {value.type === 'one-off' && (
        <label>Date
          <input type="date" value={value.date}
            onChange={(e) => { if (e.target.value) onChange({ type: 'one-off', date: e.target.value }); }} />
        </label>
      )}
    </div>
  );
}

function HolidaysManager({ db, act }: Props) {
  const [name, setName] = useState('');
  const [workable, setWorkable] = useState(false);
  const [recurrence, setRecurrence] = useState<HolidayRecurrence>(() => {
    const now = new Date();
    return { type: 'yearly', month: now.getMonth() + 1, day: now.getDate() };
  });
  const holidays = db.holidays || [];

  const add = async () => {
    if (!name) return;
    const ok = await act(() => api.addHoliday({ name, workable, recurrence }));
    if (ok) { setName(''); setWorkable(false); }
  };

  return (
    <section className="card">
      <h2>🎉 Holidays</h2>
      <p className="muted small">
        Days the organization treats as holidays. A non-workable holiday means the business
        is closed and no shifts are scheduled; a workable holiday is staffed and counts toward
        each employee's required holidays per year. Holidays repeat every year by default.
      </p>
      {holidays.length > 0 ? (
        <table className="table">
          <thead><tr><th>Name</th><th>Repeats</th><th>Workable</th><th /></tr></thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.id}>
                <td>
                  <input className="inline-num" type="text" defaultValue={h.name}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== h.name) act(() => api.updateHoliday(h.id, { name: v, expectedVersion: versionOf('holidays', h.id) })); }} />
                </td>
                <td>
                  <div className="muted small" style={{ marginBottom: 4 }}>{describeRecurrence(h.recurrence)}</div>
                  <RecurrenceFields value={h.recurrence} onChange={(r) => act(() => api.updateHoliday(h.id, { recurrence: r, expectedVersion: versionOf('holidays', h.id) }))} />
                </td>
                <td>
                  <input type="checkbox" checked={h.workable}
                    onChange={(e) => { const workable = e.target.checked; act(() => api.updateHoliday(h.id, { workable, expectedVersion: versionOf('holidays', h.id) })); }} />
                </td>
                <td className="row-actions">
                  <button className="btn danger ghost sm" title="Remove holiday" onClick={() => act(() => api.deleteHoliday(h.id))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No holidays set.</p>
      )}
      <div className="form-grid holiday-add">
        <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Christmas" /></label>
        <RecurrenceFields value={recurrence} onChange={setRecurrence} />
        <label className="row" style={{ alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={workable} onChange={(e) => setWorkable(e.target.checked)} /> Workable
        </label>
        <button className="btn primary" onClick={add} disabled={!name}>Add holiday</button>
      </div>
    </section>
  );
}

function RolesManager({ db, act }: Props) {
  const [name, setName] = useState('');
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    const ok = await act(() => api.addRole({ name: n }));
    if (ok) setName('');
  };
  return (
    <section className="card">
      <h2>🏷️ Roles</h2>
      <p className="muted small">
        Capability tags. Assign them to employees in the roster and to shifts in Shift Types.
        Admin and Employee are built-in and can't be renamed or deleted.
      </p>
      <table className="table">
        <thead><tr><th>Role</th><th /></tr></thead>
        <tbody>
          {db.roles.map((r) => (
            <tr key={r.id}>
              <td>
                {r.system ? (
                  <span>{r.name} <span className="muted small">(system)</span></span>
                ) : (
                  <input
                    className="inline-num"
                    defaultValue={r.name}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== r.name) act(() => api.updateRole(r.id, { name: v, expectedVersion: versionOf('roles', r.id) }));
                    }}
                  />
                )}
              </td>
              <td className="row-actions">
                {!r.system && (
                  <button
                    className="btn danger ghost sm"
                    title="Delete role"
                    onClick={() => {
                      if (confirm(`Delete the "${r.name}" role? It will be removed from all employees and shifts.`))
                        act(() => api.deleteRole(r.id));
                    }}
                  >✕</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label>New role<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Manager" /></label>
        <button className="btn primary" type="submit">Add role</button>
      </form>
    </section>
  );
}

function GenerateSchedule({ db, act }: Props) {
  const cadence = db.settings.cadence;
  const blocks = cadence ? upcomingBlocks(cadence, todayYmd(), 5) : [];
  const [form, setForm] = useState<any>(() => ({
    blockIndex: blocks.length > 0 ? blocks[0].index : 0,
  }));
  const set = (k: string) => (e: any) => setForm((prev: any) => ({ ...prev, [k]: e.target.value }));
  const [busy, setBusy] = useState(false);
  // Everyone is in the block by default; the admin unchecks people (any role,
  // manager included) who shouldn't be scheduled.
  const [included, setIncluded] = useState(() => new Set<string>(db.users.map((u) => u.id)));
  const toggle = (id: string) => {
    const next = new Set(included);
    next.has(id) ? next.delete(id) : next.add(id);
    setIncluded(next);
  };

  const submit = async (e: any) => {
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
        avoided when coverage allows; each employee is pushed toward their required shift count (set per
        person in the roster).
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
                <span className="dot" style={{ background: safeBg(u.color) }} /> {u.name}
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
