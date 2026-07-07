/**
 * POST /v1/chat
 *
 * Streams an Anthropic Messages response to the caller as SSE.
 * Phase 1 minimum-viable: bearer auth → validate body → call Anthropic
 * with caching → forward every event verbatim.
 *
 * Tool use is plumbed but not yet exercised — Phase 4 fills in the tool
 * registry and the agent loop.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../env.js";
import { getClient, withSystemCache, withToolsCache } from "../anthropic.js";
import { authenticate, authErrorResponse } from "../auth.js";
import { recordUsage } from "../db.js";

const ChatRequestSchema = z.object({
  /** Override the server default; otherwise pinned to Opus 4.6. */
  model: z.string().optional(),
  /** Optional plain string OR Anthropic system blocks. */
  system: z
    .union([z.string(), z.array(z.any())])
    .optional(),
  messages: z.array(z.any()).min(1, "messages must be non-empty"),
  max_tokens: z.number().int().min(1).max(128_000).optional(),
  /** Passed through. Caller decides adaptive vs disabled vs omitted. */
  thinking: z.any().optional(),
  /** Passed through. Phase 4 populates this. */
  tools: z.array(z.any()).optional(),
  /** Passed through. Caller can set effort/format/task_budget. */
  output_config: z.any().optional(),
  /** Optional metadata (e.g. user_id) — forwarded as-is. */
  metadata: z.any().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const chatRoute = new Hono();

chatRoute.post("/", async (c) => {
  const env = loadEnv();

  // --- Bearer auth + per-user cap ------------------------------------
  const authHeader = c.req.header("authorization") ?? undefined;
  const auth = await authenticate(authHeader, env.EVA_INSIGHT_SHARED_SECRET, env.SUPABASE_URL);
  if ("error" in auth) return authErrorResponse(c, auth.error);
  const user = auth.user; // null when authed via dev shared secret

  // --- Body validation -------------------------------------------------
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { type: "invalid_request_error", message: "body must be JSON" } },
      400,
    );
  }
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
      },
      400,
    );
  }
  const req = parsed.data;

  // --- Build Anthropic request ----------------------------------------
  const client = getClient();
  const model = req.model ?? env.EVA_INSIGHT_DEFAULT_MODEL;
  const maxTokens = req.max_tokens ?? 64_000; // streaming → safe headroom
  const system = withSystemCache(
    req.system as string | Anthropic.TextBlockParam[] | undefined,
  );
  const tools = withToolsCache(req.tools as Anthropic.ToolUnion[] | undefined);

  // Platform chat sends a browser Origin (app.evai.is); the extension's
  // background worker sends a chrome-extension origin or none.
  const origin = c.req.header("origin") ?? "";
  const usageSource: "extension" | "platform" =
    origin.includes("evai.is") || origin.includes("eva-innsyn.vercel.app")
      ? "platform"
      : "extension";

  // --- SSE passthrough -------------------------------------------------
  return streamSSE(c, async (sse) => {
    const abort = new AbortController();
    // Cancel upstream if the client disconnects.
    sse.onAbort(() => abort.abort());

    try {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          // Top-level auto-caching: caches the last cacheable block in
          // messages, so multi-turn conversations hit the cached prefix.
          cache_control: { type: "ephemeral" },
          ...(system ? { system } : {}),
          ...(tools ? { tools } : {}),
          ...(req.thinking ? { thinking: req.thinking } : {}),
          ...(req.output_config ? { output_config: req.output_config } : {}),
          ...(req.metadata ? { metadata: req.metadata } : {}),
          messages: req.messages as Anthropic.MessageParam[],
        },
        { signal: abort.signal },
      );

      let inputTokens = 0;
      let outputTokens = 0;

      try {
        for await (const event of stream) {
          if (sse.aborted) break;
          // Track usage as it accumulates so we still meter on early abort
          if (event.type === "message_start") {
            const usage = (event as { message?: { usage?: { input_tokens?: number } } })
              .message?.usage;
            inputTokens = usage?.input_tokens ?? inputTokens;
          } else if (event.type === "message_delta") {
            const usage = (event as { usage?: { output_tokens?: number } }).usage;
            if (typeof usage?.output_tokens === "number") {
              outputTokens = usage.output_tokens;
            }
          }
          await sse.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } finally {
        if (user && (inputTokens > 0 || outputTokens > 0)) {
          try {
            recordUsage(user.id, inputTokens, outputTokens, usageSource);
          } catch (e) {
            console.error("[eva-insight] failed to record usage", e);
          }
        }
      }
    } catch (err) {
      if (sse.aborted) return; // client gave up; nothing to report

      // Surface SDK errors as a final SSE event so the client can render
      // them inline instead of seeing a silent stream close.
      const errorEvent = serializeError(err);
      try {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify(errorEvent),
        });
      } catch {
        // Best-effort; if the socket is dead, swallow.
      }
    }
  });
});

function serializeError(err: unknown): {
  type: string;
  status?: number;
  message: string;
} {
  if (err instanceof Anthropic.APIError) {
    return {
      type: err.type ?? "api_error",
      status: err.status,
      message: err.message,
    };
  }
  if (err instanceof Error) {
    return { type: "server_error", message: err.message };
  }
  return { type: "server_error", message: String(err) };
}
