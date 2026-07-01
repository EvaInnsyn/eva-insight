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
 * Trims old messages when the conversation grows too large.
 * Always cuts at a "clean" user turn (string content = real question)
 * so tool_use/tool_result pairs are never split.
 */
function pruneMessages(messages: ProxyMessage[]): ProxyMessage[] {
  if (JSON.stringify(messages).length <= MAX_HISTORY_CHARS) return messages;

  // Find indices where a real user question starts (string content, not tool results).
  const cleanStarts = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user" && typeof m.content === "string");

  // Walk from most-recent clean start backwards until the slice fits.
  for (let j = cleanStarts.length - 1; j >= 0; j--) {
    const slice = messages.slice(cleanStarts[j].i);
    if (JSON.stringify(slice).length <= MAX_HISTORY_CHARS) return slice;
  }

  // Last resort: just the final 2 messages.
  return messages.slice(-2);
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

    // Assistant turn with tool_use blocks
    const assistantBlocks: unknown[] = [];
    if (result.text.length > 0) {
      assistantBlocks.push({ type: "text", text: result.text });
    }
    for (const tu of result.toolUses) {
      assistantBlocks.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
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
        content: output,
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  return { info: lastInfo, messages };
}

export { ProxyError };
