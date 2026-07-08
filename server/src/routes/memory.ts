/**
 * GET  /v1/memory  — Eva's lasting note about this user (side panel + runs).
 * POST /v1/memory  — replace it (from Eva's `remember` tool or Settings UI).
 *
 * Full-replace semantics: the client composes the updated note (current
 * memory is always injected into the run, so Eva edits with full context).
 */

import { Hono } from "hono";
import { z } from "zod";
import { loadEnv } from "../env.js";
import { authenticate, authErrorResponse } from "../auth.js";
import { getMemory, setMemory, MEMORY_MAX_CHARS } from "../db.js";

export const memoryRoute = new Hono();

const putSchema = z.object({
  content: z.string().max(MEMORY_MAX_CHARS, `memory is capped at ${MEMORY_MAX_CHARS} chars`),
});

memoryRoute.get("/", async (c) => {
  const env = loadEnv();
  const auth = await authenticate(
    c.req.header("authorization") ?? undefined,
    env.EVA_INSIGHT_SHARED_SECRET,
    env.SUPABASE_URL,
  );
  if ("error" in auth) return authErrorResponse(c, auth.error);
  if (auth.devUnlimited || !auth.user) {
    return c.json({ content: "", updated_at: null, mode: "dev_unlimited" });
  }
  return c.json(getMemory(auth.user.id));
});

memoryRoute.post("/", async (c) => {
  const env = loadEnv();
  const auth = await authenticate(
    c.req.header("authorization") ?? undefined,
    env.EVA_INSIGHT_SHARED_SECRET,
    env.SUPABASE_URL,
  );
  if ("error" in auth) return authErrorResponse(c, auth.error);
  if (auth.devUnlimited || !auth.user) {
    return c.json(
      { error: { type: "invalid_request_error", message: "dev token has no memory store" } },
      400,
    );
  }
  const body = putSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json(
      { error: { type: "invalid_request_error", message: body.error.issues[0]?.message ?? "invalid body" } },
      400,
    );
  }
  setMemory(auth.user.id, body.data.content);
  return c.json({ ok: true, chars: body.data.content.length });
});
