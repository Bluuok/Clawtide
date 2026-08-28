/**
 * StreamEvent — the single event protocol between the agent runtime, the
 * WebSocket hub, and the web console. The runtime maps Claude Agent SDK
 * frames into these; the console renders them. Defined once here; both
 * `src/` and `web/` import from this file.
 */
export type StreamEvent =
  | {
      type: 'turn_started';
      sessionId: string;
      ts: string;
    }
  | {
      type: 'assistant_text';
      sessionId: string;
      /** Incremental text fragment for the current turn. */
      text: string;
      ts: string;
    }
  | {
      type: 'tool_started';
      sessionId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      ts: string;
    }
  | {
      type: 'tool_finished';
      sessionId: string;
      toolUseId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
      ts: string;
    }
  | {
      type: 'turn_finished';
      sessionId: string;
      ts: string;
    }
  | {
      type: 'error';
      sessionId: string;
      message: string;
      ts: string;
    };

export type StreamEventType = StreamEvent['type'];
