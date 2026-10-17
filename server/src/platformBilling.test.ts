/**
 * Áskriftarkerfi 2b-3 (17.10.2026): ein rukkunarleið proxysins.
 * Keyrt með `npm test` (node:test + tsx). Engin tenging út á við — fetch er falsað.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ANTHROPIC_API_KEY = "prof";
process.env.EVA_INSIGHT_SHARED_SECRET = process.env.EVA_INSIGHT_SHARED_SECRET ?? "prof-leyndarmal-langt";
process.env.SUPABASE_URL = "https://prof.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "prof-lykill";
process.env.EVA_USD_ISK = "140";

const { initDb } = await import("./db.js");
initDb(join(mkdtempSync(join(tmpdir(), "eva-prof-")), "eva.db"));

const { rawCostIsk } = await import("./pricing.js");
const { platformCreditFor, resolveTenantId, spendPlatformCreditsV2, cachedPlatformPricing } =
  await import("./supabase.js");
const { enqueueCharge, pendingIskFor, queueAtCap, drainQueue } = await import("./platformQueue.js");

// ─── Falsað fetch ────────────────────────────────────────────────────────────
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler = () => new Response("[]", { status: 200 });
const calls: { url: string; body?: unknown }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return handler(url, init);
}) as typeof fetch;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  handler = () => json([]);
});

// ─── Verðlagning með cache-tokens ────────────────────────────────────────────
test("cache: skrif 1,25×, lestur 0,1× inntaksverðs (Sonnet 4.6, $3/M inntak)", () => {
  // 1M ferskt inntak = $3; 1M skrif = $3,75; 1M lestur = $0,30 → $7,05 × 140
  const isk = rawCostIsk("claude-sonnet-4-6", 1_000_000, 0, 1_000_000, 1_000_000);
  assert.equal(Math.round(isk * 100) / 100, Math.round(7.05 * 140 * 100) / 100);
});

test("cache: Opus 5.5 les á 0,05× (ekki 0,1×)", () => {
  // óþekkt módel verðlagt sem Sonnet ($3) — Opus 5.5 er ekki í MODEL_PRICES,
  // en lestrarhlutfallið fer eftir nafninu: 1M lestur = $3 × 0,05 = $0,15
  const isk = rawCostIsk("claude-opus-5-5", 0, 0, 1_000_000, 0);
  assert.equal(Math.round(isk * 100) / 100, Math.round(0.15 * 140 * 100) / 100);
});

// ─── Inneign greiðandans ─────────────────────────────────────────────────────
test("Deila inneign: staðan er MÓÐURINNAR, og þrepið fyrirtækisins geymt", async () => {
  handler = (url) => {
    if (url.includes("/users?")) return json([{ organisation_id: "barn" }]);
    if (url.includes("organisations?id=eq.barn"))
      return json([{ credits_remaining: 0, billing_org_id: "modir", credit_tier: "vinir" }]);
    if (url.includes("organisations?id=eq.modir")) return json([{ credits_remaining: 700 }]);
    if (url.includes("credit_purchase_logs?tenant_id=eq.modir")) return json([{ balance_remaining: 300 }]);
    return json([]);
  };
  const c = await platformCreditFor("uid-deila");
  assert.deepEqual(c, { tenantId: "barn", payerId: "modir", balanceIsk: 1000, tier: "vinir", multiplierOverride: null });
  assert.deepEqual(cachedPlatformPricing("uid-deila"), { tier: "vinir", multiplierOverride: null });
  // Lotur sóttar fyrir GREIÐANDANN, ekki barnið:
  assert.ok(calls.some((x) => x.url.includes("credit_purchase_logs?tenant_id=eq.modir")));
  assert.ok(!calls.some((x) => x.url.includes("credit_purchase_logs?tenant_id=eq.barn")));
});

test("sérkjör (2c-4): eigið álag lesið af fyrirtækinu sjálfu og sett í skyndiminni; undir ×1 hunsað", async () => {
  let override: number | string | null = 1.25;
  handler = (url) => {
    if (url.includes("/users?")) return json([{ organisation_id: "org-alag" }]);
    if (url.includes("organisations?id=eq.org-alag"))
      return json([{ credits_remaining: 500, billing_org_id: null, credit_tier: "almennt" }]);
    if (url.includes("organisation_billing_terms?organisation_id=eq.org-alag"))
      return json([{ multiplier_override: override }]);
    return json([]);
  };
  const c = await platformCreditFor("uid-alag");
  assert.equal(c?.multiplierOverride, 1.25);
  assert.deepEqual(cachedPlatformPricing("uid-alag"), { tier: "almennt", multiplierOverride: 1.25 });

  override = "0.5"; // PostgREST skilar numeric sem streng
  assert.equal((await platformCreditFor("uid-alag"))?.multiplierOverride, null);
  override = null;
  assert.equal((await platformCreditFor("uid-alag"))?.multiplierOverride, null);
});

test("fyrirtækjaminnið rennur út — skipti um fyrirtæki ná í gegn", async (t) => {
  let org = "fyrra";
  handler = (url) => (url.includes("/users?") ? json([{ organisation_id: org }]) : json([]));
  assert.equal(await resolveTenantId("uid-skipti"), "fyrra");
  org = "seinna";
  assert.equal(await resolveTenantId("uid-skipti"), "fyrra", "innan líftíma: minnið");
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => realNow() + 61_000;
  assert.equal(await resolveTenantId("uid-skipti"), "seinna", "eftir líftíma: nýtt fyrirtæki");
});

// ─── Frádráttur með auðkenni ─────────────────────────────────────────────────
test("spend_credits_v2: auðkenni og samhengi send, svarið lesið", async () => {
  handler = () => json({ status: "charged", charged: 8, balance: 92 });
  const r = await spendPlatformCreditsV2("org", 8, "chat:msg_1", { feature: "chat", task_id: "t1" });
  assert.deepEqual(r, { status: "charged", charged: 8, balance: 92 });
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.p_key, "chat:msg_1");
  assert.equal(body.p_allow_partial, true);
  assert.deepEqual(body.p_ctx, { feature: "chat", task_id: "t1" });
});

test("spend_credits_v2: netvilla og 5xx → null (fer í biðröð)", async () => {
  handler = () => {
    throw new Error("niðri");
  };
  assert.equal(await spendPlatformCreditsV2("org", 8, "k1", {}), null);
  handler = () => json({ message: "bilað" }, 503);
  assert.equal(await spendPlatformCreditsV2("org", 8, "k2", {}), null);
});

// ─── Biðröðin og þakið ───────────────────────────────────────────────────────
test("biðröð: sama auðkenni tvisvar = ein röð; þakið 100 kr setur Evu í pásu", () => {
  const base = { tenantId: "org-bid", rawIsk: 30, ctx: {}, taskId: null };
  enqueueCharge({ ...base, key: "q1", amountIsk: 60 });
  enqueueCharge({ ...base, key: "q1", amountIsk: 60 });
  assert.equal(pendingIskFor("org-bid"), 60);
  assert.equal(queueAtCap("org-bid"), false);
  enqueueCharge({ ...base, key: "q2", amountIsk: 40 });
  assert.equal(pendingIskFor("org-bid"), 100);
  assert.equal(queueAtCap("org-bid"), true);
});

test("biðröð: platforminn niðri → röðin bíður; kominn upp → greitt einu sinni og skráð á verkið", async () => {
  enqueueCharge({ key: "q3", tenantId: "org-drain", amountIsk: 10, rawIsk: 5, ctx: { feature: "chat" }, taskId: "verk-1" });

  handler = () => {
    throw new Error("niðri");
  };
  await drainQueue();
  assert.equal(pendingIskFor("org-drain"), 10, "enn í biðröð");

  handler = (url) =>
    url.includes("spend_credits_v2") ? json({ status: "charged", charged: 10, balance: 50 }) : json(null);
  calls.length = 0;
  await drainQueue();
  assert.equal(pendingIskFor("org-drain"), 0, "greitt og horfið");
  const spend = calls.filter((x) => x.url.includes("spend_credits_v2") && (x.body as { p_key?: string }).p_key === "q3");
  assert.equal(spend.length, 1, "sama auðkenni, eitt kall");
  const rec = calls.find((x) => x.url.includes("task_record_call"));
  assert.deepEqual(rec?.body, { p_task: "verk-1", p_raw: 5, p_charged: 10, p_failed: false });
});
