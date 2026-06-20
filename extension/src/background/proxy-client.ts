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
import type { ToolSchema } from "../shared/tools";
import { parseSseStream } from "./sse";
import type { EvaSettings } from "./settings";

export type { ProxyMessage };

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface RunChatArgs {
  settings: EvaSettings;
  system: string;
  messages: ProxyMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
  onToolUseStart?: (block: ToolUseBlock) => void;
}

export interface RunChatResult {
  /** Full assistant text for this turn (accumulated). */
  text: string;
  /** Tool calls the model wants executed. */
  toolUses: ToolUseBlock[];
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
  type: "text" | "tool_use" | "other";
  text?: string;
  toolUseId?: string;
  toolUseName?: string;
  toolUseJsonBuf?: string;
}

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    settings,
    system,
    messages,
    tools,
    signal,
    onTextDelta,
    onToolUseStart,
  } = args;

  const url = new URL("/v1/chat", settings.proxyUrl).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.sharedSecret}`,
    },
    body: JSON.stringify({
      system,
      messages,
      tools,
      max_tokens: 4096,
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
          // Emit early so the UI can show "Eva is using <tool>…" right away.
          // Final parsed input is fired internally via onToolUseStart for now
          // — Phase 4 UI doesn't act on intermediate JSON, only the final.
          onToolUseStart?.({
            id: cb.id,
            name: cb.name,
            input: cb.input ?? {},
          });
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
        } else if (
          delta?.type === "input_json_delta" &&
          block.type === "tool_use"
        ) {
          block.toolUseJsonBuf =
            (block.toolUseJsonBuf ?? "") + String(delta.partial_json ?? "");
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
          toolUses.push({
            id: block.toolUseId!,
            name: block.toolUseName!,
            input,
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

  return { text, toolUses, info };
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
