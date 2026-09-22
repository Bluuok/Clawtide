/**
 * Post-auth layout: sidebar navigation + connection banner + content outlet.
 * The chat store's WS connection lives for the whole authenticated session.
 */
import { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router';
import { NavIcon, TideMark } from '../components/Design.js';
import { useSession } from '../stores/session.js';
import { useChat } from '../stores/chat.js';
import { api, ApiError, type PublicUser } from '../api.js';

const NAV = [
  { to: '/chat', icon: 'Chat', label: '会话' },
  { to: '/profiles', icon: 'Profiles', label: '数字员工' },
  { to: '/tasks', icon: 'Tasks', label: '任务' },
  { to: '/workspaces', icon: 'Workspaces', label: '工作区' },
  { to: '/settings', icon: 'Settings', label: '设置' },
];

export function AppLayout() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const navigate = useNavigate();
  const location = useLocation();
  const title = NAV.find((item) => location.pathname === item.to)?.label ?? '会话';
  const socketStatus = useChat((s) => s.socketStatus);
  const reconnectAttempt = useChat((s) => s.reconnectAttempt);
  const connect = useChat((s) => s.connect);
  const disconnect = useChat((s) => s.disconnect);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect, user?.id]);

  const logout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError(null);
    try {
      await api.post('/auth/logout');
      setUser(null);
      navigate('/login');
    } catch {
      // The server may have revoked the session before its response was lost.
      let signedOut = false;
      try {
        const { user: currentUser } = await api.get<{ user: PublicUser | null }>('/auth/me');
        signedOut = currentUser === null;
      } catch (err) {
        signedOut = err instanceof ApiError && err.status === 401;
      }
      if (signedOut) {
        setUser(null);
        navigate('/login');
      } else {
        setLogoutError('无法确认退出状态，请重试。');
      }
    } finally {
      setLogoutBusy(false);
    }
  };

  return (
    <div className="app-shell" lang="zh-CN">
      <aside className="app-sidebar">
        <div className="brand">
          <TideMark />
          <span>clawtide</span>
        </div>
        <div className="brand-subtitle">数字员工工作台</div>
        <nav className="app-nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} aria-label={item.label} title={item.label}>
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="account-name">
            <span className="account-avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
            {user?.username}
          </div>
          {logoutError !== null && (
            <p role="alert" className="text-xs text-red-200">
              {logoutError}
            </p>
          )}
          <button onClick={() => void logout()} disabled={logoutBusy} className="logout">
            {logoutBusy ? '正在退出…' : logoutError ? '重试退出' : '退出登录'}
          </button>
        </div>
      </aside>
      <main className="app-main">
        <header className="page-header">
          <div>
            <span className="eyebrow">我的工作区 / {title}</span>
            <h1>{title === '会话' ? '聊聊你的想法。' : title}</h1>
          </div>
          <span
            className={`connection-state ${socketStatus !== 'open' ? 'offline' : ''}`}
            role="status"
          >
            {socketStatus === 'open' ? '已连接' : '正在重连'}
          </span>
        </header>
        {socketStatus !== 'open' && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
            {socketStatus === 'connecting'
              ? '正在连接…'
              : `实时连接已断开，正在进行第 ${reconnectAttempt + 1} 次重连…`}
          </div>
        )}
        <div className="page-outlet">
          <Outlet key={user?.id} />
        </div>
      </main>
    </div>
  );
}
