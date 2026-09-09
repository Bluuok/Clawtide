import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { useSession } from '../stores/session.js';

type Provider = { baseUrl: string; configured: boolean };

export function SettingsPage() {
  const user = useSession((s) => s.user);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<Provider | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isAdmin = user?.role === 'admin';
  const dirty = provider !== null && (baseUrl !== provider.baseUrl || apiKey.length > 0);

  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ provider: Provider }>('/settings/provider');
      setProvider(res.provider);
      setBaseUrl(res.provider.baseUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load provider settings.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (busy || !dirty) return;
    setError(null);
    setSaved(false);
    const url = baseUrl.trim();
    if (url) {
      try {
        if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
      } catch {
        setError('Enter an HTTP or HTTPS address, or leave it blank to use the default.');
        return;
      }
    }
    setBusy(true);
    try {
      const res = await api.put<{ provider: Provider }>('/settings/provider', {
        baseUrl: url,
        ...(apiKey.length > 0 ? { apiKey } : {}),
      });
      setProvider(res.provider);
      setBaseUrl(res.provider.baseUrl);
      setApiKey('');
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not save settings. Your changes are still here.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content-page settings-page space-y-4">
      <h1>Connect your intelligence.</h1>
      <p className="text-sm text-slate-600">
        Choose the Anthropic-compatible endpoint your digital workers use.
      </p>
      {!isAdmin ? (
        <div className="settings-card">
          <h2>Managed by your administrator</h2>
          <p className="session-help">
            An administrator can change the provider for this installation.
          </p>
        </div>
      ) : (
        <form
          className="settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="settings-card-heading">
            <span className="eyebrow">Model provider</span>
            <span className="settings-key-state">
              {loading
                ? 'Loading…'
                : provider === null
                  ? 'Unavailable'
                  : provider.configured
                    ? 'API key saved'
                    : 'No saved API key'}
            </span>
          </div>
          <p className="session-help">
            Changes apply on the next agent turn. A saved key does not confirm a successful
            connection.
          </p>
          <fieldset disabled={loading || busy || provider === null} className="settings-fields">
            <label>
              Base URL
              <input
                value={baseUrl}
                maxLength={500}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setSaved(false);
                }}
                placeholder="https://api.anthropic.com"
              />
            </label>
            <p className="session-help">Leave blank to use the default endpoint.</p>
            <label>
              API key
              <input
                type="password"
                autoComplete="new-password"
                maxLength={500}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
                placeholder={
                  provider?.configured
                    ? 'Leave blank to keep your saved key'
                    : 'Enter your API key'
                }
              />
            </label>
            <p className="session-help">
              Your saved key is never displayed. Leaving this field blank keeps the current key.
            </p>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}{' '}
              {provider === null && (
                <button type="button" className="underline" onClick={() => void load()}>
                  Retry
                </button>
              )}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-emerald-700">
              Settings saved.
            </p>
          )}
          <div className="settings-actions">
            <span className="session-help">
              {dirty ? 'You have unsaved changes.' : 'Applies to this installation.'}
            </span>
            <button
              type="submit"
              disabled={!dirty || loading || busy}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
