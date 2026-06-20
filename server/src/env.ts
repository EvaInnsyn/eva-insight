/**
 * Typed environment loader.
 *
 * Loads `.env` from CWD if present (dev), then validates required values.
 * Production deployments are expected to set env vars directly and not
 * ship a `.env` file.
 */

import { existsSync } from "node:fs";
import { z } from "zod";

// Eva Insight env vars we manage. Empty strings in the shell environment
// would otherwise mask values in .env (Node's loadEnvFile won't override
// pre-set vars). Clearing them first lets .env always win in dev.
const EVA_KEYS = [
  "PORT",
  "ANTHROPIC_API_KEY",
  "EVA_INSIGHT_SHARED_SECRET",
  "EVA_INSIGHT_ALLOWED_ORIGINS",
  "EVA_INSIGHT_DEFAULT_MODEL",
  "EVA_INSIGHT_DB_PATH",
  "EVA_INSIGHT_ADMIN_PASSWORD",
] as const;

for (const key of EVA_KEYS) {
  if (process.env[key] === "") delete process.env[key];
}

// process.loadEnvFile is GA in Node 20.6+ — call once on first import.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    console.warn("[eva-insight] failed to load .env:", err);
  }
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  EVA_INSIGHT_SHARED_SECRET: z
    .string()
    .min(8, "EVA_INSIGHT_SHARED_SECRET must be at least 8 chars"),
  /**
   * Allowed origins for CORS. Comma-separated.
   * Default: the dev install's extension ID. Override in .env once the
   * production-built extension gets a stable ID.
   */
  EVA_INSIGHT_ALLOWED_ORIGINS: z
    .string()
    .default("chrome-extension://kkjnkjiclpmfkadlmjkjednknilknnhl"),
  /** Default Anthropic model when the client omits it. */
  EVA_INSIGHT_DEFAULT_MODEL: z.string().default("claude-opus-4-6"),
  /** SQLite DB path. Created on startup if missing. */
  EVA_INSIGHT_DB_PATH: z.string().default("data/eva.db"),
  /** Password for the /admin panel. If unset, admin is disabled (503). */
  EVA_INSIGHT_ADMIN_PASSWORD: z.string().min(8).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`[eva-insight] invalid env:\n${issues}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export function allowedOrigins(env: Env): string[] {
  return env.EVA_INSIGHT_ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
