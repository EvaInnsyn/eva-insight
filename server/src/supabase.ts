/**
 * Minimal Supabase writer for the durable event bridge.
 *
 * The proxy owns the SQLite usage/credit ledger (90-day retention). To keep a
 * permanent, cross-tenant analytics history the Command Center can query, we
 * mirror meaningful events into the platform's Supabase `events` table.
 *
 * No @supabase/supabase-js dependency — we talk to PostgREST directly with the
 * service-role key. Everything here is a graceful no-op when SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY is unset, so the proxy runs fine before the bridge
 * is provisioned (deploy is safe; flip it on by adding the env var).
 */

import { loadEnv } from "./env.js";

export function bridgeEnabled(): boolean {
  const env = loadEnv();
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function creds(): { url: string; key: string } | null {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY };
}

// supabase_user_id → organisation_id. MEÐ líftíma (áskriftarkerfi 2b-3,
// 17.10.2026): fyrirtækið er það sem notandinn hefur VALIÐ á platforminum
// (fyrirtækjaflipar, switch_organisation), ekki fast. Án líftíma var minnið
// aldrei tæmt og notandi sem skipti um fyrirtæki var rukkaður á það fyrra
// þar til proxyinn var endurræstur.
const TENANT_TTL_MS = 60_000;
const tenantCache = new Map<string, { tenant: string; at: number }>();

/**
 * Resolve a user's organisation (tenant) id via the platform's users table.
 * Returns null if the user has no Supabase row yet (legacy tok_ users) or the
 * bridge is disabled — the caller then skips the write rather than guessing.
 */
export async function resolveTenantId(supabaseUserId: string): Promise<string | null> {
  const cached = tenantCache.get(supabaseUserId);
  if (cached && Date.now() - cached.at < TENANT_TTL_MS) return cached.tenant;
  const c = creds();
  if (!c) return null;

  try {
    const res = await fetch(
      `${c.url}/rest/v1/users?id=eq.${encodeURIComponent(supabaseUserId)}&select=organisation_id`,
      { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as { organisation_id?: string }[];
    const tenant = rows[0]?.organisation_id ?? null;
    if (tenant) tenantCache.set(supabaseUserId, { tenant, at: Date.now() });
    return tenant;
  } catch {
    return null;
  }
}

export interface BridgeEventRow {
  tenant_id: string;
  user_id: string | null;
  action: string;
  credits_used?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a batch of events into Supabase. Best-effort: returns the number of
 * rows written, or 0 on any failure (the proxy's own SQLite ledger remains the
 * source of truth, so a bridge hiccup never loses billing data).
 */
export async function insertEvents(rows: BridgeEventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const c = creds();
  if (!c) return 0;

  try {
    const res = await fetch(`${c.url}/rest/v1/events`, {
      method: "POST",
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(
        rows.map((r) => ({
          tenant_id: r.tenant_id,
          user_id: r.user_id,
          action: r.action,
          credits_used: r.credits_used ?? 0,
          metadata: r.metadata ?? {},
        })),
      ),
    });
    return res.ok ? rows.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Sameiginlegi potturinn: platformurinn er sannleikurinn um inneign.
 *
 * Slökkt með EVA_UNIFIED_CREDITS=off — neyðarhemill sem virkar án útgáfu.
 * Sjálfgefið kveikt þegar brúin er stillt, því annars situr peningurinn á
 * tveimur stöðum og viðskiptavinur sem notar bara spjallið tæmir vitlausan pott.
 */
export function unifiedCreditsEnabled(): boolean {
  if (process.env.EVA_UNIFIED_CREDITS === "off") return false;
  return bridgeEnabled();
}

export interface PlatformCredit {
  tenantId: string;
  /**
   * Hvers pottur greiðir: móðurfyrirtækið ef `billing_org_id` er sett
   * („Deila inneign"), annars fyrirtækið sjálft — sama regla og spend_credits.
   */
  payerId: string;
  /** Innifalin mánaðarinneign + ófyrnd keypt inneign GREIÐANDANS, í krónum. */
  balanceIsk: number;
  /** Verðþrep fyrirtækisins á platforminum (organisations.credit_tier). */
  tier: string | null;
  /**
   * Eigið álag fyrirtækisins (organisation_billing_terms.multiplier_override,
   * áskriftarkerfi 2c-4) — gengur fyrir þrepinu. null = þrepið ræður.
   */
  multiplierOverride: number | null;
}

/**
 * Staða viðskiptavinar í platform-pottinum, fundin út frá Supabase-auðkenni.
 *
 * Eitt kall, ekki tvö: tenant og staða koma saman svo hvert spjallkall bæti
 * ekki við tveimur netferðum. Skilar null ef notandinn er ekki tengdur
 * platforminum (gamlir tok_-notendur og prufu-notendur) — þá gildir
 * SQLite-staðan áfram.
 */
// Verðlagning platformsins per notanda (þrep + eigið álag), sett í hvert sinn
// sem staðan er sótt (auth-hliðið gerir það á hverju kalli). Gjaldfærslan
// notar það svo sami viðskiptavinur brenni á SAMA hraða hér og á platforminum.
export interface PlatformPricing {
  tier: string | null;
  multiplierOverride: number | null;
}
const pricingCache = new Map<string, PlatformPricing>();
export function cachedPlatformPricing(supabaseUserId: string): PlatformPricing | undefined {
  return pricingCache.get(supabaseUserId);
}

export async function platformCreditFor(
  supabaseUserId: string,
): Promise<PlatformCredit | null> {
  const c = creds();
  if (!c) return null;
  const tenantId = await resolveTenantId(supabaseUserId);
  if (!tenantId) return null;
  const headers = { apikey: c.key, Authorization: `Bearer ${c.key}` };

  try {
    const orgRes = await fetch(
      `${c.url}/rest/v1/organisations?id=eq.${tenantId}&select=credits_remaining,billing_org_id,credit_tier`,
      { headers },
    );
    if (!orgRes.ok) return null;
    const org = (await orgRes.json()) as {
      credits_remaining: number;
      billing_org_id: string | null;
      credit_tier: string | null;
    }[];
    if (!org[0]) return null;

    // „Deila inneign": barnið eyðir úr potti móðurinnar (spend_credits notar
    // coalesce(billing_org_id, id)). Fram að 17.10 las proxyinn pott BARNSINS,
    // sem er ~0, og hafnaði spjalli með 402 þótt móðirin ætti nóg.
    const payerId = org[0].billing_org_id ?? tenantId;
    let included = org[0].credits_remaining ?? 0;
    if (payerId !== tenantId) {
      const payerRes = await fetch(
        `${c.url}/rest/v1/organisations?id=eq.${payerId}&select=credits_remaining`,
        { headers },
      );
      if (!payerRes.ok) return null;
      const payer = (await payerRes.json()) as { credits_remaining: number }[];
      included = payer[0]?.credits_remaining ?? 0;
    }

    // Sérkjör (2c-4): eigið álag FYRIRTÆKISINS sem vinnur verkið — sama regla
    // og lib/billing/multiplier.ts á platforminum. Bregðist lesturinn gildir
    // þrepið; aldrei undir ×1.
    let multiplierOverride: number | null = null;
    const termsRes = await fetch(
      `${c.url}/rest/v1/organisation_billing_terms?organisation_id=eq.${tenantId}&select=multiplier_override`,
      { headers },
    );
    if (termsRes.ok) {
      const terms = (await termsRes.json()) as { multiplier_override: number | string | null }[];
      const v = terms[0]?.multiplier_override;
      const n = v === null || v === undefined ? null : Number(v);
      if (n !== null && Number.isFinite(n) && n >= 1) multiplierOverride = n;
    }

    const nowIso = new Date().toISOString();
    const lotsRes = await fetch(
      `${c.url}/rest/v1/credit_purchase_logs?tenant_id=eq.${payerId}&expired=is.false&expires_at=gt.${nowIso}&balance_remaining=gt.0&select=balance_remaining`,
      { headers },
    );
    if (!lotsRes.ok) return null;
    const lots = (await lotsRes.json()) as { balance_remaining: number }[];
    const purchased = lots.reduce((sum, l) => sum + Number(l.balance_remaining), 0);
    const pricing: PlatformPricing = { tier: org[0].credit_tier ?? null, multiplierOverride };
    pricingCache.set(supabaseUserId, pricing);
    return {
      tenantId,
      payerId,
      balanceIsk: Number(included) + purchased,
      ...pricing,
    };
  } catch {
    return null;
  }
}

/** Kall á Postgres-fall platformsins. null = netvilla eða 5xx (má reyna aftur). */
async function platformRpc<T>(
  fn: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; retryable: boolean; status?: number } | null> {
  const c = creds();
  if (!c) return null;
  try {
    const res = await fetch(`${c.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, retryable: res.status >= 500 || res.status === 429, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, retryable: true };
  }
}

export interface PlatformSpendResult {
  status: "charged" | "duplicate" | "insufficient" | "unknown_tenant";
  /** Það sem RAUNVERULEGA dróst af (0 við tvítekningu). */
  charged: number;
  balance: number | null;
}

/**
 * Gjaldfæra í platform-pottinum MEÐ AUÐKENNI (spend_credits_v2, 16.10.2026).
 * Sama auðkenni tvisvar = rukkað einu sinni, svo biðröðin má reyna aftur og
 * aftur án tvírukkunar.
 *
 * Skilar null þegar kallið mistókst á þann hátt að það má reyna aftur
 * (netvilla, 5xx) — kallarinn setur þá gjaldfærsluna í biðröð. ALDREI
 * fallið yfir á SQLite-inneignina (það var gamla leiðin, og hún rak í sundur).
 *
 * p_allow_partial: notkunin er þegar afstaðin, svo það er tekið það sem til
 * er (niður í 0) frekar en að hafna. Inneign fer aldrei í mínus.
 */
export async function spendPlatformCreditsV2(
  tenantId: string,
  amountIsk: number,
  key: string,
  ctx: Record<string, unknown>,
): Promise<PlatformSpendResult | null> {
  if (amountIsk <= 0) return { status: "charged", charged: 0, balance: null };
  const r = await platformRpc<{ status?: string; charged?: number; balance?: number | null }>(
    "spend_credits_v2",
    { p_tenant: tenantId, p_amount: amountIsk, p_key: key, p_allow_partial: true, p_ctx: ctx },
  );
  if (!r || !r.ok) return null;
  const status = r.data.status as PlatformSpendResult["status"] | undefined;
  if (!status) return null;
  return {
    status,
    charged: Number(r.data.charged ?? 0),
    balance: r.data.balance === null || r.data.balance === undefined ? null : Number(r.data.balance),
  };
}

/** Stofnar verk á platforminum (eva_tasks). null ef það mistekst (best-effort). */
export async function platformTaskStart(input: {
  tenantId: string;
  kind: "chat" | "extension_task";
  userId?: string | null;
  feature: string;
  bucketKey?: string | null;
}): Promise<string | null> {
  const r = await platformRpc<string>("task_start", {
    p_tenant: input.tenantId,
    p_kind: input.kind,
    p_initiated_by: "user",
    p_user: input.userId ?? null,
    p_feature: input.feature,
    p_bucket_key: input.bucketKey ?? null,
  });
  return r && r.ok ? r.data : null;
}

/** Skráir kall á verk. Best-effort. */
export async function platformTaskRecord(
  taskId: string,
  rawIsk: number,
  chargedIsk: number,
  failed = false,
): Promise<void> {
  await platformRpc("task_record_call", {
    p_task: taskId,
    p_raw: rawIsk,
    p_charged: chargedIsk,
    p_failed: failed,
  });
}

/** Lokar verki. Best-effort. */
export async function platformTaskFinish(
  taskId: string,
  status: "done" | "failed" | "cancelled" = "done",
): Promise<void> {
  await platformRpc("task_finish", { p_task: taskId, p_status: status });
}
