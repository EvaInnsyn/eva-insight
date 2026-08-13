/**
 * POST /v1/trial — prufu-inneign (1500 kr, 30 dagar) veitt úr stjórnstöðinni.
 *
 * Til vegna þess að gamla leiðin gat ekki virkað: platformurinn sendir JSON en
 * `/admin/grant-trial` les `parseBody()` sem tekur aðeins form, og sú slóð er
 * auk þess varin með lykilorðs-cookie sem S2S-kall hefur ekki. Þessi endi
 * notar sömu auðkenningu og aðrir S2S-endar og tekur JSON.
 *
 * Auth: Authorization: Bearer <EVA_INSIGHT_SHARED_SECRET>.
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { grantTrialByEmail } from "../db.js";

export const trialRoute = new Hono();

trialRoute.post("/", async (c) => {
  const env = loadEnv();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.EVA_INSIGHT_SHARED_SECRET) {
    return c.json(
      { error: { type: "authentication_error", message: "invalid secret" } },
      401,
    );
  }

  const body = (await c.req.json().catch(() => null)) as { email?: string } | null;
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ ok: false, error: "invalid email" }, 400);
  }

  const user = grantTrialByEmail(email);
  return c.json({
    ok: true,
    userId: user.id,
    email: user.name,
    balanceIsk: Math.round(user.credit_balance_isk ?? 0),
    expiresAt: user.trial_expires_at,
  });
});
