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
      setError(err instanceof ApiError ? err.message : '无法加载模型服务设置。');
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
        setError('请输入 HTTP 或 HTTPS 地址，留空则使用默认地址。');
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
      setError(err instanceof ApiError ? err.message : '保存设置失败，你的更改仍已保留。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content-page settings-page space-y-4">
      <h1>连接模型服务。</h1>
      <p className="text-sm text-slate-600">为数字员工配置兼容 Anthropic 的模型服务。</p>
      {!isAdmin ? (
        <div className="settings-card">
          <h2>由管理员管理</h2>
          <p className="session-help">仅管理员可以修改当前应用的模型服务配置。</p>
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
            <span className="eyebrow">模型服务</span>
            <span className="settings-key-state">
              {loading
                ? '加载中…'
                : provider === null
                  ? '暂不可用'
                  : provider.configured
                    ? 'API 密钥已保存'
                    : '尚未保存 API 密钥'}
            </span>
          </div>
          <p className="session-help">
            更改将在下一轮对话时生效。密钥已保存不代表连接已验证成功。
          </p>
          <fieldset disabled={loading || busy || provider === null} className="settings-fields">
            <label>
              接口地址（Base URL）
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
            <p className="session-help">留空则使用默认接口地址。</p>
            <label>
              API 密钥
              <input
                type="password"
                autoComplete="new-password"
                maxLength={500}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
                placeholder={provider?.configured ? '留空以保留已保存的密钥' : '输入 API 密钥'}
              />
            </label>
            <p className="session-help">已保存的密钥不会显示，留空将保留当前密钥。</p>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}{' '}
              {provider === null && (
                <button type="button" className="underline" onClick={() => void load()}>
                  重试
                </button>
              )}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-emerald-700">
              设置已保存。
            </p>
          )}
          <div className="settings-actions">
            <span className="session-help">
              {dirty ? '你有未保存的更改。' : '设置对当前应用生效。'}
            </span>
            <button
              type="submit"
              disabled={!dirty || loading || busy}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? '保存中…' : '保存更改'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
