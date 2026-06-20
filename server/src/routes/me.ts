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
import { periodResetsAt } from "../db.js";

export const meRoute = new Hono();

meRoute.get("/", (c) => {
  const env = loadEnv();
  const auth = authenticate(
    c.req.header("authorization") ?? undefined,
    env.EVA_INSIGHT_SHARED_SECRET,
  );
  if ("error" in auth) return authErrorResponse(c, auth.error);

  if (auth.devUnlimited) {
    return c.json({
      mode: "dev_unlimited",
      message: "Authed via dev shared secret — no cap.",
    });
  }

  const u = auth.user!;
  return c.json({
    mode: "metered",
    name: u.name,
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
