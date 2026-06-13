import React, { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import ScheduleView from './components/ScheduleView.jsx';
import TimeOff from './components/TimeOff.jsx';
import Admin from './components/Admin.jsx';
import Trades from './components/Trades.jsx';

export default function App() {
  const [db, setDb] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [tab, setTab] = useState('schedule');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const state = await api.getState();
    setDb(state);
    return state;
  }, []);

  useEffect(() => {
    refresh().then((state) => {
      if (state.users.length > 0) setCurrentUserId(state.users[0].id);
    });
  }, [refresh]);

  if (!db) return <div className="loading">Loading…</div>;

  const currentUser = db.users.find((u) => u.id === currentUserId) || db.users[0];
  const isAdmin = currentUser?.role === 'admin';

  // Wraps a mutation: runs it, refreshes state, surfaces server errors.
  const act = async (fn) => {
    setError('');
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const unread = (db.notifications || []).filter(
    (n) => n.userId === currentUser?.id && !n.read
  ).length;

  const tabs = [
    { id: 'schedule', label: 'Schedule' },
    { id: 'timeoff', label: 'My Requests' },
    { id: 'trades', label: 'Trades', badge: unread },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin' }] : []),
  ];

  const openTab = (id) => {
    setTab(id);
    setError('');
    if (id === 'trades' && unread > 0) {
      // Opening the inbox marks everything read.
      api.markNotificationsRead(currentUser.id).then(refresh).catch(() => {});
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
              {t.badge > 0 && <span className="badge">{t.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="user-switch">
          <span className="muted">Signed in as</span>
          <select
            value={currentUser?.id || ''}
            onChange={(e) => { setCurrentUserId(e.target.value); setTab('schedule'); setError(''); }}
          >
            {db.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.role === 'admin' ? '(admin)' : ''}
              </option>
            ))}
          </select>
          {currentUser && <span className="dot" style={{ background: currentUser.color }} />}
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError('')}>
          ⚠️ {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      <main className="content">
        {tab === 'schedule' && <ScheduleView db={db} currentUser={currentUser} act={act} isAdmin={isAdmin} />}
        {tab === 'timeoff' && <TimeOff db={db} currentUser={currentUser} act={act} />}
        {tab === 'trades' && <Trades db={db} currentUser={currentUser} act={act} />}
        {tab === 'admin' && isAdmin && <Admin db={db} act={act} />}
      </main>
    </div>
  );
}
