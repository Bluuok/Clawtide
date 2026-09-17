import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api.js';
import {
  useChat,
  reconcileTranscript,
  MAX_CHAT_CONTENT_LENGTH,
  type ChatEntry,
} from './chat.js';

describe('chat store - PR1 / PR2', () => {
  beforeEach(() => {
    useChat.getState().clearUserScope();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useChat.getState().clearUserScope();
  });

  describe('reconcileTranscript', () => {
    it('preserves unpersisted partial error entries across server snapshots', () => {
      const local: ChatEntry[] = [
        {
          key: 'e1',
          role: 'user',
          content: 'Hello',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
        {
          key: 'e2',
          role: 'assistant',
          content: 'Partial thought before network died…',
          ts: '2026-09-16T00:00:01Z',
          streaming: false,
          kind: 'text',
        },
        {
          key: 'e3',
          role: 'assistant',
          content: 'connection timeout',
          ts: '2026-09-16T00:00:02Z',
          streaming: false,
          kind: 'error',
        },
      ];

      // Backend did not persist the partial assistant or the error into chat_messages
      const server: ChatEntry[] = [
        {
          key: 's1',
          role: 'user',
          content: 'Hello',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
      ];

      const merged = reconcileTranscript(local, server);

      expect(merged).toHaveLength(3);
      expect(merged[0]?.content).toBe('Hello');
      expect(merged[1]?.content).toBe('Partial thought before network died…');
      expect(merged[2]?.kind).toBe('error');
      expect(merged[2]?.content).toBe('connection timeout');
    });

    it('preserves tool entries not persisted in chat_messages table', () => {
      const local: ChatEntry[] = [
        {
          key: 'e1',
          role: 'user',
          content: 'Check files',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
        {
          key: 'e2',
          role: 'assistant',
          content: 'tool: read_file done',
          toolName: 'read_file',
          ts: '2026-09-16T00:00:01Z',
          streaming: false,
          kind: 'tool',
        },
        {
          key: 'e3',
          role: 'assistant',
          content: 'I found the file.',
          ts: '2026-09-16T00:00:02Z',
          streaming: false,
          kind: 'text',
        },
      ];

      const server: ChatEntry[] = [
        {
          key: 's1',
          role: 'user',
          content: 'Check files',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
        {
          key: 's2',
          role: 'assistant',
          content: 'I found the file.',
          ts: '2026-09-16T00:00:02Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
      ];

      const merged = reconcileTranscript(local, server);

      expect(merged).toHaveLength(3);
      expect(merged.some((e) => e.kind === 'tool')).toBe(true);
    });

    it('preserves assistant turn when turn_finished arrives before backend DB persist completes', () => {
      const local: ChatEntry[] = [
        {
          key: 'e1',
          role: 'user',
          content: 'Calculate 2+2',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
        {
          key: 'e2',
          role: 'assistant',
          content: 'The answer is 4.',
          ts: '2026-09-16T00:00:01Z',
          streaming: false,
          kind: 'text',
        },
      ];

      // Stale snapshot where backend turn_finished was emitted before assistant was written to sqlite
      const server: ChatEntry[] = [
        {
          key: 's1',
          role: 'user',
          content: 'Calculate 2+2',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'sent',
        },
      ];

      const merged = reconcileTranscript(local, server);

      expect(merged).toHaveLength(2);
      expect(merged[1]?.content).toBe('The answer is 4.');
    });

    it('preserves failed and unconfirmed user sends', () => {
      const local: ChatEntry[] = [
        {
          key: 'e1',
          role: 'user',
          content: 'Failed attempt',
          ts: '2026-09-16T00:00:00Z',
          streaming: false,
          kind: 'text',
          status: 'failed',
        },
        {
          key: 'e2',
          role: 'user',
          content: 'Unconfirmed attempt',
          ts: '2026-09-16T00:00:01Z',
          streaming: false,
          kind: 'text',
          status: 'unconfirmed',
        },
      ];

      const server: ChatEntry[] = [];
      const merged = reconcileTranscript(local, server);

      expect(merged).toHaveLength(2);
      expect(merged[0]?.status).toBe('failed');
      expect(merged[1]?.status).toBe('unconfirmed');
    });
  });

  describe('socket lifecycle and stale callback guard', () => {
    it('ordinary disconnect settles streaming entries without wiping cached history', () => {
      useChat.setState({
        entries: {
          'session-1': [
            {
              key: 'e1',
              role: 'assistant',
              content: 'Stream fragment…',
              ts: '2026-09-16T00:00:00Z',
              streaming: true,
              kind: 'text',
            },
          ],
        },
        sessionBusy: { 'session-1': true },
      });

      useChat.getState().disconnect();

      const state = useChat.getState();
      expect(state.socketStatus).toBe('closed');
      expect(state.sessionBusy['session-1']).toBeFalsy();
      expect(state.entries['session-1']).toHaveLength(1);
      expect(state.entries['session-1']?.[0]?.streaming).toBe(false);
    });

    it('clearUserScope wipes cached entries and resets attempts on logout', () => {
      useChat.setState({
        entries: {
          'session-1': [
            {
              key: 'e1',
              role: 'user',
              content: 'Private user message',
              ts: '2026-09-16T00:00:00Z',
              streaming: false,
              kind: 'text',
            },
          ],
        },
        sessionBusy: { 'session-1': true },
        reconnectAttempt: 3,
      });

      useChat.getState().clearUserScope();

      const state = useChat.getState();
      expect(state.entries).toEqual({});
      expect(state.sessionBusy).toEqual({});
      expect(state.reconnectAttempt).toBe(0);
    });
  });

  describe('input limits and turn serialization', () => {
    it('rejects content exceeding MAX_CHAT_CONTENT_LENGTH', async () => {
      const oversized = 'a'.repeat(MAX_CHAT_CONTENT_LENGTH + 1);

      await expect(useChat.getState().sendChat('session-1', oversized)).rejects.toThrow(
        `Message exceeds maximum length of ${MAX_CHAT_CONTENT_LENGTH} characters.`,
      );
    });

    it('prevents sending a second message while turn is in progress', async () => {
      useChat.setState({
        sessionBusy: { 'session-1': true },
      });

      await expect(useChat.getState().sendChat('session-1', 'Another message')).rejects.toThrow(
        'A turn is already in progress in this conversation.',
      );
    });

    it('marks entry as failed on explicit HTTP ApiError rejection', async () => {
      vi.spyOn(api, 'post').mockRejectedValueOnce(
        new ApiError(400, 'bad_request', 'Invalid prompt'),
      );

      await expect(useChat.getState().sendChat('session-1', 'Hello')).rejects.toBeInstanceOf(
        ApiError,
      );

      const entries = useChat.getState().entries['session-1'] ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe('failed');
      expect(useChat.getState().sessionBusy['session-1']).toBe(false);
    });

    it('marks entry as unconfirmed on network error', async () => {
      vi.spyOn(api, 'post').mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(useChat.getState().sendChat('session-1', 'Hello')).rejects.toBeInstanceOf(
        TypeError,
      );

      const entries = useChat.getState().entries['session-1'] ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe('unconfirmed');
      expect(useChat.getState().sessionBusy['session-1']).toBe(false);
    });
  });
});
