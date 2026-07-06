/**
 * POST /v1/plan — server-to-server plan activation.
 *
 * Called by the Eva Innsýn platform when a payment is confirmed (Kling claim
 * paid / checkout success). Sets the user's plan AND both token caps, creating
 * the user row if they haven't touched the proxy yet — so a client who pays
 * before ever opening the extension still lands on the right plan.
 *
 * Auth: Authorization: Bearer <EVA_INSIGHT_SHARED_SECRET> (platform-held).
 * Never exposed to browsers — CORS still applies but the secret is the gate.
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { findOrCreateUserBySupabaseId, setUserPlan } from "../db.js";
import { PLANS, type PlanId } from "../plans.js";

export const planRoute = new Hono();

planRoute.post("/", async (c) => {
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
  const { supabase_user_id, email, plan } = (body ?? {}) as {
    supabase_user_id?: string;
    email?: string;
    plan?: string;
  };

  if (!supabase_user_id || typeof supabase_user_id !== "string") {
    return c.json(
      { error: { type: "invalid_request_error", message: "supabase_user_id required" } },
      400,
    );
  }
  if (!plan || !(plan in PLANS)) {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: `plan must be one of: ${Object.keys(PLANS).join(", ")}`,
        },
      },
      400,
    );
  }

  const user = findOrCreateUserBySupabaseId(
    supabase_user_id,
    typeof email === "string" && email ? email : supabase_user_id,
  );
  const updated = setUserPlan(user.id, plan as PlanId)!;

  return c.json({
    ok: true,
    user: {
      id: updated.id,
      name: updated.name,
      plan: updated.plan,
      monthly_cap_input_tokens: updated.monthly_cap_input_tokens,
      monthly_cap_output_tokens: updated.monthly_cap_output_tokens,
    },
  });
});
