import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from './chat.js';
import { api, ApiError } from '../api.js';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  constructor() {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  event(type: string, extra = {}) {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'stream',
        payload: { type, sessionId: 's', ts: new Date().toISOString(), ...extra },
      }),
    });
  }
}
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
  Socket.instances = [];
  useChat.getState().clearUserScope();
  vi.spyOn(api, 'get').mockResolvedValue({ messages: [] });
});
afterEach(() => {
  useChat.getState().clearUserScope();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('independent race acceptance', () => {
  it('HTTP completion without live events releases busy even when websocket reopened', async () => {
    const request = pending<unknown>();
    vi.spyOn(api, 'post').mockReturnValueOnce(request.promise);
    const sending = useChat.getState().sendChat('s', 'question');
    useChat.getState().connect();
    Socket.instances[0].open();
    request.resolve({ enqueued: true });
    await sending;
    expect(useChat.getState().sessionBusy.s).toBe(false);
    expect(useChat.getState().syncError.s).toContain('HTTP');
    await useChat.getState().loadTranscript('s');
    expect(useChat.getState().sessionBusy.s).toBe(false);
  });
  it('tool events do not split a persisted assistant body into duplicate answers', async () => {
    useChat.getState().connect();
    const socket = Socket.instances[0];
    socket.open();
    socket.event('turn_started');
    socket.event('assistant_text', { text: 'Hello' });
    socket.event('tool_started', { toolUseId: 't', toolName: 'search', input: {} });
    socket.event('assistant_text', { text: ' world' });
    socket.event('turn_finished');
    vi.mocked(api.get).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Hello world', ts: '2026-09-16T00:00:00Z' }],
    });
    await useChat.getState().loadTranscript('s');
    expect(
      useChat
        .getState()
        .entries.s.filter((e) => e.kind === 'text')
        .map((e) => e.content),
    ).toEqual(['Hello world']);
    expect(useChat.getState().entries.s.filter((e) => e.kind === 'tool')).toHaveLength(1);
  });
  it('recovered canonical answer keeps the disconnected fragment explicitly distinguished', async () => {
    useChat.getState().connect();
    const socket = Socket.instances[0];
    socket.open();
    socket.event('assistant_text', { text: 'Hello' });
    socket.readyState = 3;
    socket.onclose!();
    vi.mocked(api.get).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Hello world', ts: '2026-09-16T00:00:00Z' }],
    });
    await useChat.getState().loadTranscript('s');
    await useChat.getState().loadTranscript('s');
    expect(useChat.getState().entries.s.map((e) => [e.content, !!e.interrupted])).toEqual([
      ['Hello', true],
      ['Hello world', false],
    ]);
  });
  it('resumed suffix without an observed start is also labeled incomplete', async () => {
    useChat.getState().connect();
    const first = Socket.instances[0];
    first.open();
    first.event('turn_started');
    first.event('assistant_text', { text: 'Hello' });
    first.readyState = 3;
    first.onclose!();
    useChat.getState().connect();
    const second = Socket.instances[1];
    second.open();
    second.event('assistant_text', { text: ' world' });
    second.event('turn_finished');
    vi.mocked(api.get).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Hello world', ts: '2026-09-16T00:00:00Z' }],
    });
    await useChat.getState().loadTranscript('s');
    expect(useChat.getState().entries.s.map((e) => [e.content, !!e.interrupted])).toEqual([
      ['Hello', true],
      [' world', true],
      ['Hello world', false],
    ]);
  });
  it('late callbacks from old socket cannot replace current connection or append twice', () => {
    useChat.getState().connect();
    const a = Socket.instances[0];
    const old = {
      open: a.onopen!,
      close: a.onclose!,
      error: a.onerror!,
      message: a.onmessage!,
    };
    a.open();
    useChat.getState().disconnect();
    useChat.getState().connect();
    const b = Socket.instances[1];
    b.open();
    old.close();
    old.open();
    old.error();
    old.message({
      data: JSON.stringify({
        type: 'stream',
        payload: {
          type: 'assistant_text',
          sessionId: 's',
          text: 'wrong',
          ts: new Date().toISOString(),
        },
      }),
    });
    b.event('assistant_text', { text: 'answer' });
    useChat.getState().connect();
    expect(Socket.instances).toHaveLength(2);
    expect(useChat.getState().socketStatus).toBe('open');
    expect(useChat.getState().entries.s.map((e) => e.content)).toEqual(['answer']);
  });
  it('inflight history started before live output is discarded', async () => {
    const request = pending<{ messages: unknown[] }>();
    vi.mocked(api.get).mockReturnValueOnce(request.promise);
    const loading = useChat.getState().loadTranscript('s');
    useChat.getState().connect();
    Socket.instances[0].open();
    Socket.instances[0].event('assistant_text', { text: 'new live answer' });
    const before = useChat.getState().entries.s;
    request.resolve({
      messages: [{ role: 'user', content: 'old snapshot', ts: '2026-09-15T00:00:00Z' }],
    });
    await loading;
    expect(useChat.getState().entries.s).toEqual(before);
  });
  it('error terminal settles all partial output, including output before tool activity', async () => {
    useChat.getState().connect();
    const socket = Socket.instances[0];
    socket.open();
    socket.event('turn_started');
    socket.event('assistant_text', { text: 'part one' });
    socket.event('tool_started', { toolUseId: 't', toolName: 'search', input: {} });
    socket.event('assistant_text', { text: 'part two' });
    socket.event('error', { message: 'interrupted' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useChat.getState().entries.s.filter((e) => e.streaming)).toHaveLength(0);
    expect(useChat.getState().sessionBusy.s).toBeFalsy();
    expect(useChat.getState().entries.s.map((e) => e.content)).toEqual(
      expect.arrayContaining(['part onepart two', 'interrupted']),
    );
  });
  it.each([new TypeError('network lost'), new ApiError(403, 'forbidden', 'denied')])(
    'late HTTP failure after user reset cannot recreate prior scope: %s',
    async (failure) => {
      const request = pending<unknown>();
      vi.spyOn(api, 'post').mockReturnValueOnce(request.promise);
      const sending = useChat
        .getState()
        .sendChat('s', 'private text')
        .catch(() => {});
      useChat.getState().clearUserScope();
      request.reject(failure);
      await sending;
      expect(useChat.getState().entries).toEqual({});
      expect(useChat.getState().sessionBusy).toEqual({});
    },
  );
  it('late history after logout cannot reintroduce another user transcript', async () => {
    const request = pending<{ messages: unknown[] }>();
    vi.mocked(api.get).mockReturnValueOnce(request.promise);
    const loading = useChat.getState().loadTranscript('s');
    useChat.getState().clearUserScope();
    request.resolve({
      messages: [{ role: 'user', content: 'private text', ts: '2026-09-15T00:00:00Z' }],
    });
    await loading;
    expect(useChat.getState().entries).toEqual({});
    expect(useChat.getState().syncError).toEqual({});
  });
  it('ordinary connection loss preserves partial output and does not leave busy stuck forever', () => {
    useChat.getState().connect();
    const socket = Socket.instances[0];
    socket.open();
    socket.event('turn_started');
    socket.event('assistant_text', { text: 'partial' });
    socket.readyState = 3;
    socket.onclose!();
    expect(useChat.getState().entries.s.some((e) => e.content === 'partial')).toBe(true);
    expect(useChat.getState().entries.s.some((e) => e.streaming)).toBe(false);
    expect(useChat.getState().sessionBusy.s).toBeFalsy();
  });
});
