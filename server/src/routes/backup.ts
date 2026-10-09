/**
 * Næturafrit SQLite-skrárinnar upp í Supabase Storage (9.10.2026).
 *
 * Railway Hobby-planið býður enga innbyggða afritun af diskum (staðfest í
 * stjórnborðinu með Vigdísi) og á disknum lifa notendur viðbótarinnar,
 * notkunarsagan og prufunotendur sem eiga EKKERT eintak annars staðar.
 * Afritið fer því í Supabase Storage — kerfi sem er sjálft afritað daglega
 * (Pro frá 8.10).
 *
 * Kveikjan er platformurinn: /api/cron/proxy-backup (pg_cron daglega) kallar
 * hingað S2S. Auth: sama deilda leyndarmál og /v1/admin-stats.
 * `better-sqlite3` .backup() tekur samkvæmt afrit í miðri notkun.
 */
import { Hono } from "hono";
import { readFileSync, unlinkSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadEnv } from "../env.js";
import { getDb } from "../db.js";

export const backupRoute = new Hono();

const BUCKET = "proxy-backups";
const KEEP_DAYS = 14;
/** Yfir þessu er eitthvað óeðlilegt í gangi — ekki hlaða upp í blindni. */
const MAX_BYTES = 200 * 1024 * 1024;

function storageHeaders(serviceKey: string): Record<string, string> {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

backupRoute.post("/", async (c) => {
  const env = loadEnv();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.EVA_INSIGHT_SHARED_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return c.json({ error: "supabase_not_configured" }, 500);
  }
  const headers = storageHeaders(env.SUPABASE_SERVICE_ROLE_KEY);

  // Fatan til ef hún vantar (409 = þegar til, í lagi).
  await fetch(`${env.SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  }).catch(() => undefined);

  const stamp = new Date().toISOString().slice(0, 10);
  const tmpPath = join(tmpdir(), `eva-sqlite-${stamp}.db`);
  await getDb().backup(tmpPath);

  try {
    const size = statSync(tmpPath).size;
    if (size > MAX_BYTES) {
      return c.json({ error: "backup_too_large", size }, 500);
    }
    const body = readFileSync(tmpPath);
    const objectPath = `sqlite/eva-${stamp}.db`;
    const up = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "x-upsert": "true",
        },
        body,
      }
    );
    if (!up.ok) {
      const detail = await up.text().catch(() => "");
      return c.json({ error: `upload_failed ${up.status}: ${detail.slice(0, 200)}` }, 502);
    }

    // Grisjun: allt eldra en KEEP_DAYS fer.
    let pruned = 0;
    const listRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "sqlite/", limit: 100 }),
    });
    if (listRes.ok) {
      const items = (await listRes.json()) as { name: string; created_at?: string }[];
      const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
      for (const item of items) {
        const m = item.name.match(/eva-(\d{4}-\d{2}-\d{2})\.db$/);
        if (!m) continue;
        if (new Date(m[1]).getTime() < cutoff) {
          const del = await fetch(
            `${env.SUPABASE_URL}/storage/v1/object/${BUCKET}/sqlite/${item.name}`,
            { method: "DELETE", headers }
          );
          if (del.ok) pruned++;
        }
      }
    }

    return c.json({ ok: true, object: objectPath, size, pruned });
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp-skráin hreinsast þá með tmpdir — ekki fella afritið á því.
    }
  }
});
