/**
 * Anthropic client + prompt-caching helpers.
 *
 * Phase 1 wires the SDK and sets up cache_control breakpoints on stable
 * portions of the prompt (system + tools). Phase 4 will fill in real tools.
 *
 * Cache strategy (see shared/prompt-caching.md):
 *   1. cache_control on the last system block  → caches tools + system together
 *      (tools render before system in the prefix).
 *   2. top-level cache_control on messages.create() → auto-caches the last
 *      user/assistant turn so multi-turn conversations get prefix hits.
 *
 * Both fit inside the 4-breakpoint budget and keep volatile content
 * (per-turn user input) after the last breakpoint.
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "./env.js";

let cached: Anthropic | null = null;

export function getClient(): Anthropic {
  if (cached) return cached;
  const env = loadEnv();
  cached = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Reasonable default; SDK retries 429 + 5xx with exponential backoff.
    maxRetries: 2,
  });
  return cached;
}

/**
 * Coerce `system` (string | block array | undefined) into a block array
 * with `cache_control` on the final block. Accepts the same shapes the
 * Messages API does.
 */
export function withSystemCache(
  system: string | Anthropic.TextBlockParam[] | undefined,
): Anthropic.TextBlockParam[] | undefined {
  if (system == null) return undefined;
  const blocks: Anthropic.TextBlockParam[] =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : system.map((b) => ({ ...b }));
  if (blocks.length === 0) return undefined;
  const lastIdx = blocks.length - 1;
  blocks[lastIdx] = {
    ...blocks[lastIdx],
    cache_control: { type: "ephemeral" },
  };
  return blocks;
}

/**
 * Add `cache_control` to the last tool definition so the whole tools array
 * sits inside the cached prefix. Phase 4 will populate this; Phase 1 just
 * keeps the wiring correct.
 */
export function withToolsCache(
  tools: Anthropic.ToolUnion[] | undefined,
): Anthropic.ToolUnion[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const copy = tools.map((t) => ({ ...t }));
  const lastIdx = copy.length - 1;
  copy[lastIdx] = {
    ...copy[lastIdx],
    cache_control: { type: "ephemeral" },
  } as Anthropic.ToolUnion;
  return copy;
}
