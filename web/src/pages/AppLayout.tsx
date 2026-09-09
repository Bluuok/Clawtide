/**
 * Post-auth layout: sidebar navigation + connection banner + content outlet.
 * The chat store's WS connection lives for the whole authenticated session.
 */
import { useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router';
import { NavIcon, TideMark } from '../components/Design.js';
import { useSession } from '../stores/session.js';
import { useChat } from '../stores/chat.js';
import { api } from '../api.js';

const NAV = [
  { to: '/chat', label: 'Chat' },
  { to: '/profiles', label: 'Profiles' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/workspaces', label: 'Workspaces' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const navigate = useNavigate();
  const location = useLocation();
  const title = NAV.find((item) => location.pathname === item.to)?.label ?? 'Chat';
  const socketStatus = useChat((s) => s.socketStatus);
  const reconnectAttempt = useChat((s) => s.reconnectAttempt);
  const connect = useChat((s) => s.connect);
  const disconnect = useChat((s) => s.disconnect);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const logout = async () => {
    await api.post('/auth/logout');
    disconnect();
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand">
          <TideMark />
          <span>clawtide</span>
        </div>
        <div className="brand-subtitle">Digital worker studio</div>
        <nav className="app-nav" aria-label="Primary navigation">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} aria-label={item.label} title={item.label}>
              <NavIcon name={item.label} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="account-name">
            <span className="account-avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
            {user?.username}
          </div>
          <button onClick={() => void logout()} className="logout">
            Log out
          </button>
        </div>
      </aside>
      <main className="app-main">
        <header className="page-header">
          <div>
            <span className="eyebrow">Your workspace / {title}</span>
            <h1>{title === 'Chat' ? 'Room to think.' : title}</h1>
          </div>
          <span
            className={`connection-state ${socketStatus !== 'open' ? 'offline' : ''}`}
            role="status"
          >
            {socketStatus === 'open' ? 'Connected' : 'Reconnecting'}
          </span>
        </header>
        {socketStatus !== 'open' && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
            {socketStatus === 'connecting'
              ? 'Connecting…'
              : `Realtime link down — reconnecting (attempt ${reconnectAttempt + 1})…`}
          </div>
        )}
        <div className="page-outlet">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
