/**
 * Login page. Uniform failure (no user-existence oracle); rate limiting is
 * server-side (429 → same message).
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { api, ApiError, type PublicUser } from '../api.js';
import { useSession } from '../stores/session.js';
import { Field } from './SetupPage.js';

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
            : err.status === 403 && err.message.includes('setup')
              ? 'Setup not completed yet.'
              : 'Invalid username or password.',
        );
      } else {
        setError('Login failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold">Sign in</h1>
        <Field label="Username" value={username} onChange={setUsername} />
        <Field label="Password" value={password} onChange={setPassword} type="password" />
        {error !== null && <p className="text-sm text-red-600">{error}</p>}
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
    </div>
  );
}
