/**
 * Settings (MUST-lite): single Anthropic-compatible provider endpoint +
 * key. Stored server-side as persisted web settings (top of the config
 * priority chain); the key is write-only — the API never echoes it back.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';

export function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ provider: { baseUrl: string; configured: boolean } }>(
          '/settings/provider',
        );
        setBaseUrl(res.provider.baseUrl);
        setConfigured(res.provider.configured);
      } catch {
        // Settings route may be absent in dev builds; page stays editable.
        setConfigured(null);
      }
    })();
  }, []);

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      await api.put('/settings/provider', {
        baseUrl,
        ...(apiKey.length > 0 ? { apiKey } : {}),
      });
      setSaved(true);
      setApiKey('');
      setConfigured(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed');
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Settings — Provider</h1>
      <p className="text-sm text-slate-600">
        Single Anthropic-compatible endpoint. Takes effect on the next agent turn.
      </p>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Base URL</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.anthropic.com"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          API key{' '}
          {configured === true && (
            <span className="text-xs text-emerald-600">(configured — leave blank to keep)</span>
          )}
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={configured === true ? '••••••••' : 'sk-ant-…'}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      {error !== null && <p className="text-sm text-red-600">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Saved.</p>}
      <button
        onClick={() => void save()}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Save
      </button>
    </div>
  );
}
