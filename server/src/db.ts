/**
 * SQLite store for per-user pairing tokens + usage metering.
 *
 * One table: `users`. Schema migrations are handled in `initDb()` —
 * additive only (we never DROP) so existing deployments keep working.
 *
 * Plans: INNSÝN ($45 cap), YFIRSÝN ($100 cap), UMSJÁ ($150 cap).
 * See plans.ts for token limits per plan.
 */

import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PLANS, DEFAULT_PLAN, type PlanId } from "./plans.js";

export interface User {
  /** Prepaid ISK balance; null = legacy monthly-cap user. */
  credit_balance_isk: number | null;
  /** Lifetime sum of positive credit grants — the denominator for "% eftir". */
  credit_granted_isk: number;
  /** Verðþrep: fjolskylda / vinir / almennt (see tiers.ts). */
  tier: string;
  id: string;
  name: string;
  token: string;
  plan: PlanId;
  monthly_cap_input_tokens: number;
  monthly_cap_output_tokens: number;
  period_input_tokens: number;
  period_output_tokens: number;
  /** YYYY-MM (the month these counters belong to). */
  period_key: string;
  created_at: string;
  revoked_at: string | null;
  /** Supabase auth id (public.users.id on the platform); null for legacy tok_ users. */
  supabase_user_id: string | null;
  /** ISO timestamp when trial expires; null = no trial or trial active forever. */
  trial_expires_at: string | null;
}

let db: Database.Database | null = null;

export function initDb(filepath = "data/eva.db"): Database.Database {
  if (db) return db;
  const abs = resolve(process.cwd(), filepath);
  mkdirSync(dirname(abs), { recursive: true });
  db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      monthly_cap_input_tokens INTEGER NOT NULL DEFAULT 25000000,
      monthly_cap_output_tokens INTEGER NOT NULL DEFAULT 1500000,
      period_input_tokens INTEGER NOT NULL DEFAULT 0,
      period_output_tokens INTEGER NOT NULL DEFAULT 0,
      period_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS users_token_idx ON users(token);
  `);

  // Additive column migrations — never DROP, so old deployments stay working.
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "supabase_user_id")) {
    db.exec(`ALTER TABLE users ADD COLUMN supabase_user_id TEXT;`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_uid_idx ON users(supabase_user_id) WHERE supabase_user_id IS NOT NULL;`);
  }
  if (!cols.some((c) => c.name === "plan")) {
    db.exec(`ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'innsyn';`);
  }

  // Per-request activity log (timestamps + token counts only — no content).
  // Powers the admin activity stats: last active, sessions/week, avg length.
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'extension',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_events_user_ts ON usage_events(user_id, ts);
    CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts);
  `);
  const evCols = db.prepare("PRAGMA table_info(usage_events)").all() as { name: string }[];
  if (!evCols.some((c) => c.name === "model")) {
    db.exec(`ALTER TABLE usage_events ADD COLUMN model TEXT;`);
  }

  // Keep 90 days — plenty for weekly/monthly stats, keeps the file small.
  db.prepare("DELETE FROM usage_events WHERE ts < datetime('now', '-90 days')").run();

  // Prepaid credit (ISK). NULL = legacy monthly-cap mode; a value (even 0)
  // switches the user to credit mode: balance burns down per request and
  // never resets. Every change is journaled in credit_events.
  const uCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!uCols.some((c) => c.name === "credit_balance_isk")) {
    db.exec(`ALTER TABLE users ADD COLUMN credit_balance_isk REAL;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      delta_isk REAL NOT NULL,
      balance_after REAL NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credit_events_user_ts ON credit_events(user_id, ts);
  `);

  // Verðþrep + purchase totals (2026-07-21). credit_granted_isk is the
  // lifetime sum of positive grants — denominator for the "% eftir" display.
  if (!uCols.some((c) => c.name === "credit_granted_isk")) {
    db.exec(`ALTER TABLE users ADD COLUMN credit_granted_isk REAL NOT NULL DEFAULT 0;`);
    // Backfill from the journal so % eftir is right for existing credit users.
    db.exec(`UPDATE users SET credit_granted_isk = COALESCE(
      (SELECT SUM(delta_isk) FROM credit_events WHERE user_id = users.id AND delta_isk > 0), 0);`);
  }
  if (!uCols.some((c) => c.name === "tier")) {
    db.exec(`ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'almennt';`);
  }

  // Trial expiration tracking (2026-08-11). ISO timestamp for when trial ends.
  if (!uCols.some((c) => c.name === "trial_expires_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN trial_expires_at TEXT;`);
    db.exec(`CREATE INDEX IF NOT EXISTS users_trial_expires_at_idx ON users(trial_expires_at);`);
  }

  // Eva's lasting memory per user — one compact note (business facts,
  // preferences, recurring sites) the extension injects into every run.
  // User-visible and editable in the side panel; content only, no history.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      user_id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);

  // Inneignarlotur (2026-08-12, ný verðskrá): credit_balance_isk er áfram
  // heildarstaðan sem allt birtingarlag les, en loturnar bera fyrningu og
  // brennsluröð — innifalin mánaðarinneign fyrst, svo keypt elsta fyrst.
  // Keypt inneign gildir 12 mánuði; innifalin rúllar mest einn mánuð (sér
  // um sig í renewIncludedLot, engin expires_at).
  const hadLots = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_lots'")
    .get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('included', 'purchased', 'legacy')),
      granted_isk REAL NOT NULL,
      balance_isk REAL NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credit_lots_user ON credit_lots(user_id);
    CREATE INDEX IF NOT EXISTS credit_lots_expiry ON credit_lots(expires_at)
      WHERE expires_at IS NOT NULL;
  `);
  if (!hadLots) {
    // Backfill: núverandi jákvæðar stöður verða ein 'legacy' lota per notanda.
    // Fyrning = síðustu kaup + 12 mán, þó ALDREI fyrr en 30 dögum frá deploy
    // svo enginn missi inneign án lofaða 30-daga fyrirvarans.
    db.exec(`
      INSERT INTO credit_lots (user_id, kind, granted_isk, balance_isk, expires_at, created_at)
      SELECT
        u.id,
        'legacy',
        u.credit_balance_isk,
        u.credit_balance_isk,
        MAX(
          datetime(COALESCE(
            (SELECT MAX(ts) FROM credit_events e WHERE e.user_id = u.id AND e.delta_isk > 0),
            datetime('now')
          ), '+12 months'),
          datetime('now', '+30 days')
        ),
        datetime('now')
      FROM users u
      WHERE u.credit_balance_isk IS NOT NULL AND u.credit_balance_isk > 0;
    `);
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("call initDb() first");
  return db;
}

// --- Queries ----------------------------------------------------------

export function findUserByToken(token: string): User | undefined {
  return getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE token = ?")
    .get(token);
}

export function findUserBySupabaseId(supabaseUserId: string): User | undefined {
  return getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE supabase_user_id = ?")
    .get(supabaseUserId);
}

/**
 * Returns the user for this Supabase ID, creating a record on first access.
 * This is the normal sign-in path for Eva platform users.
 *
 * New users start in CREDIT MODE WITH 0 BALANCE — no free quota, no plan
 * shown, blocked from chat until their first Kling purchase lands. The plan
 * column keeps its default label but /v1/me hides it until credit is granted.
 */
export function findOrCreateUserBySupabaseId(
  supabaseUserId: string,
  email: string,
): User {
  const existing = findUserBySupabaseId(supabaseUserId);
  if (existing) return existing;

  const id = randomUUID();
  const token = `tok_${randomBytes(24).toString("hex")}`;
  const now = new Date().toISOString();
  const periodKey = currentPeriodKey();

  const defaultPlan = PLANS[DEFAULT_PLAN];
  getDb()
    .prepare(
      `INSERT INTO users (id, name, token, supabase_user_id, plan, monthly_cap_input_tokens, monthly_cap_output_tokens, period_input_tokens, period_output_tokens, period_key, created_at, credit_balance_isk)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0)`,
    )
    .run(
      id,
      email,
      token,
      supabaseUserId,
      defaultPlan.id,
      defaultPlan.monthlyCapInputTokens,
      defaultPlan.monthlyCapOutputTokens,
      periodKey,
      now,
    );

  return findUserBySupabaseId(supabaseUserId)!;
}

export function listUsers(): User[] {
  return getDb()
    .prepare<[], User>("SELECT * FROM users ORDER BY created_at DESC")
    .all();
}

export interface CreateUserArgs {
  name: string;
  monthlyCapInputTokens?: number;
  monthlyCapOutputTokens?: number;
}

export function createUser(args: CreateUserArgs): User {
  const id = randomUUID();
  const token = `tok_${randomBytes(24).toString("hex")}`;
  const now = new Date().toISOString();
  const periodKey = currentPeriodKey();

  getDb()
    .prepare(
      `INSERT INTO users (id, name, token, monthly_cap_input_tokens, monthly_cap_output_tokens, period_input_tokens, period_output_tokens, period_key, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .run(
      id,
      args.name,
      token,
      args.monthlyCapInputTokens ?? 25_000_000,
      args.monthlyCapOutputTokens ?? 1_500_000,
      periodKey,
      now,
    );

  return findUserByToken(token)!;
}

export function adjustCap(
  userId: string,
  inputTokens: number | null,
  outputTokens: number | null,
): User | undefined {
  if (inputTokens != null) {
    getDb()
      .prepare(
        "UPDATE users SET monthly_cap_input_tokens = ? WHERE id = ?",
      )
      .run(inputTokens, userId);
  }
  if (outputTokens != null) {
    getDb()
      .prepare(
        "UPDATE users SET monthly_cap_output_tokens = ? WHERE id = ?",
      )
      .run(outputTokens, userId);
  }
  return getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE id = ?")
    .get(userId);
}

export function revokeUser(userId: string): User | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE users SET revoked_at = ? WHERE id = ?")
    .run(now, userId);
  return getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE id = ?")
    .get(userId);
}

/** Opnar aftur aðgang sem var stöðvaður. Stöðvun verður að vera afturkræf. */
export function restoreUser(userId: string): User | undefined {
  getDb().prepare("UPDATE users SET revoked_at = NULL WHERE id = ?").run(userId);
  return getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE id = ?")
    .get(userId);
}

export function findUserById(userId: string): User | undefined {
  return getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE id = ?")
    .get(userId);
}

/**
 * Change a user's plan and update their token caps immediately.
 * Called by the payment webhook after a successful Kling charge.
 */
export function setUserPlan(userId: string, planId: PlanId): User | undefined {
  const plan = PLANS[planId];
  getDb()
    .prepare(
      `UPDATE users
       SET plan = ?,
           monthly_cap_input_tokens = ?,
           monthly_cap_output_tokens = ?
       WHERE id = ?`,
    )
    .run(plan.id, plan.monthlyCapInputTokens, plan.monthlyCapOutputTokens, userId);
  return findUserById(userId);
}

/** Set the user's verðþrep (validated by the caller against tiers.ts). */
export function setUserTier(userId: string, tier: string): User | undefined {
  getDb().prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, userId);
  return findUserById(userId);
}

/** Roll counters over if the user's period_key is stale. */
export function rolloverIfNeeded(user: User): User {
  const cur = currentPeriodKey();
  if (user.period_key === cur) return user;
  getDb()
    .prepare(
      "UPDATE users SET period_input_tokens = 0, period_output_tokens = 0, period_key = ? WHERE id = ?",
    )
    .run(cur, user.id);
  return findUserById(user.id)!;
}

/** Add usage to the user's running counters + append to the activity log. */
export function recordUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
  source: "extension" | "platform" = "extension",
  model?: string,
): void {
  getDb()
    .prepare(
      `UPDATE users
        SET period_input_tokens = period_input_tokens + ?,
            period_output_tokens = period_output_tokens + ?
        WHERE id = ?`,
    )
    .run(inputTokens, outputTokens, userId);
  getDb()
    .prepare(
      `INSERT INTO usage_events (user_id, ts, source, input_tokens, output_tokens, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, new Date().toISOString(), source, inputTokens, outputTokens, model ?? null);
}

/** Per-model token totals for the current calendar month (UTC). */
export interface ModelUsageRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
}

export function monthUsageByModel(userId?: string): ModelUsageRow[] {
  const monthStart = `${currentPeriodKey()}-01T00:00:00.000Z`;
  if (userId) {
    return getDb()
      .prepare<[string, string], ModelUsageRow>(
        `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
         FROM usage_events WHERE user_id = ? AND ts >= ? GROUP BY model`,
      )
      .all(userId, monthStart);
  }
  return getDb()
    .prepare<[string], ModelUsageRow>(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM usage_events WHERE ts >= ? GROUP BY model`,
    )
    .all(monthStart);
}

// --- Activity stats (admin dashboard) ---------------------------------

export interface UserActivity {
  /** ISO timestamp of the newest request, or null if never active. */
  lastActive: string | null;
  /** Distinct usage sessions in the last 7 / 30 days (30-min idle gap). */
  sessions7d: number;
  sessions30d: number;
  /** Requests in the last 7 / 30 days. */
  requests7d: number;
  requests30d: number;
  /** Mean session length in minutes over the last 30 days (null if no data). */
  avgSessionMin: number | null;
  /** Share of last-30d requests that came from the platform chat (0–1). */
  platformShare: number;
}

const SESSION_GAP_MS = 30 * 60 * 1000;

/** Compute activity stats from the last 30 days of usage events. */
export function getUserActivity(userId: string): UserActivity {
  const rows = getDb()
    .prepare<[string], { ts: string; source: string }>(
      `SELECT ts, source FROM usage_events
       WHERE user_id = ? AND ts >= datetime('now', '-30 days')
       ORDER BY ts ASC`,
    )
    .all(userId);

  const last = getDb()
    .prepare<[string], { ts: string }>(
      "SELECT ts FROM usage_events WHERE user_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(userId);

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let requests7d = 0;
  let platformCount = 0;

  // Sessionize: a new session starts after a 30-minute quiet gap.
  const sessions: { start: number; end: number }[] = [];
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (r.source === "platform") platformCount++;
    if (t >= weekAgo) requests7d++;
    const cur = sessions[sessions.length - 1];
    if (cur && t - cur.end <= SESSION_GAP_MS) cur.end = t;
    else sessions.push({ start: t, end: t });
  }

  const sessions7d = sessions.filter((s) => s.end >= weekAgo).length;
  const durations = sessions.map((s) => (s.end - s.start) / 60_000);
  const avg =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;

  return {
    lastActive: last?.ts ?? null,
    sessions7d,
    sessions30d: sessions.length,
    requests7d,
    requests30d: rows.length,
    avgSessionMin: avg,
    platformShare: rows.length > 0 ? platformCount / rows.length : 0,
  };
}

/** Returns true when the user has hit either cap. */
/** Add (or with negative delta, remove) prepaid credit. Returns new balance. */
export function grantCredit(userId: string, deltaIsk: number, reason: string): number {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE users SET credit_balance_isk = COALESCE(credit_balance_isk, 0) + ? WHERE id = ?",
    ).run(deltaIsk, userId);
    if (deltaIsk > 0) {
      db.prepare(
        "UPDATE users SET credit_granted_isk = credit_granted_isk + ? WHERE id = ?",
      ).run(deltaIsk, userId);
    }
    const row = db.prepare("SELECT credit_balance_isk AS b FROM users WHERE id = ?").get(userId) as { b: number } | undefined;
    const after = row?.b ?? 0;
    db.prepare(
      "INSERT INTO credit_events (user_id, ts, delta_isk, balance_after, reason) VALUES (?, datetime('now'), ?, ?, ?)",
    ).run(userId, deltaIsk, after, reason);
    return after;
  });
  return tx() as number;
}

/** Burn credit for usage (delta stored negative). Balance may dip below 0 on
 *  the final request. Brennsluröð (2026-08-12): útrunnar lotur fyrnast fyrst,
 *  svo brennur innifalin mánaðarinneign, þá keypt/legacy elsta fyrst. Lotur
 *  botna á 0 — það sem eftir stendur dregst samt af heildarstöðunni (má enda
 *  undir núlli á síðasta requesti, eins og áður). */
export function chargeCredit(userId: string, isk: number, reason: string): number {
  const db = getDb();
  const amount = Math.abs(isk);
  // Fyrst fyrning (leiðréttir líka heildarstöðuna), svo brennsla úr lotum.
  expireLotsForUser(userId);
  const tx = db.transaction(() => {
    let rest = amount;
    const lots = db
      .prepare(
        `SELECT id, balance_isk FROM credit_lots
         WHERE user_id = ? AND balance_isk > 0
         ORDER BY CASE kind WHEN 'included' THEN 0 ELSE 1 END, created_at ASC, id ASC`,
      )
      .all(userId) as { id: number; balance_isk: number }[];
    for (const lot of lots) {
      if (rest <= 0) break;
      const take = Math.min(lot.balance_isk, rest);
      db.prepare("UPDATE credit_lots SET balance_isk = balance_isk - ? WHERE id = ?").run(
        take,
        lot.id,
      );
      rest -= take;
    }
  });
  tx();
  return grantCredit(userId, -amount, reason);
}

export type LotKind = "included" | "purchased" | "legacy";

/** Bæta við inneignarlotu (keypt inneign / pakki) og heildarstöðuna með. */
export function grantLot(
  userId: string,
  kind: LotKind,
  isk: number,
  expiresAt: string | null,
  reason: string,
): number {
  getDb()
    .prepare(
      `INSERT INTO credit_lots (user_id, kind, granted_isk, balance_isk, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(userId, kind, isk, isk, expiresAt);
  return grantCredit(userId, isk, reason);
}

/**
 * Mánaðarleg endurnýjun innifalinnar inneignar — rúllar mest EINN mánuð:
 * ný innifalin staða = min(núverandi innifalin, mánaðarskammtur) + skammtur.
 * Gamla innifalda lotan núllast og ein fersk kemur í staðinn; heildarstaðan
 * leiðréttist um mismuninn (getur verið neikvæð leiðrétting ef ónotuð
 * innifalin inneign fyrnist við rúlluna).
 */
export function renewIncludedLot(userId: string, monthlyIsk: number, reason: string): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(balance_isk), 0) AS b FROM credit_lots WHERE user_id = ? AND kind = 'included'",
      )
      .get(userId) as { b: number };
    const current = row.b;
    const carried = Math.min(current, monthlyIsk);
    const newIncluded = carried + monthlyIsk;
    db.prepare("UPDATE credit_lots SET balance_isk = 0 WHERE user_id = ? AND kind = 'included'").run(
      userId,
    );
    db.prepare(
      `INSERT INTO credit_lots (user_id, kind, granted_isk, balance_isk, expires_at, created_at)
       VALUES (?, 'included', ?, ?, NULL, datetime('now'))`,
    ).run(userId, newIncluded, newIncluded);
    return newIncluded - current; // delta á heildarstöðuna
  });
  const delta = tx() as number;
  return grantCredit(userId, delta, reason);
}

/** Fyrna útrunnar lotur — innan færslu; skilar ISK sem féll niður. */
function expireLotsForUserInTx(userId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(balance_isk), 0) AS b FROM credit_lots
       WHERE user_id = ? AND balance_isk > 0
         AND expires_at IS NOT NULL AND expires_at <= datetime('now')`,
    )
    .get(userId) as { b: number };
  if (row.b > 0) {
    db.prepare(
      `UPDATE credit_lots SET balance_isk = 0
       WHERE user_id = ? AND balance_isk > 0
         AND expires_at IS NOT NULL AND expires_at <= datetime('now')`,
    ).run(userId);
  }
  return row.b;
}

/** Fyrna útrunnar lotur notanda og draga af heildarstöðunni. */
export function expireLotsForUser(userId: string): number {
  const forfeited = getDb().transaction(() => expireLotsForUserInTx(userId))() as number;
  if (forfeited > 0) {
    grantCredit(userId, -forfeited, "fyrning:12man");
  }
  return forfeited;
}

/** Næsta fyrning með stöðu > 0 — fyrir „rennur út eftir X daga" birtingu. */
export function nextLotExpiry(
  userId: string,
): { expires_at: string; balance_isk: number } | null {
  const row = getDb()
    .prepare(
      `SELECT expires_at, SUM(balance_isk) AS balance_isk FROM credit_lots
       WHERE user_id = ? AND balance_isk > 0 AND expires_at IS NOT NULL
       GROUP BY expires_at ORDER BY expires_at ASC LIMIT 1`,
    )
    .get(userId) as { expires_at: string; balance_isk: number } | undefined;
  return row ?? null;
}

/**
 * Grant a 1500 ISK trial to a user (by email), valid for 30 days.
 * Works for both new users and existing users.
 * Returns the user record with trial_expires_at set.
 */
export function grantTrialByEmail(email: string): User {
  const cleanEmail = email.trim().toLowerCase();

  // Try to find existing user by name (email field)
  let user = getDb()
    .prepare<[string], User>("SELECT * FROM users WHERE LOWER(name) = ?")
    .get(cleanEmail);

  if (!user) {
    // Create a new trial user without Supabase integration
    const id = randomUUID();
    const token = `tok_${randomBytes(24).toString("hex")}`;
    const now = new Date().toISOString();
    const periodKey = currentPeriodKey();
    getDb()
      .prepare(
        `INSERT INTO users (id, name, token, plan, monthly_cap_input_tokens, monthly_cap_output_tokens, period_input_tokens, period_output_tokens, period_key, created_at, credit_balance_isk, supabase_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, NULL)`,
      )
      .run(
        id,
        cleanEmail,
        token,
        "innsyn",
        25_000_000,
        1_500_000,
        periodKey,
        now,
      );
    user = findUserById(id)!;
  }

  grantCredit(user.id, 1500, "trial:30days");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  getDb()
    .prepare("UPDATE users SET trial_expires_at = ? WHERE id = ?")
    .run(expiresAt.toISOString(), user.id);
  return findUserById(user.id)!;
}

export interface CreditEvent {
  ts: string;
  delta_isk: number;
  balance_after: number;
  reason: string;
}

export function listCreditEvents(userId: string, limit = 10): CreditEvent[] {
  return getDb()
    .prepare(
      "SELECT ts, delta_isk, balance_after, reason FROM credit_events WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(userId, limit) as CreditEvent[];
}

export const MEMORY_MAX_CHARS = 6000;

export function getMemory(userId: string): { content: string; updated_at: string | null } {
  const row = getDb()
    .prepare("SELECT content, updated_at FROM user_memories WHERE user_id = ?")
    .get(userId) as { content: string; updated_at: string } | undefined;
  return row ?? { content: "", updated_at: null };
}

export function setMemory(userId: string, content: string): void {
  const clipped = content.slice(0, MEMORY_MAX_CHARS);
  getDb()
    .prepare(
      `INSERT INTO user_memories (user_id, content, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
    .run(userId, clipped);
}

export function overCap(user: User): boolean {
  return (
    user.period_input_tokens >= user.monthly_cap_input_tokens ||
    user.period_output_tokens >= user.monthly_cap_output_tokens
  );
}

function currentPeriodKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** End of current UTC month, ISO 8601. */
export function periodResetsAt(date = new Date()): string {
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  );
  return next.toISOString();
}

export interface CreditEventWithUser extends CreditEvent {
  email: string;
  supabase_user_id: string | null;
}

/**
 * Allar inneignarhreyfingar á kerfinu, nýjast fyrst, með netfangi notandans.
 *
 * Til fyrir stjórnstöð platformsins: hún þarf að geta svarað „keypti þessi
 * viðskiptavinur inneign eða fékk hann hana gefins?" og svarið liggur í
 * reason-strengnum hér (`kaup:` gegn `admin:`/`trial:`). Sú saga er hvergi til
 * platform-megin.
 */
export function listAllCreditEvents(limit = 500): CreditEventWithUser[] {
  return getDb()
    .prepare(
      `SELECT e.ts, e.delta_isk, e.balance_after, e.reason,
              u.name AS email, u.supabase_user_id
         FROM credit_events e
         JOIN users u ON u.id = e.user_id
        ORDER BY e.id DESC
        LIMIT ?`,
    )
    .all(limit) as CreditEventWithUser[];
}
