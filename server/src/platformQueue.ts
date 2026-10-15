/**
 * Biðröð gjaldfærslna á platforminn (áskriftarkerfi 2b-3, 17.10.2026).
 *
 * Þegar platforminn svarar ekki (netvilla, 5xx) eftir spjall- eða viðbótarkall
 * er gjaldfærslan EKKI felld niður og EKKI færð á SQLite-inneignina (gamla
 * leiðin, sem rak í sundur við platforminn og var aldrei stemmd af). Hún fer
 * hingað og er reynd aftur með SAMA auðkenni, svo hún rukkast nákvæmlega
 * einu sinni hvenær sem platforminn kemur aftur.
 *
 * ÞAKREGLA VIGDÍSAR (16.10): ógreitt í biðröð má aldrei vaxa umfram lítið
 * þak per fyrirtæki. Nái það þakinu fer Eva í pásu hjá því fyrirtæki
 * (chat.ts skilar 503) þar til biðröðin tæmist — frekar en að vinna áfram
 * ókeypis á meðan platforminn er niðri.
 */

import { getDb } from "./db.js";
import { platformTaskRecord, spendPlatformCreditsV2 } from "./supabase.js";

/** Hámark ógreidds í biðröð per fyrirtæki, í kr (sjálfgefið 100 kr = 5 % viðmiðunar). */
export function queueCapIsk(): number {
  const v = Number(process.env.EVA_QUEUE_CAP_ISK);
  return Number.isFinite(v) && v > 0 ? v : 100;
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pending_platform_charges (
      charge_key  TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      amount_isk  REAL NOT NULL,
      raw_isk     REAL NOT NULL,
      ctx         TEXT NOT NULL,
      task_id     TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_platform_charges_tenant ON pending_platform_charges(tenant_id);
  `);
  ensured = true;
}

export interface PendingCharge {
  key: string;
  tenantId: string;
  amountIsk: number;
  rawIsk: number;
  ctx: Record<string, unknown>;
  taskId: string | null;
}

/** Setur gjaldfærslu í biðröð. Sama auðkenni tvisvar = ein röð. */
export function enqueueCharge(c: PendingCharge): void {
  ensureTable();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_platform_charges
         (charge_key, tenant_id, amount_isk, raw_isk, ctx, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.key, c.tenantId, c.amountIsk, c.rawIsk, JSON.stringify(c.ctx), c.taskId, new Date().toISOString());
}

/** Ógreitt í biðröð fyrir fyrirtæki, í kr. */
export function pendingIskFor(tenantId: string): number {
  ensureTable();
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(amount_isk), 0) AS s FROM pending_platform_charges WHERE tenant_id = ?`)
    .get(tenantId) as { s: number };
  return Number(row?.s ?? 0);
}

/** Er fyrirtækið komið að þakinu? Þá fer Eva í pásu hjá því. */
export function queueAtCap(tenantId: string): boolean {
  return pendingIskFor(tenantId) >= queueCapIsk();
}

/**
 * Reynir allar gjaldfærslur í biðröð aftur. Árangur → röðin hverfur og kallið
 * skráist á verkið. Netvilla → beðið til næstu umferðar.
 */
export async function drainQueue(): Promise<{ done: number; left: number }> {
  ensureTable();
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM pending_platform_charges ORDER BY created_at ASC LIMIT 200`)
    .all() as {
    charge_key: string;
    tenant_id: string;
    amount_isk: number;
    raw_isk: number;
    ctx: string;
    task_id: string | null;
  }[];
  let done = 0;
  for (const r of rows) {
    const res = await spendPlatformCreditsV2(r.tenant_id, r.amount_isk, r.charge_key, JSON.parse(r.ctx));
    if (!res) {
      db.prepare(
        `UPDATE pending_platform_charges SET attempts = attempts + 1, last_error = 'unreachable' WHERE charge_key = ?`,
      ).run(r.charge_key);
      continue;
    }
    // charged / duplicate / insufficient / unknown_tenant eru öll ENDANLEG svör
    // platformsins — ekkert að reyna aftur. ('insufficient' kemur ekki með
    // allow_partial nema fyrirtækið sé horfið.)
    if (r.task_id && res.status === "charged") {
      await platformTaskRecord(r.task_id, r.raw_isk, res.charged);
    }
    db.prepare(`DELETE FROM pending_platform_charges WHERE charge_key = ?`).run(r.charge_key);
    done++;
  }
  const left = (db.prepare(`SELECT COUNT(*) AS n FROM pending_platform_charges`).get() as { n: number }).n;
  return { done, left };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Ræsir endurtekningu á mínútu fresti (kallað úr index.ts). */
export function startQueueWorker(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    drainQueue()
      .then(({ done, left }) => {
        if (done > 0 || left > 0) console.log(`[platform-queue] greitt=${done} eftir=${left}`);
      })
      .catch((e) => console.error("[platform-queue] villa", e));
  }, intervalMs);
  timer.unref?.();
}
