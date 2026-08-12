/**
 * GET /v1/me
 *
 * Returns the authed user's current usage + remaining budget so the side
 * panel can show "X / Y tokens used this month". Public to authenticated
 * tokens only.
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { authenticate, authErrorResponse } from "../auth.js";
import { expireLotsForUser, findUserById, nextLotExpiry, periodResetsAt } from "../db.js";

export const meRoute = new Hono();

meRoute.get("/", async (c) => {
  const env = loadEnv();
  const auth = await authenticate(
    c.req.header("authorization") ?? undefined,
    env.EVA_INSIGHT_SHARED_SECRET,
    env.SUPABASE_URL,
    { allowDepleted: true },
  );
  if ("error" in auth) return authErrorResponse(c, auth.error);

  if (auth.devUnlimited) {
    return c.json({
      mode: "dev_unlimited",
      message: "Authed via dev shared secret — no cap.",
    });
  }

  let u = auth.user!;
  if (auth.internal) {
    return c.json({
      mode: "internal",
      name: u.name,
      plan: "yfirsyn",
    });
  }
  if (u.credit_balance_isk !== null) {
    // Fyrna útrunnar lotur við lestur svo staðan sé alltaf rétt birt.
    if (expireLotsForUser(u.id) > 0) {
      u = findUserById(u.id) ?? u;
    }
    // Dashboards show the FULL purchased amount + % remaining — the tier's
    // burn rate is already applied at spend time, never in the display.
    const purchased = Math.max(0, Math.round(u.credit_granted_isk ?? 0));
    const balance = Math.max(0, Math.round(u.credit_balance_isk ?? 0));
    const percent =
      purchased > 0 ? Math.min(100, Math.max(0, Math.round((balance / purchased) * 100))) : 0;
    // „Rennur út eftir X daga" — næsta fyrning keyptrar inneignar.
    const expiry = nextLotExpiry(u.id);
    return c.json({
      mode: "credit",
      name: u.name,
      // No plan badge until the first purchase — a fresh account owns nothing.
      plan: purchased > 0 ? (u.plan ?? "innsyn") : null,
      balance_isk: balance,
      purchased_isk: purchased,
      percent_remaining: percent,
      ...(expiry
        ? {
            next_expiry_at: expiry.expires_at,
            expiring_isk: Math.round(expiry.balance_isk),
          }
        : {}),
    });
  }
  return c.json({
    mode: "metered",
    name: u.name,
    plan: u.plan ?? "innsyn",
    cap: {
      input_tokens: u.monthly_cap_input_tokens,
      output_tokens: u.monthly_cap_output_tokens,
    },
    used: {
      input_tokens: u.period_input_tokens,
      output_tokens: u.period_output_tokens,
    },
    period: {
      key: u.period_key,
      resets_at: periodResetsAt(),
    },
  });
});
