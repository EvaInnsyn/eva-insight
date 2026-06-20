#!/usr/bin/env tsx
/**
 * Eva Insight admin CLI.
 *
 * Usage:
 *   npm run admin -- list
 *   npm run admin -- create "Anna" [--input 1000000] [--output 200000]
 *   npm run admin -- show <token-or-id>
 *   npm run admin -- adjust <id> [--input N] [--output N]
 *   npm run admin -- revoke <id>
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  adjustCap,
  createUser,
  findUserById,
  findUserByToken,
  initDb,
  listUsers,
  revokeUser,
  periodResetsAt,
} from "./db.js";

// Load .env so DB path env vars (if any) work
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* ignore */
  }
}

const DB_PATH = process.env.EVA_INSIGHT_DB_PATH ?? "data/eva.db";

function help(): void {
  console.log(`
Eva Insight admin

  list                              List all users
  create <name> [--input N] [--output N]
                                    Create a user. Defaults: 1,000,000 input + 200,000 output tokens / month.
  show <token-or-id>                Show a single user's details + current usage
  adjust <id> [--input N] [--output N]
                                    Change a user's monthly caps
  revoke <id>                       Revoke a user's token

Default DB: ${resolve(process.cwd(), DB_PATH)}
`);
}

function pickArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`expected a non-negative number, got "${v}"`);
  }
  return Math.floor(n);
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function printUser(u: import("./db.js").User): void {
  console.log(`
  ID         ${u.id}
  Name       ${u.name}
  Token      ${u.token}
  Caps       in ${fmtTokens(u.monthly_cap_input_tokens)} / out ${fmtTokens(u.monthly_cap_output_tokens)} per month
  Usage      in ${fmtTokens(u.period_input_tokens)} / out ${fmtTokens(u.period_output_tokens)} this month
  Period     ${u.period_key} (resets ${periodResetsAt()})
  Created    ${u.created_at}
  Status     ${u.revoked_at ? `revoked at ${u.revoked_at}` : "active"}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  initDb(DB_PATH);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  if (cmd === "list") {
    const users = listUsers();
    if (users.length === 0) {
      console.log("(no users)");
      return;
    }
    console.log(
      `${users.length} user${users.length === 1 ? "" : "s"}:\n`,
    );
    for (const u of users) {
      const status = u.revoked_at ? "REVOKED" : "active";
      const pct = Math.round(
        (u.period_output_tokens / Math.max(1, u.monthly_cap_output_tokens)) *
          100,
      );
      console.log(
        `  ${u.id.slice(0, 8)}…  ${u.name.padEnd(20)}  ${status.padEnd(7)}  ` +
          `out ${fmtTokens(u.period_output_tokens).padStart(9)}/${fmtTokens(u.monthly_cap_output_tokens)} (${pct}%)`,
      );
    }
    return;
  }

  if (cmd === "create") {
    const name = args[1];
    if (!name) throw new Error("usage: create <name> [--input N] [--output N]");
    const u = createUser({
      name,
      monthlyCapInputTokens: num(pickArg(args, "--input")),
      monthlyCapOutputTokens: num(pickArg(args, "--output")),
    });
    console.log("✓ Created user");
    printUser(u);
    console.log("Give them the token above — they paste it into the side panel Settings.");
    return;
  }

  if (cmd === "show") {
    const key = args[1];
    if (!key) throw new Error("usage: show <token-or-id>");
    const u =
      (key.startsWith("tok_") ? findUserByToken(key) : findUserById(key)) ??
      findUserById(key);
    if (!u) {
      console.error(`no user matching "${key}"`);
      process.exit(1);
    }
    printUser(u);
    return;
  }

  if (cmd === "adjust") {
    const id = args[1];
    if (!id) throw new Error("usage: adjust <id> [--input N] [--output N]");
    const input = num(pickArg(args, "--input"));
    const output = num(pickArg(args, "--output"));
    if (input == null && output == null) {
      throw new Error("pass at least one of --input or --output");
    }
    const u = adjustCap(id, input ?? null, output ?? null);
    if (!u) {
      console.error(`no user with id "${id}"`);
      process.exit(1);
    }
    console.log("✓ Updated caps");
    printUser(u);
    return;
  }

  if (cmd === "revoke") {
    const id = args[1];
    if (!id) throw new Error("usage: revoke <id>");
    const u = revokeUser(id);
    if (!u) {
      console.error(`no user with id "${id}"`);
      process.exit(1);
    }
    console.log("✓ Revoked");
    printUser(u);
    return;
  }

  console.error(`unknown command "${cmd}"`);
  help();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
