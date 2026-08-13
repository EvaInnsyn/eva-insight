/**
 * POST /v1/access — stöðva eða opna aftur aðgang notanda að proxyinum.
 *
 * Neyðarrofinn. Ef eitthvað klikkar — óeðlileg notkun, deila sem fór úr
 * böndunum, viðskiptavinur sem á ekki að hafa aðgang lengur — þá stöðvar
 * stjórnstöðin bæði innskráninguna (Supabase-megin) og VIÐBÓTINA (hér).
 * Án þessa gæti viðbótin haldið áfram að brenna Anthropic-kvóta þótt búið
 * væri að loka mælaborðinu.
 *
 * Afturkræft af ásettu ráði: `restore` hreinsar `revoked_at` svo mistök
 * kosti ekki nýjan aðgang og nýtt token.
 *
 * Auth: Authorization: Bearer <EVA_INSIGHT_SHARED_SECRET>.
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { findUserBySupabaseId, revokeUser, restoreUser, listUsers } from "../db.js";

export const accessRoute = new Hono();

accessRoute.post("/", async (c) => {
  const env = loadEnv();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.EVA_INSIGHT_SHARED_SECRET) {
    return c.json(
      { error: { type: "authentication_error", message: "invalid secret" } },
      401,
    );
  }

  const body = (await c.req.json().catch(() => null)) as {
    supabaseUserId?: string;
    email?: string;
    action?: string;
  } | null;
  const action = body?.action;
  if (action !== "revoke" && action !== "restore") {
    return c.json({ ok: false, error: "action must be revoke or restore" }, 400);
  }

  // Notandinn finnst annaðhvort á Supabase-auðkenni eða netfangi (name-dálkurinn).
  let user = body?.supabaseUserId ? findUserBySupabaseId(body.supabaseUserId) : undefined;
  if (!user && body?.email) {
    const wanted = body.email.trim().toLowerCase();
    user = listUsers().find((u) => u.name.trim().toLowerCase() === wanted);
  }
  // Enginn proxy-notandi er ekki villa: viðkomandi hefur bara aldrei
  // paraði viðbótina. Mælaborðið stöðvast eftir sem áður.
  if (!user) return c.json({ ok: true, found: false, action });

  const updated = action === "revoke" ? revokeUser(user.id) : restoreUser(user.id);
  return c.json({
    ok: true,
    found: true,
    action,
    userId: user.id,
    email: user.name,
    revokedAt: updated?.revoked_at ?? null,
  });
});
