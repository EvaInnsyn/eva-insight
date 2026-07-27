#!/usr/bin/env node
/**
 * Ein skipun fyrir útgáfu í Chrome Web Store.
 *
 *   npm run release            → hækkar minnstu tölu (1.17.0 → 1.18.0), byggir, zippar
 *   npm run release -- patch   → 1.17.0 → 1.17.1
 *   npm run release -- 2.0.0   → nákvæm útgáfa
 *
 * Útkoma: tilbúinn zip á skjáborðinu (~/Desktop/eva-innsyn-<útgáfa>.zip),
 * type-checkað og byggt. Eina sem er eftir: draga hann inn í dev console
 * Chrome og ýta á Submit (það neyðir Google mann til að gera handvirkt).
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(EXT_DIR, "package.json");
const run = (cmd) => execSync(cmd, { cwd: EXT_DIR, stdio: "inherit" });

function bump(cur, arg) {
  if (arg && /^\d+\.\d+\.\d+$/.test(arg)) return arg; // nákvæm útgáfa
  const [maj, min, pat] = cur.split(".").map(Number);
  if (arg === "major") return `${maj + 1}.0.0`;
  if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
  return `${maj}.${min + 1}.0`; // sjálfgefið: minor
}

const arg = process.argv[2];
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const next = bump(pkg.version, arg);

console.log(`\n▶ Útgáfa: ${pkg.version} → ${next}`);
pkg.version = next;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

console.log("▶ Bygg (tsc + vite)…");
run("npm run build");

// Staðfesta manifest
const manifest = JSON.parse(
  readFileSync(join(EXT_DIR, "dist", "manifest.json"), "utf8"),
);
console.log(`▶ Manifest: ${manifest.name} v${manifest.version}`);

// Zippa dist á skjáborðið (sleppa source maps)
const zip = join(homedir(), "Desktop", `eva-innsyn-${next}.zip`);
if (existsSync(zip)) rmSync(zip);
execSync(`cd "${join(EXT_DIR, "dist")}" && zip -qr "${zip}" . -x "*.map"`, {
  stdio: "inherit",
});

console.log(`\n✓ Tilbúið: ${zip}`);
console.log("  Eina sem er eftir:");
console.log("  1. chrome://extensions → ↻  (prófa fyrst load-unpacked)");
console.log("  2. Þegar sátt: dev console → Package → Upload new package → veldu zip-inn → Submit\n");
