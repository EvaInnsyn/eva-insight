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
import { randomUUID } from "node:crypto";
import { chargeCredit, recordUsage, cachePlatformBalance } from "../db.js";
import {
  cachedPlatformTier,
  platformTaskFinish,
  platformTaskRecord,
  platformTaskStart,
  resolveTenantId,
  spendPlatformCreditsV2,
  unifiedCreditsEnabled,
} from "../supabase.js";
import { enqueueCharge, queueAtCap } from "../platformQueue.js";
import { costIsk, isOpenAiModel, rawCostIsk } from "../pricing.js";
import { spendMultiplier } from "../tiers.js";
import { streamOpenAi, systemToText, toOpenAiMessages } from "../openai.js";

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
  /** Anthropic beta flags (e.g. computer-use) — forwarded as a header. */
  betas: z.array(z.string().max(64)).max(8).optional(),
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

  // ChatGPT er valkvætt módel í Evu-spjallinu (27. ágúst 2026). Sé lykillinn
  // ekki settur á Railway er það einfaldlega ekki í boði — og notandinn á að
  // fá að vita það, ekki þögult afturhvarf á Claude sem lítur út eins og
  // valið hafi ekki virkað.
  const useOpenAi = isOpenAiModel(model);
  if (useOpenAi && !env.OPENAI_API_KEY) {
    return c.json(
      {
        error: {
          type: "model_unavailable",
          message: "ChatGPT er ekki í boði á þessum þjóni (OPENAI_API_KEY vantar).",
        },
      },
      503,
    );
  }
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

  // --- Platformið: verk + pása (áskriftarkerfi 2b-3, 17.10.2026) -------
  // Notandi tengdur platforminum er rukkaður ÞAR, aldrei í SQLite. Hvert
  // spjallkall er eitt verk (eva_tasks); viðbótin getur sent x-eva-task-id
  // svo öll köll eins viðbótarverks safnist í eitt verk.
  const platformUid =
    user && !auth.internal && unifiedCreditsEnabled() ? user.supabase_user_id : null;
  const platformTenant = platformUid ? await resolveTenantId(platformUid) : null;
  if (platformTenant && queueAtCap(platformTenant)) {
    // Þakregla Vigdísar: ógreitt í biðröð (platforminn svaraði ekki) má ekki
    // vaxa endalaust — Eva fer í pásu þar til biðröðin er greidd.
    return c.json(
      {
        error: {
          type: "eva_paused",
          message: "Eva er í stuttri pásu á meðan greiðslukerfið svarar ekki. Reyndu aftur eftir smástund.",
        },
      },
      503,
    );
  }
  const extTask = c.req.header("x-eva-task-id") ?? "";
  const bucketKey = /^[A-Za-z0-9_-]{1,64}$/.test(extTask) ? `ext:${extTask}` : null;
  const taskId = platformTenant
    ? await platformTaskStart({
        tenantId: platformTenant,
        kind: usageSource === "extension" ? "extension_task" : "chat",
        userId: platformUid,
        feature: usageSource === "extension" ? "extension" : "chat",
        bucketKey,
      })
    : null;
  // Auðkenni gjaldfærslunnar: auðkenni skeytisins frá Anthropic þegar það
  // berst (message_start), annars einkvæmt — búið til ÁÐUR en kallið fer.
  let chargeKey = `chat:${randomUUID()}`;
  let usageRecorded = false;

  // --- SSE passthrough -------------------------------------------------
  return streamSSE(c, async (sse) => {
    const abort = new AbortController();
    // Cancel upstream if the client disconnects.
    sse.onAbort(() => abort.abort());

    try {
      let inputTokens = 0;
      let outputTokens = 0;
      // H4 — prompt-cache visibility. If cacheRead stays 0 across a
      // multi-round task, the tools/system prefix is being invalidated
      // (a silent tax that both slows AND costs). Logged once per request.
      let cacheReadTokens = 0;
      let cacheCreateTokens = 0;

      try {
        if (useOpenAi) {
          // ChatGPT-leiðin. Straumurinn er ÞÝDDUR yfir í sömu SSE-atburði og
          // Anthropic sendir, svo vafrinn viti ekki muninn og
          // `lib/eva/chat.ts` þurfi enga breytingu. Mælingin fyrir neðan er
          // óbreytt — hún tekur bara model + tokens.
          await streamOpenAi({
            apiKey: env.OPENAI_API_KEY!,
            model,
            messages: toOpenAiMessages(
              req.messages as { role: string; content: unknown }[],
              systemToText(
                req.system as string | { type?: string; text?: string }[] | undefined,
              ),
            ),
            maxTokens,
            signal: abort.signal,
            handlers: {
              aborted: () => sse.aborted,
              onText: async (text) => {
                await sse.writeSSE({
                  event: "content_block_delta",
                  data: JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text },
                  }),
                });
              },
              onUsage: (inTok, outTok) => {
                inputTokens = inTok;
                outputTokens = outTok;
              },
            },
          });
        } else {
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
          {
            signal: abort.signal,
            ...(req.betas?.length
              ? { headers: { "anthropic-beta": req.betas.join(",") } }
              : {}),
          },
        );
        for await (const event of stream) {
          if (sse.aborted) break;
          // Track usage as it accumulates so we still meter on early abort
          if (event.type === "message_start") {
            const msgId = (event as { message?: { id?: string } }).message?.id;
            if (msgId) chargeKey = `chat:${msgId}`;
            const usage = (event as {
              message?: {
                usage?: {
                  input_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              };
            }).message?.usage;
            inputTokens = usage?.input_tokens ?? inputTokens;
            cacheReadTokens = usage?.cache_read_input_tokens ?? cacheReadTokens;
            cacheCreateTokens =
              usage?.cache_creation_input_tokens ?? cacheCreateTokens;
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
        }
      } finally {
        // One compact cache line per request. hit% = read / (read + fresh input).
        const cacheable = cacheReadTokens + inputTokens;
        const hitPct = cacheable > 0 ? Math.round((cacheReadTokens / cacheable) * 100) : 0;
        console.log(
          `[cache] model=${model} read=${cacheReadTokens} create=${cacheCreateTokens} freshIn=${inputTokens} out=${outputTokens} hit=${hitPct}%`,
        );
        if (user && (inputTokens > 0 || outputTokens > 0)) {
          try {
            recordUsage(user.id, inputTokens, outputTokens, usageSource, model);
            // Innanhúss users are never charged — usage bills straight to
            // the Anthropic console (recordUsage above keeps admin stats).
            if (user.credit_balance_isk !== null && !auth.internal) {
              if (platformTenant && platformUid) {
                // Platforminn er sannleikurinn um inneign. Raunkostnaður MEÐ
                // cache-tokens (sama regla og platformurinn), álag eftir
                // verðþrepi platformsins.
                const raw = rawCostIsk(
                  model,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreateTokens,
                );
                const tier = cachedPlatformTier(platformUid) ?? user.tier;
                const charge = raw * spendMultiplier(tier);
                const ctx = {
                  action: usageSource === "extension" ? "extension" : "chat",
                  feature: usageSource === "extension" ? "extension" : "chat",
                  user_id: platformUid,
                  cost_isk_raw: raw,
                  ...(taskId ? { task_id: taskId } : {}),
                };
                const res = await spendPlatformCreditsV2(platformTenant, charge, chargeKey, ctx);
                if (res) {
                  if (res.balance !== null) cachePlatformBalance(user.id, Math.max(0, res.balance));
                  if (taskId) await platformTaskRecord(taskId, raw, res.charged);
                } else {
                  // Platforminn svaraði ekki: í biðröð með SAMA auðkenni,
                  // reynt aftur á mínútu fresti. Aldrei á SQLite.
                  enqueueCharge({
                    key: chargeKey,
                    tenantId: platformTenant,
                    amountIsk: charge,
                    rawIsk: raw,
                    ctx,
                    taskId,
                  });
                }
                usageRecorded = true;
                if (taskId && !bucketKey) await platformTaskFinish(taskId, "done");
              } else {
                // Notandi EKKI tengdur platforminum (gamlir tok_-notendur):
                // SQLite-inneignin eins og áður.
                const cost = costIsk(
                  model,
                  inputTokens,
                  outputTokens,
                  spendMultiplier(user.tier),
                );
                chargeCredit(user.id, cost, "notkun");
              }
            }
          } catch (e) {
            console.error("[eva-insight] failed to record usage", e);
          }
        }
        // Notandinn hætti áður en nokkur token voru unnin: verkinu lokað sem
        // hætt við (villur fara í catch hér fyrir neðan og verða 'failed').
        if (taskId && !usageRecorded && !bucketKey && sse.aborted) {
          await platformTaskFinish(taskId, "cancelled").catch(() => {});
        }
      }
    } catch (err) {
      // Kall sem mistókst: skráð á verkið, aldrei rukkað.
      if (taskId && !usageRecorded) {
        await platformTaskRecord(taskId, 0, 0, true).catch(() => {});
        if (!bucketKey) await platformTaskFinish(taskId, "failed").catch(() => {});
      }
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
