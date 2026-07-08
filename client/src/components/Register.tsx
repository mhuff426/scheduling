import { useState } from 'react';
import { api } from '../api';

// First-time setup page reached from an invite link (/register?token=...).
// Rendered INSTEAD of the app (see App.tsx), regardless of auth state.
export default function Register() {
  const token = new URLSearchParams(location.search).get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: any) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.registerAccount({ token, password });
      // Session cookie is set; land on the app logged in.
      location.href = '/';
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">🗓️</span> Shift Scheduler
        </div>
      </header>
      <main className="content">
        <section className="card" style={{ maxWidth: 420, margin: '8vh auto' }}>
          <h2>First-time setup</h2>
          <p className="muted small">Choose a password (at least 8 characters) to finish setting up your account.</p>
          {error && (
            <div className="banner error">
              ⚠️ {error}
              {/invalid or has expired/i.test(error) && (
                <div className="muted small">Ask your administrator to resend your invite.</div>
              )}
            </div>
          )}
          {!token ? (
            <p className="muted small">This registration link is missing its token. Ask your administrator to resend your invite.</p>
          ) : (
            <form onSubmit={submit} className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
              <label>Password
                <input
                  type="password" required autoFocus minLength={8} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label>Confirm password
                <input
                  type="password" required minLength={8} value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              <button
                className="btn primary" type="submit"
                disabled={busy || password.length < 8 || password !== confirm}
              >
                {busy ? 'Saving…' : 'Set password & log in'}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
