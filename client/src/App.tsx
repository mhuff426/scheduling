import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import ScheduleView from './components/ScheduleView';
import Preferences from './components/Preferences';
import Admin from './components/Admin';
import Trades from './components/Trades';
import LoginModal from './components/Login';
import Register from './components/Register';
import { safeBg } from './contrast';
import { setLatestState } from './versions';
import type { AppState, User } from '../../shared/types.js';

// A mutation wrapper: runs `fn`, refreshes state, surfaces server errors.
export type Act = (fn: () => unknown) => Promise<boolean>;

const POLL_MS = 30_000;

// The invite-link landing page renders INSTEAD of the app, regardless of auth.
const isRegisterRoute = () =>
  new URLSearchParams(location.search).has('token') || location.pathname === '/register';

export default function App() {
  const [db, setDb] = useState<AppState | null>(null);
  // 'loading' until the boot api.me() resolves; null = logged out.
  const [authUser, setAuthUser] = useState<User | null | 'loading'>('loading');
  const [showLogin, setShowLogin] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tab, setTab] = useState('schedule');
  const [error, setError] = useState('');
  // Refs mirror tab/user so refresh() never closes over stale state (it is
  // called from intervals and event listeners).
  const tabRef = useRef(tab);
  const userRef = useRef<string | null>(null);
  const loggedInRef = useRef(false);
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

  const becomeLoggedOut = useCallback(() => {
    loggedInRef.current = false;
    userRef.current = null;
    setAuthUser(null);
    setCurrentUserId(null);
    setDb(null);
    tabRef.current = 'schedule';
    setTab('schedule');
  }, []);

  // Fetch the active tab's data plus the two cross-tab resources (users,
  // notifications — separate endpoints so they can become SSE streams later)
  // and merge them into one AppState. Data is fetched per tab, never the
  // whole database.
  const refresh = useCallback(async () => {
    if (!loggedInRef.current) return null;
    const seq = ++refreshSeq.current;
    const [tabState, { users }] = await Promise.all([api.getTab(tabRef.current), api.getUsers()]);
    // If the authed user disappeared from the roster, the session user was
    // deleted — treat it as logged out rather than silently switching identity.
    const uid = userRef.current;
    if (!uid || !users.some((u: AppState['users'][number]) => u.id === uid)) {
      becomeLoggedOut();
      return null;
    }
    const { notifications } = await api.getNotifications();
    const merged: AppState = { ...tabState, users, notifications };
    // A newer refresh started while this one was in flight — drop this result.
    if (seq !== refreshSeq.current) return merged;
    setLatestState(merged);
    setDb(merged);
    return merged;
  }, [becomeLoggedOut]);

  // Called when login/registration succeeds (or boot me() finds a session).
  const becomeLoggedIn = useCallback((user: User) => {
    loggedInRef.current = true;
    userRef.current = user.id;
    setAuthUser(user);
    setCurrentUserId(user.id);
    setShowLogin(false);
    refresh().catch((e) => setError((e as Error).message));
  }, [refresh]);

  // Boot: resolve the session. No tab fetching until we know who's asking.
  useEffect(() => {
    if (isRegisterRoute()) return; // Register page handles itself.
    api.me().then((r: { user: User } | null) => {
      if (r?.user) becomeLoggedIn(r.user);
      else setAuthUser(null);
    });
  }, [becomeLoggedIn]);

  // Session expired mid-use (any API call got a 401) — flip to logged out.
  useEffect(() => {
    const onAuthRequired = () => becomeLoggedOut();
    window.addEventListener('auth:required', onAuthRequired);
    return () => window.removeEventListener('auth:required', onAuthRequired);
  }, [becomeLoggedOut]);

  // Freshness while sitting on a tab: poll every 30s (skipped while the
  // window is hidden) and refetch immediately when it becomes visible again.
  // Only active while logged in.
  useEffect(() => {
    if (!authUser || authUser === 'loading') return;
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
  }, [refresh, authUser]);

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

  // Invite-link landing page: full takeover, regardless of auth state.
  if (isRegisterRoute()) return <Register />;

  if (authUser === 'loading') return <div className="loading">Loading…</div>;

  // Logged out: brand + Login button; no data, no polling.
  if (!authUser) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-icon">🗓️</span> Shift Scheduler
          </div>
          <nav className="tabs" />
          <div className="user-switch">
            <button className="btn primary" onClick={() => setShowLogin(true)}>Log in</button>
          </div>
        </header>
        <main className="content">
          <p className="muted logged-out-msg">Log in to see the schedule.</p>
        </main>
        {showLogin && (
          <LoginModal onClose={() => setShowLogin(false)} onSuccess={becomeLoggedIn} />
        )}
      </div>
    );
  }

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
      api.markNotificationsRead().then(refresh).catch(() => {});
    } else {
      refresh().catch(() => {});
    }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* clear locally regardless */ }
    becomeLoggedOut();
  };

  // Dev/e2e tooling: truly switch identity server-side via the impersonation
  // endpoint, then re-resolve the session. Rendered only under import.meta.env.DEV,
  // so Vite tree-shakes it out of prod builds.
  const switchUser = async (id: string) => {
    setError('');
    // Snap to Schedule synchronously — a tab clicked AFTER the switch must not
    // be yanked away when the impersonation round-trip completes.
    tabRef.current = 'schedule';
    setTab('schedule');
    try {
      await api.impersonate(id);
      const r = await api.me();
      if (!r?.user) { becomeLoggedOut(); return; }
      loggedInRef.current = true;
      userRef.current = r.user.id;
      setAuthUser(r.user);
      setCurrentUserId(r.user.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
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
          {import.meta.env.DEV ? (
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
          ) : (
            <strong>{authUser.name}</strong>
          )}
          {currentUser && <span className="dot" style={{ background: safeBg(currentUser.color) }} />}
          <button className="btn ghost sm" onClick={logout}>Logout</button>
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
