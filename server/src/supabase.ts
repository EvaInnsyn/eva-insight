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

// Cache the supabase_user_id → organisation_id map; org membership is stable.
const tenantCache = new Map<string, string>();

/**
 * Resolve a user's organisation (tenant) id via the platform's users table.
 * Returns null if the user has no Supabase row yet (legacy tok_ users) or the
 * bridge is disabled — the caller then skips the write rather than guessing.
 */
export async function resolveTenantId(supabaseUserId: string): Promise<string | null> {
  const cached = tenantCache.get(supabaseUserId);
  if (cached) return cached;
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
    if (tenant) tenantCache.set(supabaseUserId, tenant);
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
  /** Innifalin mánaðarinneign + ófyrnd keypt inneign, í krónum. */
  balanceIsk: number;
}

/**
 * Staða viðskiptavinar í platform-pottinum, fundin út frá Supabase-auðkenni.
 *
 * Eitt kall, ekki tvö: tenant og staða koma saman svo hvert spjallkall bæti
 * ekki við tveimur netferðum. Skilar null ef notandinn er ekki tengdur
 * platforminum (gamlir tok_-notendur og prufu-notendur) — þá gildir
 * SQLite-staðan áfram.
 */
export async function platformCreditFor(
  supabaseUserId: string,
): Promise<PlatformCredit | null> {
  const c = creds();
  if (!c) return null;
  const tenantId = await resolveTenantId(supabaseUserId);
  if (!tenantId) return null;

  try {
    const nowIso = new Date().toISOString();
    const [orgRes, lotsRes] = await Promise.all([
      fetch(
        `${c.url}/rest/v1/organisations?id=eq.${tenantId}&select=credits_remaining,billing_org_id`,
        { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` } },
      ),
      fetch(
        `${c.url}/rest/v1/credit_purchase_logs?tenant_id=eq.${tenantId}&expired=is.false&expires_at=gt.${nowIso}&balance_remaining=gt.0&select=balance_remaining`,
        { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` } },
      ),
    ]);
    if (!orgRes.ok || !lotsRes.ok) return null;
    const org = (await orgRes.json()) as { credits_remaining: number }[];
    const lots = (await lotsRes.json()) as { balance_remaining: number }[];
    if (!org[0]) return null;
    const purchased = lots.reduce((s, l) => s + l.balance_remaining, 0);
    return { tenantId, balanceIsk: (org[0].credits_remaining ?? 0) + purchased };
  } catch {
    return null;
  }
}

/**
 * Gjaldfæra í platform-pottinum. Skilar nýrri stöðu, eða null ef kallið
 * mistókst — þá gjaldfærir kallarinn staðbundið svo notkun tapist ekki.
 *
 * p_allow_partial: notkunin er þegar afstaðin þegar hér er komið, svo það er
 * rangt að hafna henni. Betra að taka það sem til er og fara í mínus-núll en
 * að veita vinnuna ókeypis.
 */
export async function spendPlatformCredits(
  tenantId: string,
  amountIsk: number,
): Promise<number | null> {
  const c = creds();
  if (!c || amountIsk <= 0) return null;
  try {
    const res = await fetch(`${c.url}/rest/v1/rpc/spend_credits`, {
      method: "POST",
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_tenant: tenantId,
        p_amount: Math.round(amountIsk),
        p_allow_partial: true,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as number;
  } catch {
    return null;
  }
}
