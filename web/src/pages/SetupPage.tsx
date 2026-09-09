/**
 * First-run setup wizard: creates the first user, who becomes admin. The
 * endpoint is open exactly once (403 afterwards), and the server issues the
 * session cookie on success — no separate login step.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, type PublicUser } from '../api.js';
import { useSession } from '../stores/session.js';
import { AuthFrame } from '../components/Design.js';

export function SetupPage() {
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
      const { user } = await api.post<{ user: PublicUser }>('/auth/setup', {
        username,
        password,
      });
      setUser(user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'setup failed');
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
          value={username}
          onChange={setUsername}
          placeholder="3–32 chars: letters, digits, underscore"
        />
        <Field
          label="Password"
          value={password}
          onChange={setPassword}
          type="password"
          placeholder="8–128 characters"
        />
        {error !== null && <p className="text-sm text-red-600">{error}</p>}
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
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
      />
    </label>
  );
}
