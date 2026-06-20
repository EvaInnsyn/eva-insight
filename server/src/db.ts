/**
 * SQLite store for per-user pairing tokens + usage metering.
 *
 * One table: `users`. Schema migrations are handled in `initDb()` —
 * additive only (we never DROP) so existing deployments keep working.
 *
 * Default monthly caps: 1M input tokens + 200K output tokens per user
 * — roughly $5 + $5 = $10/user/month at Opus 4.6 pricing.
 */

import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface User {
  id: string;
  name: string;
  token: string;
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
      monthly_cap_input_tokens INTEGER NOT NULL DEFAULT 1000000,
      monthly_cap_output_tokens INTEGER NOT NULL DEFAULT 200000,
      period_input_tokens INTEGER NOT NULL DEFAULT 0,
      period_output_tokens INTEGER NOT NULL DEFAULT 0,
      period_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS users_token_idx ON users(token);
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
      args.monthlyCapInputTokens ?? 1_000_000,
      args.monthlyCapOutputTokens ?? 200_000,
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

/** Add usage to the user's running counters. */
export function recordUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
): void {
  getDb()
    .prepare(
      `UPDATE users
        SET period_input_tokens = period_input_tokens + ?,
            period_output_tokens = period_output_tokens + ?
        WHERE id = ?`,
    )
    .run(inputTokens, outputTokens, userId);
}

/** Returns true when the user has hit either cap. */
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
