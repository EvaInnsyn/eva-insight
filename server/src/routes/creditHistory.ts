/**
 * GET /v1/credit-history — inneignarsagan, lesin af stjórnstöð platformsins.
 *
 * Til svo hægt sé að svara einni spurningu sem kerfið gat hvergi svarað:
 * **keypti þessi viðskiptavinur inneignina sína, eða fékk hann hana gefins?**
 * Staðan ein og sér segir það ekki — sagan gerir það, í reason-strengnum.
 *
 * Flokkunin er gerð hér svo báðar hliðar séu sammála um merkinguna:
 *   kaup:*      -> purchase   (staðfest greiðsla gegnum Kling)
 *   admin:*     -> grant      (gefið handvirkt í gamla adminu)
 *   trial:*     -> trial      (prufu-inneign)
 *   fyrning:*   -> expiry     (fyrnt, félli niður)
 *   notkun      -> usage      (brennsla við notkun)
 *
 * Auth: Authorization: Bearer <EVA_INSIGHT_SHARED_SECRET> — sama traust og
 * /v1/admin-stats. Skrifar ekkert, les bara.
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { listAllCreditEvents } from "../db.js";

export const creditHistoryRoute = new Hono();

export type CreditEntryKind = "purchase" | "grant" | "trial" | "expiry" | "usage" | "other";

function classify(reason: string): CreditEntryKind {
  if (reason.startsWith("kaup:")) return "purchase";
  if (reason.startsWith("admin:")) return "grant";
  if (reason.startsWith("trial:")) return "trial";
  if (reason.startsWith("fyrning:")) return "expiry";
  if (reason === "notkun") return "usage";
  return "other";
}

const MAX_LIMIT = 2000;

creditHistoryRoute.get("/", (c) => {
  const env = loadEnv();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.EVA_INSIGHT_SHARED_SECRET) {
    return c.json(
      { error: { type: "authentication_error", message: "invalid secret" } },
      401,
    );
  }

  const raw = Number(c.req.query("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : 500;

  // Notkunarfærslur eru margar og smáar; stjórnstöðin spyr um peningahreyfingar.
  const includeUsage = c.req.query("usage") === "1";

  const entries = listAllCreditEvents(limit)
    .map((e) => ({
      ts: e.ts,
      email: e.email,
      supabaseUserId: e.supabase_user_id,
      deltaIsk: Math.round(e.delta_isk),
      balanceAfterIsk: Math.round(e.balance_after),
      reason: e.reason,
      kind: classify(e.reason),
    }))
    .filter((e) => includeUsage || e.kind !== "usage");

  return c.json({ ok: true, generatedAt: new Date().toISOString(), entries });
});
