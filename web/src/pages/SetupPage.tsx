/**
 * First-run setup wizard: creates the first user, who becomes admin. The
 * endpoint is open exactly once (403 afterwards), and the server issues the
 * session cookie on success — no separate login step.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, type PublicUser } from '../api.js';
import { useSession } from '../stores/session.js';
import { AuthFrame } from '../components/Design.js';

export function SetupPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [setupCompleted, setSetupCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      setError('Username must be 3–32 characters using letters, digits, or underscore.');
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError('Password must be 8–128 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    setSetupCompleted(false);
    try {
      const { user } = await api.post<{ user: PublicUser }>('/auth/setup', {
        username,
        password,
      });
      setUser(user);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setSetupCompleted(true);
        setError('Setup has already been completed.');
      } else if (err instanceof ApiError) {
        setError(err.message);
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
        <h1 className="text-xl font-semibold">Welcome to Clawtide</h1>
        <p className="text-sm text-slate-600">
          Create the administrator account. This is a one-time setup — afterwards, accounts are
          created by an admin.
        </p>
        <Field
          label="Username"
          name="username"
          value={username}
          onChange={setUsername}
          placeholder="3–32 chars: letters, digits, underscore"
          autoComplete="username"
          pattern="[a-zA-Z0-9_]{3,32}"
          minLength={3}
          maxLength={32}
          required
        />
        <Field
          label="Password"
          name="password"
          value={password}
          onChange={setPassword}
          type="password"
          placeholder="8–128 characters"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
            {setupCompleted && (
              <>
                {' '}
                <Link to="/login" className="underline">
                  Return to sign in
                </Link>
              </>
            )}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-slate-900 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create admin account'}
        </button>
      </form>
    </AuthFrame>
  );
}

export function Field(props: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        name={props.name}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        required={props.required}
        pattern={props.pattern}
        minLength={props.minLength}
        maxLength={props.maxLength}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
      />
    </label>
  );
}
