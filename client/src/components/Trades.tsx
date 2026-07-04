import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { prettyDate, formatTime, todayYmd } from '../dates';
import { settlementFor, vacationSummary, shiftWeight } from '../shiftMath';
import type { AppState, Assignment, Schedule, Slot, User } from '../../../shared/types.js';
import type { Act } from '../App';

interface Props { db: AppState; currentUser: User; act: Act; }

type TradeOptions = {
  respond: Record<string, Slot[]>;
  claim: Record<string, { ok: boolean; reason: string | null }>;
};

export default function Trades({ db, currentUser, act }: Props) {
  const schedules = [...db.schedules].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [scheduleId, setScheduleId] = useState<string | null>(schedules[0]?.id || null);
  const schedule = schedules.find((s) => s.id === scheduleId) || schedules[0];

  // Server-computed eligibility for this viewer: which shifts can answer each
  // open swap, and which giveaways they can claim. Refetched whenever the
  // schedule, user, or underlying state changes.
  const [options, setOptions] = useState<TradeOptions>({ respond: {}, claim: {} });
  useEffect(() => {
    if (!schedule) return;
    let live = true;
    api
      .tradeOptions(schedule.id, currentUser.id)
      .then((o) => { if (live) setOptions(o); })
      .catch(() => { if (live) setOptions({ respond: {}, claim: {} }); });
    return () => { live = false; };
  }, [schedule?.id, currentUser.id, db]);

  const shiftById = useMemo(
    () => Object.fromEntries(db.shiftTypes.map((s) => [s.id, s])),
    [db.shiftTypes]
  );
  const userById = useMemo(
    () => Object.fromEntries(db.users.map((u) => [u.id, u])),
    [db.users]
  );

  if (!schedule) {
    return (
      <div className="empty-state">
        <h2>Nothing to trade yet</h2>
        <p>Trades work against a published schedule — once one exists, your shifts show up here.</p>
      </div>
    );
  }

  const today = todayYmd();
  const me = currentUser.id;
  const slotKey = (s: Slot) => `${s.date}|${s.shiftTypeId}`;
  const slotFromKey = (k: string): Slot => ({ date: k.split('|')[0], shiftTypeId: k.split('|')[1] });
  const slotLabel = (s: Slot) => {
    const st = shiftById[s.shiftTypeId];
    return st
      ? `${st.name} · ${prettyDate(s.date)} (${formatTime(st.startTime)}–${formatTime(st.endTime)})`
      : s.date;
  };

  const futureShiftsOf = (uid: string) =>
    schedule.assignments
      .filter((a) => a.userId === uid && a.date > today)
      .sort((a, b) => a.date.localeCompare(b.date));

  const trades = (db.trades || []).filter((t) => t.scheduleId === schedule.id);
  const myNotifications = (db.notifications || [])
    .filter((n) => n.userId === me && !n.dismissed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12);

  const directToMe = trades.filter((t) => t.type === 'direct' && t.status === 'open' && t.toUserId === me);
  const openFromOthers = trades.filter((t) => t.type === 'open' && t.status === 'open' && t.fromUserId !== me);
  const giveaways = trades.filter((t) => t.type === 'giveaway' && t.status === 'open' && t.fromUserId !== me);
  const myTrades = trades.filter((t) => t.fromUserId === me && t.status === 'open');
  const myExtra = trades.filter(
    (t) => t.type === 'giveaway' && t.status === 'completed' && t.claimedBy === me
  ).length;



  return (
    <div>
      <div className="toolbar">
        <select value={schedule.id} onChange={(e) => setScheduleId(e.target.value)}>
          {schedules.map((s) => (
            <option key={s.id} value={s.id}>
              {prettyDate(s.startDate)} → {prettyDate(s.endDate)}
            </option>
          ))}
        </select>
        <span className="muted small">
          Extra shifts you picked up this schedule: <strong>{myExtra}</strong>
        </span>
      </div>

      <div className="trades-grid">
        <div>
          <StartTrade
            db={db} act={act} me={currentUser} schedule={schedule}
            futureShiftsOf={futureShiftsOf} slotLabel={slotLabel} slotKey={slotKey}
            slotFromKey={slotFromKey}
          />

          {directToMe.length > 0 && (
            <section className="card">
              <h2>🔁 Proposals for you</h2>
              {directToMe.map((t) => (
                <div key={t.id} className="trade-item">
                  <div>
                    <strong>{userById[t.fromUserId]?.name}</strong> offers their{' '}
                    <strong>{slotLabel(t.offered)}</strong> in exchange for your{' '}
                    <strong>{slotLabel(t.requested!)}</strong>.
                  </div>
                  <div className="row">
                    <button className="btn primary sm" onClick={() => act(() => api.acceptTrade(t.id, { userId: me }))}>
                      Accept swap
                    </button>
                    <button className="btn danger ghost sm" onClick={() => act(() => api.rejectTrade(t.id, { userId: me }))}>
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {openFromOthers.length > 0 && (
            <section className="card">
              <h2>🔄 Open swaps from coworkers</h2>
              {openFromOthers.map((t) => {
                const mine = t.responses.find((r) => r.userId === me);
                return (
                  <div key={t.id} className="trade-item">
                    <div>
                      <strong>{userById[t.fromUserId]?.name}</strong> wants to swap their{' '}
                      <strong>{slotLabel(t.offered)}</strong>.
                    </div>
                    {mine ? (
                      <div className="row">
                        <span className="muted small">You offered: {slotLabel(mine)}</span>
                        <button className="btn ghost sm" onClick={() => act(() => api.withdrawResponse(t.id, { userId: me }))}>
                          Withdraw
                        </button>
                      </div>
                    ) : (options.respond[t.id] || []).length === 0 ? (
                      <span className="muted small">You have no shift you can offer for this — it'd leave you double-booked or short on rest.</span>
                    ) : (
                      <OfferPicker
                        shifts={options.respond[t.id]} slotLabel={slotLabel} slotKey={slotKey}
                        onOffer={(key) =>
                          act(() => api.respondTrade(t.id, { userId: me, ...slotFromKey(key) }))
                        }
                      />
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {giveaways.length > 0 && (
            <section className="card">
              <h2>🎁 Shifts up for grabs</h2>
              {giveaways.map((t) => (
                <div key={t.id} className="trade-item">
                  <div>
                    <strong>{userById[t.fromUserId]?.name}</strong> is giving up their{' '}
                    <strong>{slotLabel(t.offered)}</strong>.
                  </div>
                  {options.claim[t.id] && !options.claim[t.id].ok ? (
                    <span className="muted small">{options.claim[t.id].reason}</span>
                  ) : (
                    <button className="btn primary sm" onClick={() => act(() => api.claimTrade(t.id, { userId: me }))}>
                      Take this shift
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {myTrades.length > 0 && (
            <section className="card">
              <h2>📤 Your active trades</h2>
              {myTrades.map((t) => (
                <div key={t.id} className="trade-item">
                  <div>
                    {t.type === 'open' && <>Open swap of your <strong>{slotLabel(t.offered)}</strong></>}
                    {t.type === 'direct' && (
                      <>Swap proposal to <strong>{userById[t.toUserId!]?.name}</strong>: your{' '}
                        <strong>{slotLabel(t.offered)}</strong> for their <strong>{slotLabel(t.requested!)}</strong> — awaiting reply</>
                    )}
                    {t.type === 'giveaway' && (
                      <>Giving up <strong>{slotLabel(t.offered)}</strong> — 1 vacation day spent, shift stays yours until claimed</>
                    )}
                  </div>
                  {t.type === 'open' && t.responses.length > 0 && (
                    <div className="trade-responses">
                      {t.responses.map((r) => (
                        <div key={r.userId} className="row">
                          <span className="small">
                            <strong>{userById[r.userId]?.name}</strong> offers {slotLabel(r)}
                          </span>
                          <button
                            className="btn primary sm"
                            onClick={() => act(() => api.acceptTrade(t.id, { userId: me, responseUserId: r.userId }))}
                          >
                            Accept
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {t.type === 'open' && t.responses.length === 0 && (
                    <span className="muted small">No offers yet.</span>
                  )}
                  <button className="btn danger ghost sm" onClick={() => act(() => api.cancelTrade(t.id, { userId: me }))}>
                    Cancel{t.type === 'giveaway' ? ' (refunds the vacation day)' : ''}
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>

        <section className="card">
          <div className="notif-head">
            <h2>🔔 Notifications</h2>
            {myNotifications.length > 0 && (
              <button
                className="btn ghost sm"
                onClick={() => act(() => api.dismissAllNotifications(me))}
              >
                Clear all
              </button>
            )}
          </div>
          {myNotifications.length === 0 ? (
            <p className="muted small">Nothing yet — trade activity shows up here.</p>
          ) : (
            <ul className="notif-list">
              {myNotifications.map((n) => (
                <li key={n.id} className={n.read ? '' : 'unread'}>
                  <div className="notif-body">
                    {n.message}
                    <div className="muted small">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                  <button
                    className="notif-dismiss"
                    aria-label="Dismiss notification"
                    title="Dismiss"
                    onClick={() => act(() => api.dismissNotification(n.id, me))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

interface OfferPickerProps {
  shifts: Slot[];
  slotLabel: (s: Slot) => string;
  slotKey: (s: Slot) => string;
  onOffer: (key: string) => void;
}

function OfferPicker({ shifts, slotLabel, slotKey, onOffer }: OfferPickerProps) {
  const [key, setKey] = useState('');
  if (shifts.length === 0) return <span className="muted small">You have no future shifts to offer.</span>;
  return (
    <div className="row">
      <select value={key} onChange={(e) => setKey(e.target.value)}>
        <option value="">— offer one of your shifts —</option>
        {shifts.map((s) => (
          <option key={slotKey(s)} value={slotKey(s)}>{slotLabel(s)}</option>
        ))}
      </select>
      <button className="btn sm" disabled={!key} onClick={() => key && onOffer(key)}>Offer</button>
    </div>
  );
}

interface StartTradeProps {
  db: AppState;
  act: Act;
  me: User;
  schedule: Schedule;
  futureShiftsOf: (uid: string) => Assignment[];
  slotLabel: (s: Slot) => string;
  slotKey: (s: Slot) => string;
  slotFromKey: (k: string) => Slot;
}

function StartTrade({ db, act, me, schedule, futureShiftsOf, slotLabel, slotKey, slotFromKey }: StartTradeProps) {
  const [shiftKey, setShiftKey] = useState('');
  const [mode, setMode] = useState('open');
  const [targetUserId, setTargetUserId] = useState('');
  const [targetShiftKey, setTargetShiftKey] = useState('');
  // Feasible direct-swap partners for the chosen offered shift, from the
  // server (only employees who can take it, with the shifts I can take back).
  const [partners, setPartners] = useState<{ userId: string; shifts: Slot[] }[]>([]);

  const myShifts = futureShiftsOf(me.id);
  const userById = Object.fromEntries(db.users.map((u) => [u.id, u]));

  useEffect(() => {
    setTargetUserId('');
    setTargetShiftKey('');
    if (mode !== 'direct' || !shiftKey) { setPartners([]); return; }
    let live = true;
    api
      .swapPartners(schedule.id, me.id, slotFromKey(shiftKey))
      .then((p) => { if (live) setPartners(p); })
      .catch(() => { if (live) setPartners([]); });
    return () => { live = false; };
  }, [mode, shiftKey, schedule.id, me.id, db]);

  const targetShifts = partners.find((p) => p.userId === targetUserId)?.shifts || [];

  // A giveaway only costs a vacation day when losing the shift would drop you
  // below your required shifts for this block (mirrors the server's check).
  const year = Number(schedule.startDate.slice(0, 4));
  const { available } = vacationSummary(db, me, year);
  const settle = settlementFor(db, schedule, me);
  const stById = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
  const offeredSlot = shiftKey ? slotFromKey(shiftKey) : null;
  const losesCount =
    offeredSlot && stById[offeredSlot.shiftTypeId] &&
    shiftWeight(stById[offeredSlot.shiftTypeId]) > 0 ? 1 : 0;
  const needsDay = offeredSlot
    ? settle.count - losesCount + settle.charged < settle.required
    : false;

  const submit = async () => {
    if (!shiftKey) return;
    const offered = slotFromKey(shiftKey);
    if (mode === 'giveaway') {
      const costLine = needsDay
        ? `This will use 1 vacation day when claimed (you have ${available} left for ${year}).`
        : "You're above your required shifts for this block — no vacation day needed.";
      const ok = confirm(
        `Give up ${slotLabel(offered)}?\n\n${costLine} ` +
        'The shift remains yours until a coworker claims it. You can cancel while unclaimed.'
      );
      if (!ok) return;
    }
    const body = {
      scheduleId: schedule.id,
      fromUserId: me.id,
      type: mode,
      offered,
      ...(mode === 'direct' ? { toUserId: targetUserId, requested: slotFromKey(targetShiftKey) } : {}),
    };
    const done = await act(() => api.createTrade(body));
    if (done) { setShiftKey(''); setTargetUserId(''); setTargetShiftKey(''); }
  };

  return (
    <section className="card">
      <h2>➕ Start a trade</h2>
      {myShifts.length === 0 ? (
        <p className="muted small">You have no upcoming shifts in this schedule.</p>
      ) : (
        <>
          <div className="row spread">
            <select value={shiftKey} onChange={(e) => setShiftKey(e.target.value)}>
              <option value="">— pick one of your shifts —</option>
              {myShifts.map((s) => (
                <option key={slotKey(s)} value={slotKey(s)}>{slotLabel(s)}</option>
              ))}
            </select>
            <div className="seg">
              <button className={mode === 'open' ? 'active' : ''} onClick={() => setMode('open')}>🔄 Open swap</button>
              <button className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>🔁 Direct swap</button>
              <button className={mode === 'giveaway' ? 'active' : ''} onClick={() => setMode('giveaway')}>🎁 Give up</button>
            </div>
          </div>
          {mode === 'open' && (
            <p className="muted small">Everyone is notified; coworkers counter-offer one of their shifts and you pick. No vacation used.</p>
          )}
          {mode === 'direct' && !shiftKey && (
            <p className="muted small">Pick one of your shifts above to see who can swap for it.</p>
          )}
          {mode === 'direct' && shiftKey && partners.length === 0 && (
            <p className="muted small">No coworker can swap for this shift right now (everyone's either working, resting, or has no shift you could take back).</p>
          )}
          {mode === 'direct' && shiftKey && partners.length > 0 && (
            <div className="row spread">
              <select value={targetUserId} onChange={(e) => { setTargetUserId(e.target.value); setTargetShiftKey(''); }}>
                <option value="">— swap with… —</option>
                {partners.map((p) => <option key={p.userId} value={p.userId}>{userById[p.userId]?.name}</option>)}
              </select>
              {targetUserId && (
                <select value={targetShiftKey} onChange={(e) => setTargetShiftKey(e.target.value)}>
                  <option value="">— for their shift… —</option>
                  {targetShifts.map((s) => (
                    <option key={slotKey(s)} value={slotKey(s)}>{slotLabel(s)}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {mode === 'giveaway' && (
            <p className="muted small">
              {!offeredSlot && '⚠️ A vacation day is only used if giving up the shift drops you below your required shifts. Pick a shift to see the cost.'}
              {offeredSlot && needsDay && (
                <>⚠️ Giving up this shift would put you below your required shifts — it will use{' '}
                  <strong>1 vacation day</strong> when claimed ({available} left for {year}).
                  {available <= 0 && <strong> You have none left — you must switch instead.</strong>}
                </>
              )}
              {offeredSlot && !needsDay && (
                <>✅ You're above your required shifts for this block — giving this up costs <strong>no vacation day</strong>.</>
              )}
              {' '}The shift stays yours until someone claims it.
            </p>
          )}
          <button
            className="btn primary"
            disabled={!shiftKey || (mode === 'direct' && (!targetUserId || !targetShiftKey)) || (mode === 'giveaway' && needsDay && available <= 0)}
            onClick={submit}
          >
            {mode === 'open' ? 'Post open swap' : mode === 'direct' ? 'Send proposal' : 'Give up shift'}
          </button>
        </>
      )}
    </section>
  );
}
