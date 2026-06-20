/**
 * Chat data model shared across background ↔ side panel.
 */

export type Role = "user" | "assistant" | "system";

/** A tool call that happened during an assistant turn. */
export interface ChatToolCall {
  /** Anthropic tool_use_id, used to match results back to calls. */
  id: string;
  /** Tool name from the tool registry. */
  name: string;
  /** Parsed input the model sent. */
  input: unknown;
  /**
   * Result string (whatever we returned to the model). Undefined while
   * the tool is still executing. Stringified JSON for structured results
   * (mirrors what was sent as the tool_result content).
   */
  output?: string;
  /** True if the tool execution failed. */
  isError?: boolean;
  /** When the call started, ISO. */
  startedAt: string;
  /** When the call finished, ISO. Undefined while pending. */
  finishedAt?: string;
}

export interface ChatMessage {
  /** Stable client-side ID. */
  id: string;
  role: Role;
  /** Plain text content (model's natural-language reply). */
  text: string;
  /** Tool calls made during this assistant turn (Phase 4+). */
  toolCalls?: ChatToolCall[];
  /** ISO timestamp at message creation. */
  createdAt: string;
  /** True while the assistant turn is still streaming in. */
  streaming?: boolean;
  /** If the turn ended in an error, this holds the user-facing message. */
  error?: string;
}

export interface ChatTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ChatStopInfo {
  stop_reason: string | null;
  usage?: ChatTurnUsage;
}

/**
 * What we send to the proxy in the `messages` field of `POST /v1/chat`.
 * `content` is either a plain string (simple turn) or a full Anthropic
 * content-blocks array (assistant turn with tool_use, user turn with
 * tool_result).
 */
export interface ProxyMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export function toProxyMessages(history: ChatMessage[]): ProxyMessage[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.text.trim().length > 0 && !m.error)
    .map(
      (m) =>
        ({ role: m.role as "user" | "assistant", content: m.text }) as ProxyMessage,
    );
}

export function newId(prefix = "m"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
