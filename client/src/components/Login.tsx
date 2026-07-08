import { useState } from 'react';
import { api } from '../api';
import type { User } from '../../../shared/types.js';

interface Props {
  onClose: () => void;
  onSuccess: (user: User) => void;
}

// Login modal: email + password. If the server reports the account exists but
// has no password yet ({ needsRegistration: true }), the modal switches to a
// "Create your password" step and registers via email + password.
export default function LoginModal({ onClose, onSuccess }: Props) {
  const [step, setStep] = useState<'login' | 'create'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitLogin = async (e: any) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.login(email, password);
      if (r.needsRegistration) {
        setPassword('');
        setStep('create');
      } else {
        onSuccess(r.user);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async (e: any) => {
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
      const r = await api.registerAccount({ email, password });
      onSuccess(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380, margin: '10vh auto' }}>
        {step === 'login' ? (
          <>
            <h2>Log in</h2>
            {error && <div className="banner error">⚠️ {error}</div>}
            <form onSubmit={submitLogin} className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
              <label>Email
                <input
                  type="email" required autoFocus value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <label>Password
                <input
                  type="password" required value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button className="btn primary" type="submit" disabled={busy || !email || !password}>
                {busy ? 'Logging in…' : 'Log in'}
              </button>
              <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
            </form>
          </>
        ) : (
          <>
            <h2>Create your password</h2>
            <p className="muted small">
              Your account hasn't been set up yet. Choose a password (at least 8 characters) to finish.
            </p>
            {error && <div className="banner error">⚠️ {error}</div>}
            <form onSubmit={submitCreate} className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
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
              <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
