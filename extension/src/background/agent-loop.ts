/**
 * Eva's agent loop.
 *
 * One user turn → up to N rounds of (assistant text + tool calls →
 * [confirm each if needed →] execute tools → continue). Loop ends when
 * Claude says end_turn, stop_reason flips to refusal/max_tokens, or we
 * hit MAX_TOOL_ROUNDS.
 */

import { runTool } from "./tools";
import {
  ProxyError,
  runChat,
  type ProxyMessage,
  type ToolUseBlock,
} from "./proxy-client";
import type { EvaSettings } from "./settings";
import type { ChatStopInfo } from "../shared/chat";
import {
  EVA_SYSTEM_PROMPT,
  EVA_TOOLS,
  needsConfirmation,
} from "../shared/tools";
import { getActiveTab } from "./page-bridge";

const MAX_TOOL_ROUNDS = 20;

// ~400K chars ≈ 100K tokens — leaves headroom for system prompt, tools, and output.
const MAX_HISTORY_CHARS = 400_000;

/**
 * Converts a tool result output string into the right Anthropic content shape.
 * Screenshot results carry base64 image data and need to be sent as image
 * content blocks so Claude can actually see them (not read them as text).
 */
function buildToolResultContent(output: string, isError: boolean): unknown {
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
      typeof parsed.base64 === "string"
    ) {
      const blocks: unknown[] = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mime_type,
            data: parsed.base64,
          },
        },
      ];
      const label = [parsed.title, parsed.url].filter(Boolean).join(" · ");
      if (label) blocks.push({ type: "text", text: label });
      return blocks;
    }
  } catch {
    // Not JSON — send as-is.
  }
  return output;
}

/**
 * Replace base64 image data in older tool results with a short placeholder.
 * Screenshots are 400-800KB each — keeping them all blows the context window
 * and causes pruneMessages to cut the original user question. We only need
 * the most recent screenshot for visual context; older ones can be summarised.
 */
function stripOldScreenshots(messages: ProxyMessage[]): ProxyMessage[] {
  // Find indices of tool-result turns that contain an image block.
  const imageIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as unknown[];
      if (blocks.some((b: any) => b?.type === "tool_result" &&
        (Array.isArray(b?.content)
          ? b.content.some((c: any) => c?.type === "image")
          : false))) {
        imageIndices.push(i);
      }
    }
  });

  // Keep the last screenshot intact; strip all earlier ones.
  if (imageIndices.length <= 1) return messages;
  const toStrip = new Set(imageIndices.slice(0, -1));

  return messages.map((m, i) => {
    if (!toStrip.has(i)) return m;
    const blocks = (m.content as unknown[]).map((b: any) => {
      if (b?.type !== "tool_result" || !Array.isArray(b?.content)) return b;
      return {
        ...b,
        content: b.content.map((c: any) =>
          c?.type === "image"
            ? { type: "text", text: "[screenshot — removed to save context]" }
            : c
        ),
      };
    });
    return { ...m, content: blocks };
  });
}

/**
 * Approximate the *context-relevant* size of the history, EXCLUDING base64
 * image data. A single screenshot is ~1MB of base64 — if we counted that
 * toward MAX_HISTORY_CHARS, the limit would blow the moment any screenshot
 * existed, forcing pruneMessages to drop the whole conversation (including
 * the original task) and leaving Eva with "your message came through empty".
 * Images are already bounded to one by stripOldScreenshots, so they must NOT
 * drive conversation pruning. We count each image as a small fixed cost.
 */
function measuredSize(messages: ProxyMessage[]): number {
  const IMAGE_COST = 2_000;
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content)) {
      total += JSON.stringify(m.content ?? "").length;
      continue;
    }
    for (const block of m.content as any[]) {
      if (block?.type === "image") {
        total += IMAGE_COST;
      } else if (block?.type === "tool_result" && Array.isArray(block.content)) {
        for (const c of block.content as any[]) {
          total += c?.type === "image" ? IMAGE_COST : JSON.stringify(c ?? "").length;
        }
      } else {
        total += JSON.stringify(block ?? "").length;
      }
    }
  }
  return total;
}

/**
 * Trims old messages when the conversation grows too large.
 * Always cuts at a "clean" user turn (string content = real question)
 * so tool_use/tool_result pairs are never split.
 */
function pruneMessages(messages: ProxyMessage[]): ProxyMessage[] {
  const stripped = stripOldScreenshots(messages);
  if (measuredSize(stripped) <= MAX_HISTORY_CHARS) return stripped;

  // Find indices where a real user question starts (string content, not tool results).
  const cleanStarts = stripped
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user" && typeof m.content === "string");

  // Walk from most-recent clean start backwards until the slice fits.
  for (let j = cleanStarts.length - 1; j >= 0; j--) {
    const slice = stripped.slice(cleanStarts[j].i);
    if (measuredSize(slice) <= MAX_HISTORY_CHARS) return slice;
  }

  // Last resort: just the final 2 messages.
  return stripped.slice(-2);
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void;
  onToolStart: (block: ToolUseBlock, startedAt: string) => void;
  onToolEnd: (
    toolUseId: string,
    output: string,
    isError: boolean,
    finishedAt: string,
  ) => void;
  /**
   * Resolves to true if the user allows the action, false if they deny.
   * The returned `rememberOrigin` (if any) should be persisted to settings.
   */
  onConfirm: (req: {
    toolName: string;
    prompt: string;
    allowAlways?: { kind: "domain"; origin: string };
  }) => Promise<{ allow: boolean; rememberOrigin?: string }>;
}

export interface AgentLoopArgs {
  settings: EvaSettings;
  /** Supabase access token for Railway auth — overrides settings.sharedSecret. */
  accessToken?: string | null;
  initialMessages: ProxyMessage[];
  signal: AbortSignal;
  callbacks: AgentCallbacks;
  /** Called with an updated allowedDomains list when the user opts to remember a domain. */
  onAllowedDomainsChange?: (next: string[]) => void;
}

export async function runAgentLoop(
  args: AgentLoopArgs,
): Promise<{ info: ChatStopInfo; messages: ProxyMessage[] }> {
  const { settings, accessToken, signal, callbacks } = args;
  const messages: ProxyMessage[] = [...args.initialMessages];

  // Live copy of allowed domains (we may add to it mid-loop).
  let allowedDomains = [...(settings.allowedDomains ?? [])];

  let lastInfo: ChatStopInfo = { stop_reason: null };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) break;

    const result = await runChat({
      settings,
      accessToken,
      system: EVA_SYSTEM_PROMPT,
      messages: pruneMessages(messages),
      tools: EVA_TOOLS,
      signal,
      onTextDelta: callbacks.onTextDelta,
      onToolUseStart: (tu) => {
        callbacks.onToolStart(tu, new Date().toISOString());
      },
    });
    lastInfo = result.info;

    if (result.toolUses.length === 0) {
      if (result.text.length > 0) {
        messages.push({ role: "assistant", content: result.text });
      }
      break;
    }

    // Assistant turn: thinking blocks must precede text + tool_use (API requirement).
    const assistantBlocks: unknown[] = [];
    for (const tb of result.thinkingBlocks) {
      assistantBlocks.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature });
    }
    if (result.text.length > 0) {
      assistantBlocks.push({ type: "text", text: result.text });
    }
    for (const tu of result.toolUses) {
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    messages.push({ role: "assistant", content: assistantBlocks });

    // Get current active tab origin for navigation policy
    let activeOrigin: string | undefined;
    try {
      const tab = await getActiveTab();
      if (tab.url) activeOrigin = new URL(tab.url).origin;
    } catch {
      // not blocking — needsConfirmation will fall back to prompting
    }

    // Run each tool, asking confirmation when needed.
    const toolResultBlocks: unknown[] = [];
    for (const tu of result.toolUses) {
      if (signal.aborted) break;

      const confirm = needsConfirmation(tu.name, tu.input, {
        activeOrigin,
        allowedDomains,
      });

      let blocked = false;
      let blockedReason = "";

      if (confirm) {
        const decision = await callbacks.onConfirm({
          toolName: tu.name,
          prompt: confirm.prompt,
          allowAlways: confirm.allowAlways,
        });
        if (!decision.allow) {
          blocked = true;
          blockedReason = "user denied this action";
        } else if (decision.rememberOrigin) {
          if (!allowedDomains.includes(decision.rememberOrigin)) {
            allowedDomains = [...allowedDomains, decision.rememberOrigin];
            args.onAllowedDomainsChange?.(allowedDomains);
          }
        }
      }

      let output: string;
      let isError: boolean;
      if (blocked) {
        output = JSON.stringify({
          error: { type: "user_denied", message: blockedReason },
        });
        isError = true;
      } else {
        const r = await runTool(tu.name, tu.input);
        output = r.output;
        isError = r.isError;
      }
      const finishedAt = new Date().toISOString();
      callbacks.onToolEnd(tu.id, output, isError, finishedAt);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: buildToolResultContent(output, isError),
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  return { info: lastInfo, messages };
}

export { ProxyError };
