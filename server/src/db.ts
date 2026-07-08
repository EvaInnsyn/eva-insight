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
      `INSERT INTO users (id, name, token, supabase_user_id, plan, monthly_cap_input_tokens, monthly_cap_output_tokens, period_input_tokens, period_output_tokens, period_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
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
