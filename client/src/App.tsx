import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import ScheduleView from './components/ScheduleView';
import Preferences from './components/Preferences';
import Admin from './components/Admin';
import Trades from './components/Trades';
import { safeBg } from './contrast';
import { setLatestState } from './versions';
import type { AppState } from '../../shared/types.js';

// A mutation wrapper: runs `fn`, refreshes state, surfaces server errors.
export type Act = (fn: () => unknown) => Promise<boolean>;

const POLL_MS = 30_000;

export default function App() {
  const [db, setDb] = useState<AppState | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tab, setTab] = useState('schedule');
  const [error, setError] = useState('');
  // Refs mirror tab/user so refresh() never closes over stale state (it is
  // called from intervals and event listeners).
  const tabRef = useRef(tab);
  const userRef = useRef<string | null>(null);
  // Mutations run one-at-a-time: each waits for the previous save's RESPONSE
  // (not its refresh), so version lookups (see versions.ts) resolve against
  // what the previous edit reported — rapid successive edits never
  // self-conflict, and each request still leaves the browser immediately.
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  // While any save is pending, <body data-saving> is set — a hook for a
  // future saving indicator, and a deterministic signal tests can await
  // before navigating away.
  const pendingWrites = useRef(0);
  const notePending = (delta: number) => {
    pendingWrites.current += delta;
    if (pendingWrites.current > 0) document.body.setAttribute('data-saving', 'true');
    else document.body.removeAttribute('data-saving');
  };
  // Refresh responses are sequenced so a slow older fetch can't clobber a
  // newer one.
  const refreshSeq = useRef(0);

  // Fetch the active tab's data plus the two cross-tab resources (users,
  // notifications — separate endpoints so they can become SSE streams later)
  // and merge them into one AppState. Data is fetched per tab, never the
  // whole database.
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const [tabState, { users }] = await Promise.all([api.getTab(tabRef.current), api.getUsers()]);
    // The selected user may have been deleted by another admin meanwhile —
    // fall back to the first user.
    let uid = userRef.current;
    if (!uid || !users.some((u: AppState['users'][number]) => u.id === uid)) {
      uid = users[0]?.id ?? null;
      userRef.current = uid;
      setCurrentUserId(uid);
    }
    const { notifications } = uid
      ? await api.getNotifications(uid)
      : { notifications: [] };
    const merged: AppState = { ...tabState, users, notifications };
    // A newer refresh started while this one was in flight — drop this result.
    if (seq !== refreshSeq.current) return merged;
    setLatestState(merged);
    setDb(merged);
    return merged;
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError((e as Error).message));
  }, [refresh]);

  // Freshness while sitting on a tab: poll every 30s (skipped while the
  // window is hidden) and refetch immediately when it becomes visible again.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) refresh().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Apply per-user theme; runs on first load, user switch, and after a theme save.
  // Computed here (before the early return) so the hook is never called conditionally.
  useEffect(() => {
    const user = db?.users.find((u) => u.id === currentUserId) ?? db?.users[0];
    const t = user?.theme ?? 'light';
    document.documentElement.setAttribute('data-theme', t);
  }, [db, currentUserId]);

  // If the current user loses the admin role while on the Admin tab (role
  // edited elsewhere), snap back to the schedule.
  useEffect(() => {
    if (!db) return;
    const user = db.users.find((u) => u.id === currentUserId) || db.users[0];
    const admin = (user?.roles || []).includes('role-admin');
    if (tab === 'admin' && !admin) {
      tabRef.current = 'schedule';
      setTab('schedule');
    }
  }, [db, currentUserId, tab]);

  if (!db) return <div className="loading">Loading…</div>;

  const currentUser = db.users.find((u) => u.id === currentUserId) || db.users[0];
  const isAdmin = (currentUser?.roles || []).includes('role-admin');

  // Wraps a mutation: runs it (serialized through the queue), refreshes
  // state, surfaces server errors. On failure it STILL refreshes — conflict
  // errors (trade already completed, record changed by someone else) come
  // with fresh data so the stale item disappears alongside the explanation.
  const act: Act = (fn) => {
    setError('');
    notePending(1);
    const mutation = mutationQueue.current.catch(() => {}).then(() => fn());
    // The NEXT mutation only waits for this one's response — never its
    // refresh — so bursts of edits go out back-to-back.
    mutationQueue.current = mutation.catch(() => {});
    return mutation
      .then(async () => {
        notePending(-1);
        await refresh();
        return true;
      })
      .catch(async (e) => {
        notePending(-1);
        setError((e as Error).message);
        await refresh().catch(() => {});
        return false;
      });
  };

  const unread = (db.notifications || []).filter(
    (n) => n.userId === currentUser?.id && !n.read
  ).length;

  const tabs: { id: string; label: string; badge?: number }[] = [
    { id: 'schedule', label: 'Schedule' },
    { id: 'preferences', label: 'Preferences' },
    { id: 'trades', label: 'Trades', badge: unread },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin' }] : []),
  ];

  const openTab = (id: string) => {
    tabRef.current = id;
    setTab(id);
    setError('');
    if (id === 'trades' && unread > 0) {
      // Opening the inbox marks everything read.
      api.markNotificationsRead(currentUser.id).then(refresh).catch(() => {});
    } else {
      refresh().catch(() => {});
    }
  };

  const switchUser = (id: string) => {
    userRef.current = id;
    setCurrentUserId(id);
    tabRef.current = 'schedule';
    setTab('schedule');
    setError('');
    refresh().catch(() => {});
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">🗓️</span> Shift Scheduler
        </div>
        <nav className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => openTab(t.id)}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && <span className="badge">{t.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="user-switch">
          <span className="muted">Signed in as</span>
          <select
            value={currentUser?.id || ''}
            onChange={(e) => switchUser(e.target.value)}
          >
            {db.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {(u.roles || []).includes('role-admin') ? '(admin)' : ''}
              </option>
            ))}
          </select>
          {currentUser && <span className="dot" style={{ background: safeBg(currentUser.color) }} />}
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError('')}>
          ⚠️ {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      <main className="content">
        {tab === 'schedule' && <ScheduleView db={db} currentUser={currentUser} act={act} isAdmin={isAdmin} />}
        {tab === 'preferences' && <Preferences db={db} currentUser={currentUser} act={act} />}
        {tab === 'trades' && <Trades db={db} currentUser={currentUser} act={act} />}
        {tab === 'admin' && isAdmin && <Admin db={db} act={act} />}
      </main>
    </div>
  );
}
