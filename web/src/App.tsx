/**
 * App shell + routing. Bootstrap resolves the session once; routes are
 * guarded client-side (the server enforces the real gate on every request —
 * client guards only choose which screen to show).
 */
import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { useSession } from './stores/session.js';
import { SetupPage } from './pages/SetupPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { ProfilesPage } from './pages/ProfilesPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { WorkspacesPage } from './pages/WorkspacesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AppLayout } from './pages/AppLayout.js';

export default function App() {
  const user = useSession((s) => s.user);
  const checked = useSession((s) => s.checked);
  const bootstrapError = useSession((s) => s.bootstrapError);
  const bootstrap = useSession((s) => s.bootstrap);
  const location = useLocation();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!checked) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>
    );
  }

  if (bootstrapError !== null) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Clawtide is unavailable</h1>
          <p role="alert" className="mt-2 text-sm text-red-600">
            {bootstrapError}
          </p>
          <button
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            onClick={() => void bootstrap()}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  // Not logged in: setup (when no user exists yet) or login.
  if (user === null) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<RedirectIfSetup />} />
      </Routes>
    );
  }

  const onAuthPage = location.pathname === '/login' || location.pathname === '/setup';
  if (onAuthPage) return <Navigate to="/" replace />;

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/workspaces" element={<WorkspacesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** Chooses setup vs login for unauthenticated deep links. */
function RedirectIfSetup() {
  const location = useLocation();
  // The setup wizard is only reachable pre-bootstrap; once any user exists
  // /auth/setup 403s and the login page's own state drives the error surface.
  const target = location.pathname === '/setup' ? '/setup' : '/login';
  return <Navigate to={target} replace />;
}
