/**
 * Post-auth layout: sidebar navigation + connection banner + content outlet.
 * The chat store's WS connection lives for the whole authenticated session.
 */
import { useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router';
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
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-52 flex-col border-r border-slate-200 bg-white">
        <div className="px-4 py-4 text-lg font-semibold tracking-tight">Clawtide</div>
        <nav className="flex-1 space-y-1 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm ${
                  isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3 text-sm">
          <div className="mb-2 font-medium">{user?.username}</div>
          <button
            onClick={() => void logout()}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {socketStatus !== 'open' && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
            {socketStatus === 'connecting'
              ? 'Connecting…'
              : `Realtime link down — reconnecting (attempt ${reconnectAttempt + 1})…`}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
