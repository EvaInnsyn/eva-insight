/**
 * Eva's agent loop.
 *
 * One user turn → up to N rounds of (assistant text + tool calls →
 * [confirm each if needed →] execute tools → continue). Loop ends when
 * Claude says end_turn, stop_reason flips to refusal/max_tokens, or we
 * hit MAX_TOOL_ROUNDS.
 */

import { runTool, probeDisplayDims, releaseDebugger, setToolAuthContext } from "./tools";
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
  buildEvaTools,
  needsConfirmation,
} from "../shared/tools";
import { getActiveTab } from "./page-bridge";

// Big multi-step editor tasks (recolour a whole theme, wire up several pages)
// legitimately need many rounds. This is a runaway-loop backstop that protects
// the user's per-user token budget if Eva ever gets stuck — NOT a normal-task
// ceiling. Hitting it is graceful: she tells the user and resumes on "haltu
// áfram" (memory carries progress), so a generous value is low-risk.
const MAX_TOOL_ROUNDS = 60;

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
      note?: string;
    };
    if (
      typeof parsed.mime_type === "string" &&
      parsed.mime_type.startsWith("image/") &&
      typeof parsed.base64 === "string" &&
      parsed.base64.length > 0
    ) {
      const blocks: unknown[] = [];
      // Batch results carry a note ("completed 5/5 steps…") — text first so
      // the model reads the outcome before looking at the screenshot.
      if (typeof parsed.note === "string" && parsed.note) {
        blocks.push({ type: "text", text: parsed.note });
      }
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mime_type,
          data: parsed.base64,
        },
      });
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
 * Replace all but the newest few screenshot images with short placeholders.
 *
 * Must operate at the IMAGE level, not the message level: a long agentic turn
 * stores ALL its tool results (30+ screenshots) inside ONE user message, so
 * "keep the last message with images" keeps every one of them. Replaying
 * dozens of images trips Anthropic's many-image limits ("image dimensions
 * exceed max allowed size for many-image requests: 2000 pixels") and bloats
 * the payload. Keeping the last 2 images preserves visual continuity while
 * guaranteeing every request stays a small-image-count request.
 */
const KEEP_LAST_IMAGES = 2;

function stripOldScreenshots(messages: ProxyMessage[]): ProxyMessage[] {
  // Collect the position of every image block inside tool_result content.
  const positions: { msg: number; block: number; item: number }[] = [];
  messages.forEach((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return;
    (m.content as any[]).forEach((b, bi) => {
      if (b?.type !== "tool_result" || !Array.isArray(b.content)) return;
      (b.content as any[]).forEach((c, ci) => {
        if (c?.type === "image") positions.push({ msg: mi, block: bi, item: ci });
      });
    });
  });

  if (positions.length <= KEEP_LAST_IMAGES) return messages;
  const drop = new Set(
    positions
      .slice(0, positions.length - KEEP_LAST_IMAGES)
      .map((p) => `${p.msg}:${p.block}:${p.item}`),
  );

  return messages.map((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    let changed = false;
    const blocks = (m.content as any[]).map((b, bi) => {
      if (b?.type !== "tool_result" || !Array.isArray(b.content)) return b;
      const inner = (b.content as any[]).map((c, ci) => {
        if (c?.type === "image" && drop.has(`${mi}:${bi}:${ci}`)) {
          changed = true;
          return { type: "text", text: "[screenshot — removed to save context]" };
        }
        return c;
      });
      return { ...b, content: inner };
    });
    return changed ? { ...m, content: blocks } : m;
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
): Promise<{ info: ChatStopInfo; messages: ProxyMessage[]; paused: boolean }> {
  const { settings, accessToken, signal, callbacks } = args;
  const messages: ProxyMessage[] = [...args.initialMessages];

  // Live copy of allowed domains (we may add to it mid-loop).
  let allowedDomains = [...(settings.allowedDomains ?? [])];

  let lastInfo: ChatStopInfo = { stop_reason: null };
  let endedTurn = false;

  // Declare the computer tool's display size from the live viewport so the
  // model's coordinates match the screenshots exactly. Once per run.
  const display = await probeDisplayDims();
  const tools = buildEvaTools(display);
  // Deep find calls the proxy itself — give tools this run's auth.
  setToolAuthContext({ settings, accessToken: accessToken ?? null });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) break;

    // Enforced silence while working: text produced in a round that goes on
    // to call tools is play-by-play — keep it in the API history (coherence)
    // but never show it. Only a round that ENDS the turn flushes its text to
    // the panel, so the user sees action cards while Eva works and exactly
    // one message when she's done.
    const result = await runChat({
      settings,
      accessToken,
      system: EVA_SYSTEM_PROMPT,
      messages: pruneMessages(messages),
      tools,
      signal,
      onTextDelta: () => {},
      onToolUseStart: (tu) => {
        callbacks.onToolStart(tu, new Date().toISOString());
      },
    });
    lastInfo = result.info;

    if (result.toolUses.length === 0) {
      if (result.text.length > 0) {
        callbacks.onTextDelta(result.text);
        messages.push({ role: "assistant", content: result.text });
      }
      endedTurn = true;
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

  // `paused` = hit the round cap with work still in flight (never reached
  // end_turn). The background turns this into a user-facing note that's aware
  // of the user's monthly budget — so it can warn before continuing eats the
  // rest of their usage. Cross-turn memory means "haltu áfram" resumes cleanly.
  const paused = !endedTurn && !signal.aborted;

  // Drop the CDP session promptly so Chrome's debugger bar clears when Eva
  // finishes instead of lingering for the idle timeout.
  setToolAuthContext(null);
  await releaseDebugger().catch(() => {});

  return { info: lastInfo, messages, paused };
}

export { ProxyError };
