/**
 * POST /v1/events — durable analytics ingest.
 *
 * The extension (and any first-party client) posts meaningful events here;
 * the proxy stamps the source envelope and mirrors them into Supabase so the
 * Command Center has a permanent, cross-tenant history that outlives the
 * proxy's 90-day SQLite window.
 *
 * Auth: the caller's Supabase access token (same bearer as /v1/chat) — the
 * event is attributed to that user and their organisation. Best-effort: a
 * disabled bridge or a resolve miss returns ok:true with written:0 so the
 * client never has to care whether analytics succeeded.
 */

import { Hono } from "hono";
import { z } from "zod";
import { loadEnv } from "../env.js";
import { authenticate, authErrorResponse } from "../auth.js";
import { bridgeEnabled, resolveTenantId, insertEvents } from "../supabase.js";

const EVENT_VERSION = 1;

const EventSchema = z.object({
  name: z.string().min(1).max(64),
  session_id: z.string().max(128).optional(),
  task_id: z.string().max(128).optional(),
  feature_id: z.string().max(64).optional(),
  /** Free-form, size-capped to keep a runaway client from bloating the row. */
  properties: z.record(z.unknown()).optional(),
});

const BodySchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
});

export const eventsRoute = new Hono();

eventsRoute.post("/", async (c) => {
  const env = loadEnv();

  // Authenticate as the user (allowDepleted: analytics must work at 0 credits).
  const auth = await authenticate(
    c.req.header("authorization"),
    env.EVA_INSIGHT_SHARED_SECRET,
    env.SUPABASE_URL,
    { allowDepleted: true },
  );
  if ("error" in auth) return authErrorResponse(c, auth.error);
  const user = auth.user;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { type: "invalid_request_error", message: "body must be JSON" } },
      400,
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { type: "invalid_request_error", message: parsed.error.message } },
      400,
    );
  }

  // Bridge disabled or user not yet on the platform → accept and drop. The
  // client treats analytics as fire-and-forget; nothing depends on the write.
  // `diag` names the drop reason so an authed caller can tell config problems
  // (bridge off, key can't read/write) from genuine no-ops — no secrets in it.
  const supabaseUserId = user?.supabase_user_id ?? null;
  if (!bridgeEnabled()) return c.json({ ok: true, written: 0, diag: "bridge_disabled" });
  if (!supabaseUserId) return c.json({ ok: true, written: 0, diag: "no_supabase_user" });

  const tenantId = await resolveTenantId(supabaseUserId);
  if (!tenantId) return c.json({ ok: true, written: 0, diag: "no_tenant" });

  const rows = parsed.data.events.map((e) => ({
    tenant_id: tenantId,
    user_id: supabaseUserId,
    action: e.name,
    credits_used: 0,
    metadata: {
      _v: EVENT_VERSION,
      _source: "extension",
      ...(e.session_id ? { session_id: e.session_id } : {}),
      ...(e.task_id ? { task_id: e.task_id } : {}),
      ...(e.feature_id ? { feature_id: e.feature_id } : {}),
      ...(e.properties ?? {}),
    } as Record<string, unknown>,
  }));

  const written = await insertEvents(rows);
  return c.json({ ok: true, written, ...(written === 0 ? { diag: "insert_failed" } : {}) });
});
