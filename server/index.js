import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadDb, saveDb, newId, vacationCountForDate } from './db.js';
import {
  generateSchedule, summarizeSchedule, preferenceStandings,
  effectiveMaximums, weightOf,
} from './scheduler.js';
import {
  canTakeShift, createTrade, respondToOpenTrade, withdrawResponse,
  acceptOpenResponse, acceptDirect, rejectDirect, claimGiveaway, cancelTrade,
  setExtraElection, tradeOptions, swapPartners,
} from './trades.js';
import { buildIcs } from './ics.js';
import { isValidCadence, blockRange, currentBlockIndex, todayYmd } from '../shared/blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#84cc16',
  '#06b6d4', '#f43f5e', '#8b5cf6', '#10b981', '#d97706',
];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || '');

// ---- whole app state (small dataset; one fetch keeps the client simple) ----
app.get('/api/state', (req, res) => {
  const db = loadDb();
  // Derived, never persisted or editable — shown only in the admin roster UI.
  res.json({ ...db, preferenceStandings: preferenceStandings(db) });
});

// ---- roster ----
app.post('/api/users', (req, res) => {
  const db = loadDb();
  const { name, role, vacationDays } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const user = {
    id: newId('u'),
    name: name.trim(),
    role: role === 'admin' ? 'admin' : 'employee',
    vacationDays: Math.max(0, Number(vacationDays) || 0),
    color: PALETTE[db.users.length % PALETTE.length],
  };
  db.users.push(user);
  saveDb();
  res.json(user);
});

const isLastAdmin = (db, user) =>
  user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length === 1;

app.put('/api/users/:id', (req, res) => {
  const db = loadDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { name, role, vacationDays } = req.body;
  if (name !== undefined) user.name = String(name).trim() || user.name;
  if (role !== undefined) {
    const newRole = role === 'admin' ? 'admin' : 'employee';
    if (newRole === 'employee' && isLastAdmin(db, user)) {
      return res.status(400).json({
        error: `${user.name} is the only admin. Make someone else an admin first.`,
      });
    }
    user.role = newRole;
  }
  if (vacationDays !== undefined) user.vacationDays = Math.max(0, Number(vacationDays) || 0);
  if (req.body.desiredShifts !== undefined) {
    const d = req.body.desiredShifts;
    user.desiredShifts = d === null || d === '' ? null : Math.max(0, Number(d) || 0);
  }
  if (req.body.maxConsecutiveNights !== undefined) {
    const n = req.body.maxConsecutiveNights;
    user.maxConsecutiveNights = n === null || n === '' ? null : Math.max(1, Number(n) || 1);
  }
  if (req.body.maxShiftsOverride !== undefined) {
    const n = req.body.maxShiftsOverride;
    user.maxShiftsOverride = n === null || n === '' ? null : Math.max(1, Number(n) || 1);
  }
  saveDb();
  res.json(user);
});

app.delete('/api/users/:id', (req, res) => {
  const db = loadDb();
  const idx = db.users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found.' });
  if (isLastAdmin(db, db.users[idx])) {
    return res.status(400).json({
      error: `${db.users[idx].name} is the only admin and can't be removed. Make someone else an admin first.`,
    });
  }
  db.users.splice(idx, 1);
  db.timeOff = db.timeOff.filter((t) => t.userId !== req.params.id);
  saveDb();
  res.json({ ok: true });
});

// ---- shift types ----
// Validate and normalize the shift-type fields shared by create and edit.
// Returns { error } on failure or { fields } on success.
function parseShiftType(body) {
  const { name, startTime, endTime, frequency, dayOfWeek, staffRequired, minRun, maxRun, weight } = body;
  if (!name || !name.trim()) return { error: 'Shift name is required.' };
  if (!isTime(startTime) || !isTime(endTime))
    return { error: 'Start and end times are required (HH:MM).' };
  const freq = frequency === 'weekly' ? 'weekly' : 'daily';
  // Run target: a person stays on this shift type between minRun and maxRun
  // consecutive days. Blank = no grouping (min 1, no max).
  const min = Math.max(1, Number(minRun) || 1);
  const maxNum = Number(maxRun);
  const max = Number.isFinite(maxNum) && maxNum >= 1 ? Math.max(min, maxNum) : null;
  // Fairness weight: blank = automatic (1, or the overnight default for
  // overnight shifts). 0 is allowed and means standby duty that doesn't count
  // toward anyone's shift count.
  const wNum = Number(weight);
  const w = weight === '' || weight == null || !Number.isFinite(wNum) ? null : Math.max(0, wNum);
  return {
    fields: {
      weight: w,
      name: name.trim(),
      startTime,
      endTime,
      frequency: freq,
      dayOfWeek: freq === 'weekly' ? Math.min(6, Math.max(0, Number(dayOfWeek) || 0)) : null,
      staffRequired: Math.max(1, Number(staffRequired) || 1),
      minRun: min,
      maxRun: max,
    },
  };
}

app.post('/api/shift-types', (req, res) => {
  const db = loadDb();
  const { error, fields } = parseShiftType(req.body);
  if (error) return res.status(400).json({ error });
  const st = { id: newId('s'), ...fields };
  db.shiftTypes.push(st);
  saveDb();
  res.json(st);
});

app.put('/api/shift-types/:id', (req, res) => {
  const db = loadDb();
  const st = db.shiftTypes.find((s) => s.id === req.params.id);
  if (!st) return res.status(404).json({ error: 'Shift type not found.' });
  const { error, fields } = parseShiftType(req.body);
  if (error) return res.status(400).json({ error });
  // Mutate in place so existing schedules keep referencing the same id.
  Object.assign(st, fields);
  saveDb();
  res.json(st);
});

app.delete('/api/shift-types/:id', (req, res) => {
  const db = loadDb();
  const idx = db.shiftTypes.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Shift type not found.' });
  db.shiftTypes.splice(idx, 1);
  saveDb();
  res.json({ ok: true });
});

// ---- settings ----
app.put('/api/settings', (req, res) => {
  const db = loadDb();
  const { maxVacationPerDay, overnightWeight } = req.body;
  if (maxVacationPerDay !== undefined)
    db.settings.maxVacationPerDay = Math.max(1, Number(maxVacationPerDay) || 1);
  if (overnightWeight !== undefined)
    db.settings.overnightWeight = Math.max(1, Number(overnightWeight) || 1.5);
  if (req.body.cadence !== undefined) {
    const c = req.body.cadence;
    if (!isValidCadence(c))
      return res.status(400).json({ error: 'Invalid cadence: need an anchor date, a positive whole number, and a unit.' });
    const existing = db.settings.cadence;
    const changed = !existing
      || existing.anchorDate !== c.anchorDate
      || existing.lengthUnit !== c.lengthUnit
      || existing.lengthValue !== c.lengthValue;
    // Changing an existing cadence requires a strictly-future anchor; the very
    // first setup may start today or later.
    if (changed && existing && c.anchorDate <= todayYmd())
      return res.status(400).json({ error: 'A new schedule start date must be in the future.' });
    if (changed && !existing && c.anchorDate < todayYmd())
      return res.status(400).json({ error: 'The schedule start date cannot be in the past.' });
    db.settings.cadence = { anchorDate: c.anchorDate, lengthUnit: c.lengthUnit, lengthValue: c.lengthValue };
  }
  saveDb();
  res.json(db.settings);
});

// ---- time off requests ----
app.post('/api/timeoff', (req, res) => {
  const db = loadDb();
  const { userId, date, type } = req.body;
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!isDate(date)) return res.status(400).json({ error: 'Invalid date.' });
  if (type !== 'vacation' && type !== 'preferred')
    return res.status(400).json({ error: 'Type must be vacation or preferred.' });

  const existing = db.timeOff.find((t) => t.userId === userId && t.date === date);
  if (existing)
    return res.status(409).json({ error: 'You already have a request on that day. Remove it first.' });

  // Must-have-off requests are free at request time — vacation is only
  // charged after a schedule is generated, if the days kept the person under
  // their required shifts. The per-day cap still protects coverage.
  if (type === 'vacation') {
    const dayCount = vacationCountForDate(db, date);
    if (dayCount >= db.settings.maxVacationPerDay) {
      return res.status(400).json({
        error: `That day is full: ${dayCount} people already have it off (max ${db.settings.maxVacationPerDay}).`,
      });
    }
  }

  const entry = { id: newId('t'), userId, date, type };
  db.timeOff.push(entry);
  saveDb();
  res.json(entry);
});

app.delete('/api/timeoff/:id', (req, res) => {
  const db = loadDb();
  const idx = db.timeOff.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Request not found.' });
  db.timeOff.splice(idx, 1);
  saveDb();
  res.json({ ok: true });
});

// ---- schedules ----
app.post('/api/schedules', (req, res) => {
  const db = loadDb();
  const { minShifts } = req.body;
  const cadence = db.settings.cadence;
  if (!cadence) return res.status(400).json({ error: 'Configure a schedule cadence in Settings first.' });
  if (db.shiftTypes.length === 0)
    return res.status(400).json({ error: 'Configure at least one shift type first.' });
  if (db.users.length === 0)
    return res.status(400).json({ error: 'Add employees to the roster first.' });
  const blockIndex = Number(req.body.blockIndex);
  if (!Number.isInteger(blockIndex) || blockIndex < 0)
    return res.status(400).json({ error: 'Pick a schedule block.' });
  // Only the offered window (current block + next 4) may be generated.
  const firstBlock = currentBlockIndex(cadence, todayYmd());
  if (blockIndex < firstBlock || blockIndex > firstBlock + 4)
    return res.status(400).json({ error: 'That block is outside the selectable window.' });
  const { startDate, endDate } = blockRange(cadence, blockIndex);
  if (db.schedules.some((s) => s.startDate === startDate))
    return res.status(400).json({ error: 'A schedule for this block already exists — delete it first to regenerate.' });

  const min = Math.max(0, Number(minShifts) || 0);
  const maxRaw = req.body.maxShifts;
  const maxNum = Number(maxRaw);
  const max = maxRaw === '' || maxRaw == null || !Number.isFinite(maxNum) || maxNum < 1
    ? null
    : Math.floor(maxNum);
  if (max !== null && max < min)
    return res.status(400).json({
      error: `Maximum shifts (${max}) cannot be lower than the minimum (${min}).`,
    });
  const requested = Array.isArray(req.body.userIds) ? req.body.userIds : null;
  const userIds = (requested || db.users.map((u) => u.id)).filter((id) =>
    db.users.some((u) => u.id === id)
  );
  if (userIds.length === 0)
    return res.status(400).json({ error: 'Include at least one person in the block.' });
  const { nextRotationCursor, ...result } = generateSchedule(db, {
    startDate,
    endDate,
    minShifts: min,
    maxShifts: max,
    userIds,
  });
  const schedule = {
    id: newId('sch'),
    startDate,
    endDate,
    minShifts: min,
    maxShifts: max,
    userIds,
    createdAt: new Date().toISOString(),
    extraElections: {},
    ...result,
  };
  db.schedules.push(schedule);
  db.meta.rotationCursor = nextRotationCursor;
  saveDb();
  res.json(schedule);
});

// Manual assignment editing: fill an open slot, hand a shift to someone else,
// or unassign a shift back to open. Hard rules (vacation, one shift per day,
// 8h rest) still apply to the receiving employee.
app.post('/api/schedules/:id/reassign', (req, res) => {
  const db = loadDb();
  const schedule = db.schedules.find((s) => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });
  const { date, shiftTypeId, fromUserId, toUserId } = req.body;
  const st = db.shiftTypes.find((s) => s.id === shiftTypeId);
  if (!st) return res.status(400).json({ error: 'Shift type no longer exists.' });

  if (toUserId) {
    const to = db.users.find((u) => u.id === toUserId);
    if (!to) return res.status(404).json({ error: 'Employee not found.' });
    const moving = fromUserId
      ? schedule.assignments.find(
          (a) => a.date === date && a.shiftTypeId === shiftTypeId && a.userId === fromUserId
        )
      : null;
    // Safety rules (vacation, one-shift-per-day, rest, night cap) are shared
    // with shift trading; admin reassignment additionally enforces the cap.
    const err = canTakeShift(db, schedule, { date, shiftTypeId }, to, moving ? [moving] : []);
    if (err) return res.status(400).json({ error: err });
    // Weight-0 (standby) shifts don't count toward the shift maximum.
    const shiftById = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
    const maxAllowed = effectiveMaximums(db, schedule).get(to.id);
    const countingHeld = schedule.assignments.filter(
      (a) =>
        a.userId === toUserId && a !== moving && weightOf(shiftById[a.shiftTypeId], db.settings) > 0
    ).length;
    if (weightOf(st, db.settings) > 0 && countingHeld + 1 > maxAllowed)
      return res.status(400).json({
        error: `${to.name} is already at their maximum of ${maxAllowed} shifts for this schedule.`,
      });
  }

  if (!fromUserId) {
    // Fill an open slot.
    if (!toUserId) return res.status(400).json({ error: 'Pick an employee for the open shift.' });
    const idx = schedule.unfilled.findIndex(
      (s) => s.date === date && s.shiftTypeId === shiftTypeId
    );
    if (idx === -1) return res.status(404).json({ error: 'Open shift not found.' });
    schedule.unfilled.splice(idx, 1);
    schedule.assignments.push({ date, shiftTypeId, userId: toUserId });
  } else {
    const a = schedule.assignments.find(
      (x) => x.date === date && x.shiftTypeId === shiftTypeId && x.userId === fromUserId
    );
    if (!a) return res.status(404).json({ error: 'Assignment not found.' });
    if (toUserId) {
      a.userId = toUserId;
    } else {
      schedule.assignments.splice(schedule.assignments.indexOf(a), 1);
      schedule.unfilled.push({ date, shiftTypeId });
    }
  }

  const { counts, warnings } = summarizeSchedule(db, schedule);
  schedule.counts = counts;
  schedule.warnings = warnings;
  saveDb();
  res.json(schedule);
});

app.delete('/api/schedules/:id', (req, res) => {
  const db = loadDb();
  const idx = db.schedules.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found.' });
  db.schedules.splice(idx, 1);
  saveDb();
  res.json({ ok: true });
});

// ---- shift trading ----
// Trade functions mutate the loadDb() cache; persist here regardless of
// outcome (some failures, like expiry, legitimately change state).
const tradeResult = (res, r) => {
  saveDb();
  return r.error ? res.status(r.code || 400).json({ error: r.error }) : res.json(r.trade);
};

app.post('/api/trades', (req, res) => tradeResult(res, createTrade(loadDb(), req.body)));

app.post('/api/trades/:id/respond', (req, res) =>
  tradeResult(res, respondToOpenTrade(loadDb(), req.params.id, req.body))
);

app.post('/api/trades/:id/withdraw', (req, res) =>
  tradeResult(res, withdrawResponse(loadDb(), req.params.id, req.body))
);

app.post('/api/trades/:id/accept', (req, res) => {
  const db = loadDb();
  const trade = db.trades.find((t) => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found.' });
  const r =
    trade.type === 'open'
      ? acceptOpenResponse(db, req.params.id, req.body)
      : acceptDirect(db, req.params.id, req.body);
  return tradeResult(res, r);
});

app.post('/api/trades/:id/reject', (req, res) =>
  tradeResult(res, rejectDirect(loadDb(), req.params.id, req.body))
);

app.post('/api/trades/:id/claim', (req, res) =>
  tradeResult(res, claimGiveaway(loadDb(), req.params.id, req.body))
);

app.post('/api/trades/:id/cancel', (req, res) =>
  tradeResult(res, cancelTrade(loadDb(), req.params.id, req.body))
);

// Read-only eligibility lookups so the UI only offers feasible trades.
app.get('/api/schedules/:id/trade-options', (req, res) =>
  res.json(tradeOptions(loadDb(), req.params.id, req.query.userId))
);

app.get('/api/schedules/:id/swap-partners', (req, res) =>
  res.json(
    swapPartners(loadDb(), req.params.id, req.query.userId, {
      date: req.query.date,
      shiftTypeId: req.query.shiftTypeId,
    })
  )
);

// Split your extra days (worked beyond required) into extra vacation and
// incentive pay. Repeatable — the new split replaces the old one.
app.put('/api/schedules/:id/extra-election', (req, res) => {
  const db = loadDb();
  const r = setExtraElection(db, req.params.id, req.body);
  saveDb();
  return r.error ? res.status(r.code || 400).json({ error: r.error }) : res.json(r.election);
});

app.put('/api/notifications/read', (req, res) => {
  const db = loadDb();
  const { userId } = req.body;
  for (const n of db.notifications) {
    if (n.userId === userId) n.read = true;
  }
  saveDb();
  res.json({ ok: true });
});

// ---- personal calendar export ----
app.get('/api/schedules/:id/ics', (req, res) => {
  const db = loadDb();
  const schedule = db.schedules.find((s) => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });
  const user = db.users.find((u) => u.id === req.query.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const mine = schedule.assignments.filter((a) => a.userId === user.id);
  const ics = buildIcs({
    user,
    assignments: mine,
    shiftTypes: db.shiftTypes,
    scheduleId: schedule.id,
  });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="shifts-${user.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ics"`
  );
  res.send(ics);
});

// ---- static hosting of the built frontend (after `npm run build`) ----
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// API_PORT, not PORT — dev tools (e.g. preview panels) inject PORT for the
// frontend server, and the API must not steal it.
const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
