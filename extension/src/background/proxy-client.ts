/**
 * Streams one assistant turn from the Eva Insight proxy.
 *
 * Phase 4: surfaces both text deltas (for live rendering) and tool_use
 * blocks (so the agent loop can execute and continue the conversation).
 *
 * The proxy forwards Anthropic Messages SSE verbatim. We watch for:
 *   - content_block_start  / content_block_delta / content_block_stop
 *     → reconstruct text and tool_use blocks
 *   - message_delta        → final stop_reason + usage
 *   - error                → wrap as a typed ProxyError
 */

import type { ChatStopInfo, ProxyMessage } from "../shared/chat";
import { EVA_TOOL_BETAS, type ToolSchema } from "../shared/tools";

/**
 * Extension tasks run on Claude Sonnet 5 — the same model Claude-in-Chrome
 * uses, newest Sonnet generation, listed first for computer use, and at
 * Sonnet pricing ($3/$15; intro $2/$10 through Aug 2026). Verified against
 * the live models overview 2026-07-07. Platform chat stays on the server
 * default.
 */
export const EXTENSION_MODEL = "claude-sonnet-5";
import { parseSseStream } from "./sse";
import type { EvaSettings } from "./settings";

export type { ProxyMessage };

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

/** Thinking block returned by the model — must be replayed in subsequent turns. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RunChatArgs {
  settings: EvaSettings;
  /** Supabase access token — takes priority over settings.sharedSecret. */
  accessToken?: string | null;
  system: string;
  messages: ProxyMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
  onToolUseStart?: (block: ToolUseBlock) => void;
  /** Model override; defaults to EXTENSION_MODEL. */
  model?: string;
  /** Beta flags; defaults to the computer-use beta. Pass [] for plain calls. */
  betas?: string[];
  /** "off" omits the thinking param (needed for Haiku helper calls). */
  thinking?: "adaptive" | "off";
  /** Output cap; defaults to 32768. */
  maxTokens?: number;
}

export interface RunChatResult {
  /** Full assistant text for this turn (accumulated). */
  text: string;
  /** Tool calls the model wants executed. */
  toolUses: ToolUseBlock[];
  /** Thinking blocks from this turn — must be included in subsequent assistant messages. */
  thinkingBlocks: ThinkingBlock[];
  /** Stop info (end_turn / tool_use / max_tokens / refusal / aborted). */
  info: ChatStopInfo;
}

export class ProxyError extends Error {
  constructor(
    public readonly errorType: string,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

interface BlockState {
  index: number;
  type: "text" | "tool_use" | "thinking" | "other";
  text?: string;
  toolUseId?: string;
  toolUseName?: string;
  toolUseJsonBuf?: string;
  thinkingBuf?: string;
  signatureBuf?: string;
}

/** Eva's lasting per-user memory, stored on the proxy. Best-effort reads. */
export async function fetchMemory(
  settings: EvaSettings,
  accessToken: string | null,
  timeoutMs = 2000,
): Promise<string> {
  const bearerToken = accessToken ?? settings.sharedSecret;
  if (!settings.proxyUrl || !bearerToken) return "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL("/v1/memory", settings.proxyUrl).toString();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { content?: string };
    return typeof data.content === "string" ? data.content : "";
  } catch {
    return ""; // memory must never block or fail a run
  } finally {
    clearTimeout(timer);
  }
}

export async function saveMemory(
  settings: EvaSettings,
  accessToken: string | null,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const bearerToken = accessToken ?? settings.sharedSecret;
  if (!settings.proxyUrl || !bearerToken) return { ok: false, error: "not connected" };
  const url = new URL("/v1/memory", settings.proxyUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message) msg = data.error.message;
    } catch { /* keep status */ }
    return { ok: false, error: msg };
  }
  return { ok: true };
}

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    settings,
    accessToken,
    system,
    messages,
    tools,
    signal,
    onTextDelta,
    onToolUseStart,
  } = args;

  // Prefer the live Supabase JWT; fall back to the dev shared secret.
  const bearerToken = accessToken ?? settings.sharedSecret;

  const url = new URL("/v1/chat", settings.proxyUrl).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      model: args.model ?? EXTENSION_MODEL,
      system,
      messages,
      tools,
      betas: args.betas ?? EVA_TOOL_BETAS,
      ...(args.thinking === "off" ? {} : { thinking: { type: "adaptive" } }),
      max_tokens: args.maxTokens ?? 32768,
    }),
    signal,
  });

  if (!response.ok) {
    const errBody = await safeJson(response);
    throw new ProxyError(
      errBody?.error?.type ?? "http_error",
      errBody?.error?.message ??
        `proxy returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new ProxyError("server_error", "proxy returned no response body");
  }

  const blocks = new Map<number, BlockState>();
  let text = "";
  const toolUses: ToolUseBlock[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  let info: ChatStopInfo = { stop_reason: null };

  for await (const ev of parseSseStream(response.body, signal)) {
    if (signal.aborted) break;

    let parsed: any;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      continue;
    }

    switch (ev.event) {
      case "content_block_start": {
        const index = parsed.index as number;
        const cb: any = parsed.content_block;
        if (cb?.type === "text") {
          blocks.set(index, { index, type: "text", text: cb.text ?? "" });
        } else if (cb?.type === "tool_use") {
          blocks.set(index, {
            index,
            type: "tool_use",
            toolUseId: cb.id,
            toolUseName: cb.name,
            toolUseJsonBuf: "",
          });
          onToolUseStart?.({ id: cb.id, name: cb.name, input: cb.input ?? {} });
        } else if (cb?.type === "thinking") {
          blocks.set(index, { index, type: "thinking", thinkingBuf: "" });
        } else {
          blocks.set(index, { index, type: "other" });
        }
        break;
      }
      case "content_block_delta": {
        const index = parsed.index as number;
        const block = blocks.get(index);
        if (!block) break;
        const delta: any = parsed.delta;
        if (delta?.type === "text_delta" && block.type === "text") {
          const chunk = String(delta.text ?? "");
          block.text = (block.text ?? "") + chunk;
          text += chunk;
          onTextDelta(chunk);
        } else if (delta?.type === "input_json_delta" && block.type === "tool_use") {
          block.toolUseJsonBuf =
            (block.toolUseJsonBuf ?? "") + String(delta.partial_json ?? "");
        } else if (delta?.type === "thinking_delta" && block.type === "thinking") {
          block.thinkingBuf = (block.thinkingBuf ?? "") + String(delta.thinking ?? "");
        } else if (delta?.type === "signature_delta" && block.type === "thinking") {
          block.signatureBuf = (block.signatureBuf ?? "") + String(delta.signature ?? "");
        }
        break;
      }
      case "content_block_stop": {
        const index = parsed.index as number;
        const block = blocks.get(index);
        if (block?.type === "tool_use") {
          let input: unknown = {};
          const raw = block.toolUseJsonBuf ?? "";
          if (raw.length > 0) {
            try {
              input = JSON.parse(raw);
            } catch {
              input = { _raw: raw };
            }
          }
          toolUses.push({ id: block.toolUseId!, name: block.toolUseName!, input });
        } else if (block?.type === "thinking" && (block.thinkingBuf ?? "").length > 0) {
          thinkingBlocks.push({
            type: "thinking",
            thinking: block.thinkingBuf!,
            signature: block.signatureBuf ?? "",
          });
        }
        break;
      }
      case "message_delta": {
        info = extractStopInfo(parsed, info);
        break;
      }
      case "error": {
        const e = parsed as { type?: string; message?: string };
        throw new ProxyError(
          e.type ?? "stream_error",
          e.message ?? "stream emitted error event",
        );
      }
      default:
        break;
    }
  }

  return { text, toolUses, thinkingBlocks, info };
}

function extractStopInfo(payload: any, prev: ChatStopInfo): ChatStopInfo {
  return {
    stop_reason: payload?.delta?.stop_reason ?? prev.stop_reason,
    usage:
      payload?.usage && typeof payload.usage.output_tokens === "number"
        ? {
            input_tokens: payload.usage.input_tokens ?? 0,
            output_tokens: payload.usage.output_tokens,
            cache_creation_input_tokens:
              payload.usage.cache_creation_input_tokens,
            cache_read_input_tokens: payload.usage.cache_read_input_tokens,
          }
        : prev.usage,
  };
}

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
