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

/** An image the user attached to a message (vision input). */
export interface ChatImage {
  /** e.g. "image/jpeg", "image/png". */
  mime: string;
  /** Base64 (no data: prefix), already downscaled by the composer. */
  base64: string;
}

export interface ChatMessage {
  /** Stable client-side ID. */
  id: string;
  role: Role;
  /** Plain text content (model's natural-language reply). */
  text: string;
  /** Images the user attached (vision input). */
  images?: ChatImage[];
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

/**
 * Rebuild the Anthropic-shaped message list from the UI history.
 *
 * CRITICAL: this must preserve tool_use / tool_result blocks so Eva remembers
 * what she did on the page across user turns. Sending text-only history (the
 * old behaviour) gave her amnesia — every new message, she'd forget every
 * screenshot and click from before and start over. Silent working turns (tool
 * calls, no text) must also be kept, or the history loses whole actions.
 */
export function toProxyMessages(history: ChatMessage[]): ProxyMessage[] {
  const raw: ProxyMessage[] = [];

  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.error) continue;

    if (m.role === "user") {
      const imgs = m.images ?? [];
      if (m.text.trim().length === 0 && imgs.length === 0) continue;
      if (imgs.length > 0) {
        // Anthropic guidance: images before the text that refers to them.
        const blocks: unknown[] = imgs
          .filter((im) => im.base64 && im.base64.length > 0)
          .map((im) => ({
            type: "image",
            source: { type: "base64", media_type: im.mime, data: im.base64 },
          }));
        if (m.text.trim().length > 0) blocks.push({ type: "text", text: m.text });
        raw.push({ role: "user", content: blocks });
      } else {
        raw.push({ role: "user", content: m.text });
      }
      continue;
    }

    // assistant
    const calls = m.toolCalls ?? [];
    if (calls.length === 0) {
      if (m.text.trim().length === 0) continue;
      raw.push({ role: "assistant", content: m.text });
      continue;
    }

    // Assistant turn that used tools → an assistant turn carrying the tool_use
    // blocks, followed by a user turn carrying the matching tool_result blocks.
    const assistantBlocks: unknown[] = [];
    if (m.text.trim().length > 0) {
      assistantBlocks.push({ type: "text", text: m.text });
    }
    for (const c of calls) {
      assistantBlocks.push({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.input ?? {},
      });
    }
    raw.push({ role: "assistant", content: assistantBlocks });

    const resultBlocks = calls.map((c) => ({
      type: "tool_result",
      tool_use_id: c.id,
      content: toolResultContent(c.output, c.isError === true),
      ...(c.isError ? { is_error: true } : {}),
    }));
    raw.push({ role: "user", content: resultBlocks });
  }

  return mergeAdjacentRoles(raw);
}

/**
 * Turn a stored tool output string back into Anthropic content. Screenshots are
 * stored as JSON with base64 — they must go back as image blocks so Eva can see
 * them, not as text she'd try to read literally.
 */
function toolResultContent(output: string | undefined, isError: boolean): unknown {
  if (output == null) return "(no result recorded)";
  if (isError) return output;
  try {
    const parsed = JSON.parse(output) as {
      mime_type?: string;
      base64?: string;
      url?: string;
      title?: string;
    };
    if (
      typeof parsed.mime_type === "string" &&
      parsed.mime_type.startsWith("image/") &&
      typeof parsed.base64 === "string" &&
      parsed.base64.length > 0
    ) {
      const blocks: unknown[] = [
        {
          type: "image",
          source: { type: "base64", media_type: parsed.mime_type, data: parsed.base64 },
        },
      ];
      const label = [parsed.title, parsed.url].filter(Boolean).join(" · ");
      if (label) blocks.push({ type: "text", text: label });
      return blocks;
    }
  } catch {
    // not JSON — return as-is
  }
  return output;
}

/**
 * Anthropic requires strict user/assistant alternation. Reconstructing tool
 * turns can leave two user turns adjacent (a tool_result turn immediately
 * followed by the next typed user message). Fold consecutive same-role turns
 * into one, converting string content into a text block as needed.
 */
function mergeAdjacentRoles(messages: ProxyMessage[]): ProxyMessage[] {
  const out: ProxyMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      const prevBlocks = asBlocks(prev.content);
      const nextBlocks = asBlocks(m.content);
      prev.content = [...prevBlocks, ...nextBlocks];
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

function asBlocks(content: string | unknown[]): unknown[] {
  if (Array.isArray(content)) return content;
  const text = String(content ?? "");
  return text.length > 0 ? [{ type: "text", text }] : [];
}

export function newId(prefix = "m"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
