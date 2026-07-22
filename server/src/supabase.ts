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
