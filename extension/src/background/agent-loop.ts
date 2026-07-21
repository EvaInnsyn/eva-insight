/**
 * Eva's agent loop.
 *
 * One user turn → up to N rounds of (assistant text + tool calls →
 * [confirm each if needed →] execute tools → continue). Loop ends when
 * Claude says end_turn, stop_reason flips to refusal/max_tokens, or we
 * hit MAX_TOOL_ROUNDS.
 */

import { runTool, probeDisplayDims, releaseDebugger, setToolAuthContext, setRunAttachments } from "./tools";
import {
  ProxyError,
  fetchMemory, runChat,
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
import { bindTaskTab, getActiveTab, getTaskTab } from "./page-bridge";

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
      step_results?: unknown[];
    };
    if (
      typeof parsed.mime_type === "string" &&
      parsed.mime_type.startsWith("image/") &&
      typeof parsed.base64 === "string" &&
      parsed.base64.length > 0
    ) {
      const blocks: unknown[] = [];
      // Anthropic guidance: text BEFORE the image improves click accuracy —
      // the model reads what happened/where it is before parsing pixels.
      const label = [parsed.title, parsed.url].filter(Boolean).join(" · ");
      // Mixed-batch tool steps (find/read_page/…) return data the model
      // needs — it must ride along as text, not vanish behind the image.
      const steps =
        Array.isArray(parsed.step_results) && parsed.step_results.length > 0
          ? JSON.stringify(parsed.step_results).slice(0, 14_000)
          : "";
      const preface = [parsed.note, steps, label].filter(Boolean).join("\n");
      if (preface) blocks.push({ type: "text", text: preface });
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mime_type,
          data: parsed.base64,
        },
      });
      return blocks;
    }
  } catch {
    // Not JSON — send as-is.
  }
  return output;
}

/**
 * Replace old screenshot images with short placeholders — in BATCHES.
 *
 * Anthropic's harness guidance is explicit: pruning one screenshot every
 * turn rewrites the prompt prefix every turn and invalidates the prompt
 * cache on every request (full input price + latency each round). So the
 * strip boundary only advances in steps of PRUNE_BATCH: between prune
 * events the prefix stays byte-identical and the cache stays hot. We keep
 * at least KEEP_LAST_IMAGES and at most KEEP+BATCH-1 images; all shots are
 * <=1400px so many-image dimension limits don't apply.
 *
 * Image-level, not message-level: a long agentic turn stores all its tool
 * results inside ONE user message, so message-level pruning kept everything.
 */
const KEEP_LAST_IMAGES = 3;
const PRUNE_BATCH = 8;

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

  // Boundary advances only in whole batches → cache-stable prefix.
  const excess = Math.max(0, positions.length - KEEP_LAST_IMAGES);
  const stripCount = Math.floor(excess / PRUNE_BATCH) * PRUNE_BATCH;
  if (stripCount === 0) return messages;
  const drop = new Set(
    positions.slice(0, stripCount).map((p) => `${p.msg}:${p.block}:${p.item}`),
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
/**
 * Move the conversation-side cache breakpoint to the LAST tool_result block
 * (Anthropic guidance: breakpoints on the most recent tool results, advancing
 * each turn — earlier segments keep hitting hierarchically). Old markers are
 * removed; block CONTENT is untouched so the prefix bytes stay identical.
 */
function advanceCacheBreakpoint(messages: ProxyMessage[]): ProxyMessage[] {
  let lastMsg = -1;
  let lastBlock = -1;
  messages.forEach((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return;
    (m.content as any[]).forEach((b, bi) => {
      if (b?.type === "tool_result") {
        lastMsg = mi;
        lastBlock = bi;
      }
    });
  });
  if (lastMsg === -1) return messages;
  return messages.map((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    let changed = false;
    const blocks = (m.content as any[]).map((b, bi) => {
      if (b?.type !== "tool_result") return b;
      const isTarget = mi === lastMsg && bi === lastBlock;
      const hasMark = b.cache_control != null;
      if (isTarget && !hasMark) {
        changed = true;
        return { ...b, cache_control: { type: "ephemeral" } };
      }
      if (!isTarget && hasMark) {
        changed = true;
        const { cache_control: _omit, ...rest } = b;
        return rest;
      }
      return b;
    });
    return changed ? { ...m, content: blocks } : m;
  });
}

function pruneMessages(messages: ProxyMessage[]): ProxyMessage[] {
  const stripped = advanceCacheBreakpoint(stripOldScreenshots(messages));
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
  /** Verkefnamappan sem verkið vistast í, með minni Evu úr möppunni. */
  taskFolder?: { id: string; name: string; memory?: string };
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
  const { settings, accessToken, signal, callbacks, taskFolder } = args;
  const messages: ProxyMessage[] = [...args.initialMessages];

  // Live copy of allowed domains (we may add to it mid-loop).
  let allowedDomains = [...(settings.allowedDomains ?? [])];

  let lastInfo: ChatStopInfo = { stop_reason: null };
  let endedTurn = false;
  // Consecutive rounds that only LOOKED (screenshot/find/read) without
  // changing anything — the over-verification loop signature.
  let passiveStreak = 0;

  // Bind this run to the tab the user is on RIGHT NOW. From here on every
  // tool acts on that tab, even if the user goes off to read email in
  // another tab — Eva keeps working on hers (screenshots via CDP when it's
  // in the background). tabs_switch/tabs_create move the binding on purpose.
  try {
    const startTab = await getActiveTab();
    bindTaskTab(startTab.id ?? null);
  } catch {
    bindTaskTab(null); // no usable tab yet — first tool call rebinds
  }

  // Hand the model its context up-front: tab title/URL (kills the
  // get_active_tab round that opens nearly every task) and Eva's lasting
  // memory about this user (proxy-stored, user-editable in Settings).
  // Injected only into the OUTGOING copy; panel history never sees it.
  {
    const memoryPromise = fetchMemory(settings, accessToken ?? null);
    let ctx = "";
    try {
      const tab = await getTaskTab();
      if (tab.url) {
        ctx += `\n\n[auto context] Your task tab: "${(tab.title ?? "").slice(0, 120)}" — ${tab.url.slice(0, 300)}`;
      }
    } catch {
      // protected page or no tab — the model discovers context via tools
    }
    const memory = await memoryPromise;
    if (memory) {
      ctx += `\n\n[auto context] Eva's saved memory about this user (keep current via the remember tool):\n${memory}`;
    }
    if (taskFolder) {
      ctx += `\n\n[auto context] This task is filed in the project folder "${taskFolder.name}" (chosen by the user in the panel; never re-ask which folder).`;
      if (taskFolder.memory) {
        ctx += ` Recent work in this folder:\n${taskFolder.memory}\nIf the current request clearly continues that earlier work, briefly offer to pick up where it left off before starting; otherwise just proceed.`;
      }
    }
    if (ctx) {
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          messages[messages.length - 1] = { ...last, content: last.content + ctx };
        } else if (Array.isArray(last.content)) {
          messages[messages.length - 1] = {
            ...last,
            content: [...last.content, { type: "text", text: ctx.trim() }],
          };
        }
      }
    }
  }

  // Declare the computer tool's display size from the live viewport so the
  // model's coordinates match the screenshots exactly. Once per run.
  const display = await probeDisplayDims();
  const tools = buildEvaTools(display);
  // Deep find calls the proxy itself — give tools this run's auth.
  setToolAuthContext({ settings, accessToken: accessToken ?? null });

  // Viðhengi keyrslunnar: myndir/PDF úr user-skeytunum (nýjast fremst) svo
  // save_to_folder geti vistað þau beint í möppu án þess að módelið
  // endurtaki bætin.
  {
    interface Harvested { name: string; mime: string; base64: string }
    const atts: Harvested[] = [];
    for (const msg of messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      const found: Harvested[] = [];
      let imgN = 0;
      for (const raw of msg.content as Array<Record<string, unknown>>) {
        const type = raw?.type;
        const src = raw?.source as { media_type?: string; data?: string } | undefined;
        if (type === "image" && src?.data) {
          imgN += 1;
          const mime = src.media_type ?? "image/jpeg";
          found.push({ name: `mynd-${imgN}.${mime.split("/")[1] ?? "jpg"}`, mime, base64: src.data });
        } else if (type === "document") {
          const title = typeof raw.title === "string" ? raw.title : "skjal.pdf";
          found.push({ name: title, mime: src?.media_type ?? "application/pdf", base64: src?.data ?? "" });
        }
      }
      atts.unshift(...found);
    }
    setRunAttachments(atts);
  }

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

    // Navigation policy origin comes from the TASK tab — the page Eva is
    // actually on — never from whatever tab the user happens to be viewing.
    let activeOrigin: string | undefined;
    try {
      const tab = await getTaskTab();
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
    // Over-verification guard: if Eva only observed this round (no state-
    // changing action), count it; after two in a row, tell her to wrap up.
    const PASSIVE_COMPUTER = new Set(["screenshot", "zoom", "wait", "cursor_position", "mouse_move", "scroll_to"]);
    const OBSERVE_TOOLS = new Set([
      "read_page", "find", "get_active_tab", "get_page_text",
      "read_console", "read_network", "tabs_list",
    ]);
    const changedState = result.toolUses.some((tu) => {
      if (OBSERVE_TOOLS.has(tu.name)) return false;
      if (tu.name === "computer") {
        const act = (tu.input as { action?: string } | null)?.action ?? "";
        return !PASSIVE_COMPUTER.has(act);
      }
      return true; // batch, click, type, navigate, upload, js, tabs_* …
    });
    passiveStreak = changedState ? 0 : passiveStreak + 1;
    if (passiveStreak >= 2) {
      toolResultBlocks.push({
        type: "text",
        text: "[harness] You've now spent multiple rounds only observing without acting. If the task is complete, END YOUR TURN NOW with your one-line result. Only continue if there is a concrete next ACTION to take.",
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
  setRunAttachments([]);
  bindTaskTab(null);
  await releaseDebugger().catch(() => {});

  return { info: lastInfo, messages, paused };
}

export { ProxyError };
