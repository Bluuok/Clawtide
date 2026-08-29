/**
 * Typed API client for the console. Cookies are HttpOnly — fetch must send
 * them same-origin (`credentials: 'include'` is a no-op same-origin but keeps
 * the contract explicit). Every non-2xx body is `{ error: { code, message } }`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let code = 'http_error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code !== undefined) code = parsed.error.code;
      if (parsed.error?.message !== undefined) message = parsed.error.message;
    } catch {
      // Non-JSON error body: keep the generic status text.
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

// ---- API payloads (mirror of docs/API.md; shapes verified against routes) --

export interface PublicUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
}

export interface Workspace {
  id: string;
  folder: string;
  jid: string;
  displayName: string;
  isHome: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface Profile {
  id: string;
  name: string;
  version: number;
  identityHash: string;
  isDefault: boolean;
  status: string;
  promptMode: 'append' | 'replace';
  identity: string;
  soul: string;
  agents: string;
  tools: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileVersion {
  version: number;
  created_at: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  sdkSessionId: string;
  threadId: string;
  profileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  ts: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  cronExpr: string | null;
  intervalSeconds: number | null;
  runAt: string | null;
  contextMode: 'group' | 'isolated';
  status: 'active' | 'paused';
  createdAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  status: 'queued' | 'retry_wait' | 'running' | 'success' | 'failed' | 'missed' | 'cancelled';
  attempt: number;
  availableAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  error: string | null;
}
