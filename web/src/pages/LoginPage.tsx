/**
 * Login page. Uniform failure (no user-existence oracle); rate limiting is
 * server-side (429 → same message).
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { api, ApiError, type PublicUser } from '../api.js';
import { useSession } from '../stores/session.js';
import { Field } from './SetupPage.js';
import { AuthFrame } from '../components/Design.js';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: PublicUser }>('/auth/login', {
        username,
        password,
      });
      setUser(user);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.code === 'rate_limited'
            ? 'Too many attempts — try again later.'
            : err.status === 401
              ? 'Invalid username or password.'
              : err.status >= 500
                ? 'The server could not complete the login. Please try again.'
                : 'The login request could not be completed. Please try again.',
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <form onSubmit={submit} className="auth-form space-y-4">
        <span className="eyebrow">Welcome to your workspace</span>
        <h1>Welcome back.</h1>
        <Field
          label="Username"
          name="username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          required
        />
        <Field
          label="Password"
          name="password"
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="current-password"
          required
        />
        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-slate-900 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-center text-xs text-slate-500">
          First time here?{' '}
          <Link to="/setup" className="text-slate-700 underline">
            Run setup
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}
