/**
 * POST /v1/credit — server-to-server grant á keyptri inneign.
 *
 * Called by the Eva Innsýn platform when a „Kaupa inneign" package payment is
 * confirmed by the signed Kling webhook. Adds a purchased credit lot with a
 * 12-month expiry (expires_at comes from the platform so both ledgers agree).
 *
 * Idempotency lives on the platform side (Redis + unique index on the Kling
 * event id) — each confirmed purchase calls this exactly once.
 *
 * Auth: Authorization: Bearer <EVA_INSIGHT_SHARED_SECRET> (platform-held).
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { findOrCreateUserBySupabaseId, grantLot } from "../db.js";

export const creditRoute = new Hono();

creditRoute.post("/", async (c) => {
  const env = loadEnv();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.EVA_INSIGHT_SHARED_SECRET) {
    return c.json(
      { error: { type: "authentication_error", message: "invalid secret" } },
      401,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { type: "invalid_request_error", message: "body must be JSON" } },
      400,
    );
  }
  const { supabase_user_id, email, amount_isk, expires_at } = (body ?? {}) as {
    supabase_user_id?: string;
    email?: string;
    amount_isk?: number;
    expires_at?: string;
  };

  if (!supabase_user_id || typeof supabase_user_id !== "string") {
    return c.json(
      { error: { type: "invalid_request_error", message: "supabase_user_id required" } },
      400,
    );
  }
  const amount = Math.round(Number(amount_isk));
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json(
      { error: { type: "invalid_request_error", message: "amount_isk must be > 0" } },
      400,
    );
  }
  const expiry =
    typeof expires_at === "string" && !Number.isNaN(Date.parse(expires_at))
      ? new Date(expires_at).toISOString()
      : null;
  if (!expiry) {
    return c.json(
      { error: { type: "invalid_request_error", message: "expires_at (ISO) required" } },
      400,
    );
  }

  const user = findOrCreateUserBySupabaseId(
    supabase_user_id,
    typeof email === "string" && email ? email : supabase_user_id,
  );
  const balance = grantLot(user.id, "purchased", amount, expiry, `kaup:inneign:${amount}`);

  return c.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      credit_balance_isk: Math.round(balance),
      expires_at: expiry,
    },
  });
});
