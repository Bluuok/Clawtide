/**
 * Agent session + transcript row shapes. The AgentRuntime owns the SQL (it is
 * the only consumer); this module is the type source so web routes and the
 * console share the same shape.
 */
export interface AgentSessionRow {
  id: string;
  workspace_id: string;
  sdk_session_id: string;
  thread_id: string;
  profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  thread_id: string;
  session_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string;
}

export interface ToolEventRow {
  id: number;
  session_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  ts: string;
}
