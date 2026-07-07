/**
 * GET  /admin         — dashboard (user list, usage, caps)
 * POST /admin/login   — set session cookie
 * GET  /admin/logout  — clear session cookie
 * POST /admin/users               — create user, display token once
 * POST /admin/users/:id/revoke    — revoke a user's token
 * POST /admin/users/:id/cap       — adjust monthly token caps
 *
 * Protected by EVA_INSIGHT_ADMIN_PASSWORD. If unset, all routes return 503.
 * Session = HMAC-SHA256(password, "eva-admin-v1") stored as an HttpOnly cookie.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  listUsers,
  revokeUser,
  adjustCap,
  createUser,
  setUserPlan,
  getUserActivity,
  monthUsageByModel,
  type User,
  type UserActivity,
} from "../db.js";
import { PLANS, type PlanId } from "../plans.js";
import { loadEnv } from "../env.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sessionToken(password: string): string {
  return createHmac("sha256", password).update("eva-admin-v1").digest("hex");
}

function isAuthed(c: any, password: string): boolean {
  const cookie = getCookie(c, "eva_admin_sess");
  if (!cookie) return false;
  const expected = Buffer.from(sessionToken(password), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(cookie, "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ── HTML templates ────────────────────────────────────────────────────────────

const BASE = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: #fdf6f0; color: #1a1a1a; }`;

function loginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eva Insight · Admin</title>
<style>
${BASE}
body { display:flex; align-items:center; justify-content:center; min-height:100vh; }
.card { background:white; border-radius:12px; padding:40px; width:360px; box-shadow:0 2px 16px rgba(0,0,0,.08); }
h1 { font-size:20px; font-weight:700; color:#6b1a2e; margin-bottom:6px; }
.sub { font-size:13px; color:#999; margin-bottom:24px; }
input { width:100%; padding:10px 14px; border:1.5px solid #e8d8df; border-radius:8px; font-size:14px; outline:none; margin-bottom:10px; }
input:focus { border-color:#6b1a2e; }
button { width:100%; padding:10px; background:#6b1a2e; color:white; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
button:hover { background:#591625; }
.err { color:#c0392b; font-size:13px; margin-top:10px; }
</style>
</head>
<body>
<div class="card">
  <h1>Eva Insight</h1>
  <div class="sub">Admin access required</div>
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="Admin password" autofocus />
    <button type="submit">Sign in</button>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
  </form>
</div>
</body></html>`;
}

function bar(used: number, cap: number, color: string): string {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const c = pct >= 90 ? "#c0392b" : color;
  return `<div style="background:#f0e8ec;border-radius:4px;height:5px;width:100px;margin-bottom:3px">
    <div style="background:${c};border-radius:4px;height:5px;width:${pct}%"></div></div>
  <small style="color:#999;font-size:11px">${used.toLocaleString()} / ${cap.toLocaleString()} (${pct}%)</small>`;
}

/** $ per 1M tokens [input, output]. Unknown/legacy (null) rows use Sonnet. */
const MODEL_PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [3, 15],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
};
const DEFAULT_PRICE: [number, number] = [3, 15];

function priceOf(model: string | null): [number, number] {
  return (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
}

/** Month-to-date cost from the activity log, priced per actual model. */
function monthCostUsd(userId?: string): number {
  return monthUsageByModel(userId).reduce((sum, row) => {
    const [inP, outP] = priceOf(row.model);
    return sum + (row.input_tokens / 1e6) * inP + (row.output_tokens / 1e6) * outP;
  }, 0);
}

/** Fallback pricing for period counters that predate per-model logging. */
function estUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1e6) * DEFAULT_PRICE[0] + (outputTokens / 1e6) * DEFAULT_PRICE[1];
}

const PLAN_COLORS: Record<PlanId, string> = {
  innsyn: "#8a7aa0",
  yfirsyn: "#7b3fc4",
  umsja: "#6b1a2e",
};

function planBadge(plan: PlanId): string {
  const p = PLANS[plan];
  const color = PLAN_COLORS[plan] ?? "#888";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:.5px;background:${color}1a;color:${color}">${esc(p?.displayName ?? plan)}</span>`;
}

function planButtons(u: User): string {
  return (Object.keys(PLANS) as PlanId[])
    .map((id) => {
      const p = PLANS[id];
      const active = u.plan === id;
      return `<form method="POST" action="/admin/users/${esc(u.id)}/plan" style="display:inline">
        <input type="hidden" name="plan" value="${esc(id)}">
        <button type="submit" ${active ? "disabled" : ""} title="${esc(p.priceIsk.toLocaleString())} kr → $${p.apiCapUsd} API"
          style="border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:${active ? "default" : "pointer"};
          background:${active ? PLAN_COLORS[id] : "#f0e8f5"};color:${active ? "white" : "#6b1a2e"};opacity:${active ? 1 : 0.9}">
          ${esc(p.displayName)}</button>
      </form>`;
    })
    .join(" ");
}

/** "today 14:32" / "yesterday" / "5d ago" / "12 Jun" — compact and scannable. */
function fmtLastActive(iso: string | null): string {
  if (!iso) return `<span style="color:#bbb">never</span>`;
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `<strong style="color:#1a7a4a">today ${hm}</strong>`;
  if (days === 1) return `yesterday ${hm}`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function activityCell(a: UserActivity): string {
  const avg =
    a.avgSessionMin == null
      ? "—"
      : a.avgSessionMin < 1
        ? "<1 min"
        : `${Math.round(a.avgSessionMin)} min`;
  const platform =
    a.requests30d > 0 && a.platformShare > 0
      ? `<div style="color:#7b3fc4">${Math.round(a.platformShare * 100)}% via platform</div>`
      : "";
  return `<div style="font-size:12px;line-height:1.7;color:#555">
    <div>Last: ${fmtLastActive(a.lastActive)}</div>
    <div>${a.sessions7d} sessions / 7d · ${a.sessions30d} / 30d</div>
    <div>Avg session: ${avg} · ${a.requests30d} req/30d</div>
    ${platform}
  </div>`;
}

function rows(users: User[]): string {
  if (users.length === 0) {
    return `<tr><td colspan="8" style="padding:32px;text-align:center;color:#aaa;font-size:13px">No users yet — add one above.</td></tr>`;
  }
  return users
    .map((u) => {
      const revoked = !!u.revoked_at;
      const activity = getUserActivity(u.id);
      const badge = revoked
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#fde8e8;color:#c0392b">Revoked</span>`
        : `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#d4f5e9;color:#1a7a4a">Active</span>`;
      return `<tr>
      <td style="padding:14px 16px;font-weight:500">${esc(u.name)}</td>
      <td style="padding:14px 16px">${badge}</td>
      <td style="padding:14px 16px">${planBadge(u.plan)}<div style="margin-top:6px">${planButtons(u)}</div></td>
      <td style="padding:14px 16px">${activityCell(activity)}</td>
      <td style="padding:14px 16px">${bar(u.period_input_tokens, u.monthly_cap_input_tokens, "#6b1a2e")}</td>
      <td style="padding:14px 16px">${bar(u.period_output_tokens, u.monthly_cap_output_tokens, "#7b3fc4")}</td>
      <td style="padding:14px 16px;font-size:12px;color:#555">$${monthCostUsd(u.id).toFixed(2)}</td>
      <td style="padding:14px 16px">
        ${
          !revoked
            ? `<form method="POST" action="/admin/users/${esc(u.id)}/revoke" style="display:inline">
            <button type="submit" style="background:#fde8e8;color:#c0392b;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">Revoke</button>
          </form> `
            : ""
        }
        <button onclick="toggleCap('${esc(u.id)}')" type="button" style="background:#f0e8f5;color:#6b1a2e;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">Caps</button>
        <div id="cap-${esc(u.id)}" style="display:none;margin-top:8px">
          <form method="POST" action="/admin/users/${esc(u.id)}/cap" style="display:flex;gap:6px;flex-wrap:wrap">
            <input type="number" name="input_tokens" value="${u.monthly_cap_input_tokens}" style="width:110px;padding:4px 8px;border:1.5px solid #e0d0e8;border-radius:6px;font-size:12px">
            <input type="number" name="output_tokens" value="${u.monthly_cap_output_tokens}" style="width:110px;padding:4px 8px;border:1.5px solid #e0d0e8;border-radius:6px;font-size:12px">
            <button type="submit" style="background:#6b1a2e;color:white;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">Save</button>
          </form>
        </div>
      </td>
    </tr>`;
    })
    .join("");
}

/**
 * Month-to-date totals across all users — the number to watch against your
 * Anthropic credit balance. Active = not revoked.
 */
function summaryHtml(users: User[]): string {
  const active = users.filter((u) => !u.revoked_at);
  const inTok = active.reduce((s, u) => s + u.period_input_tokens, 0);
  const outTok = active.reduce((s, u) => s + u.period_output_tokens, 0);
  const eventCost = monthCostUsd();
  // Event log starts 2026-07-07; period counters may predate it — show the max.
  const cost = Math.max(eventCost, estUsd(inTok, outTok));
  const revenueIsk = active.reduce((s, u) => s + (PLANS[u.plan]?.priceIsk ?? 0), 0);
  const stat = (label: string, value: string, sub?: string) =>
    `<div style="background:white;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.06);padding:16px 20px;min-width:170px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#999;font-weight:600">${label}</div>
      <div style="font-size:22px;font-weight:700;color:#6b1a2e;margin-top:4px">${value}</div>
      ${sub ? `<div style="font-size:11px;color:#aaa;margin-top:2px">${sub}</div>` : ""}
    </div>`;
  return `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:26px">
    ${stat("Est. API cost this month", `$${cost.toFixed(2)}`, "priced per actual model — check vs Anthropic credits")}
    ${stat("Plan revenue / month", `${revenueIsk.toLocaleString()} kr`, `${active.length} active user${active.length === 1 ? "" : "s"}`)}
    ${stat("Tokens this month", `${(inTok / 1e6).toFixed(1)}M in`, `${(outTok / 1e6).toFixed(2)}M out`)}
  </div>`;
}

function dashboardHtml(
  users: User[],
  flash?: { token: string; name: string },
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eva Insight · Admin</title>
<style>
${BASE}
header { background:white; border-bottom:1.5px solid #f0e0e8; padding:0 32px; height:56px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:10; }
.logo { font-size:16px; font-weight:700; color:#6b1a2e; }
.out { font-size:13px; color:#aaa; text-decoration:none; }
.out:hover { color:#6b1a2e; }
main { padding:32px; max-width:1100px; margin:0 auto; }
.flash { background:#d4f5e9; border:1.5px solid #1a7a4a; border-radius:10px; padding:16px 20px; margin-bottom:24px; }
.flash strong { color:#1a7a4a; font-size:13px; }
.flash code { display:block; margin-top:8px; font-family:monospace; font-size:13px; background:white; padding:8px 12px; border-radius:6px; word-break:break-all; }
.flash small { display:block; margin-top:6px; color:#1a7a4a; font-size:12px; }
.sh { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
h2 { font-size:15px; font-weight:600; color:#333; }
.btn-add { background:#6b1a2e; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; }
.add-form { background:white; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.06); padding:20px; margin-bottom:20px; display:none; }
.add-form label { font-size:12px; font-weight:600; color:#888; display:block; margin-bottom:4px; text-transform:uppercase; letter-spacing:.4px; }
.add-form input[type=text], .add-form input[type=number] { padding:8px 12px; border:1.5px solid #e8d8df; border-radius:8px; font-size:13px; }
.add-form button[type=submit] { background:#6b1a2e; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; }
.card { background:white; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.06); overflow:hidden; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { background:#fdf0f5; color:#6b1a2e; font-weight:600; padding:10px 16px; text-align:left; border-bottom:1.5px solid #f0e0e8; font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
tr:not(:last-child) td { border-bottom:1px solid #faf0f5; }
</style>
</head>
<body>
<header>
  <span class="logo">Eva Insight · Admin</span>
  <a class="out" href="/admin/logout">Logout</a>
</header>
<main>
  ${
    flash
      ? `<div class="flash">
    <strong>User "${esc(flash.name)}" created — copy this token now, it won't be shown again.</strong>
    <code>${esc(flash.token)}</code>
    <small>Share this with the user to pair their extension.</small>
  </div>`
      : ""
  }

  ${summaryHtml(users)}

  <div class="sh">
    <h2>Users <span style="color:#aaa;font-weight:400">(${users.length})</span></h2>
    <button class="btn-add" onclick="document.getElementById('af').style.display='block';this.style.display='none'">+ Add user</button>
  </div>

  <div class="add-form" id="af">
    <form method="POST" action="/admin/users" style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
      <div><label>Name or email</label><input type="text" name="name" placeholder="vigdis@evai.is" required style="width:200px"></div>
      <div><label>Input cap (tokens)</label><input type="number" name="input_cap" placeholder="1000000 (default)" style="width:150px"></div>
      <div><label>Output cap (tokens)</label><input type="number" name="output_cap" placeholder="200000 (default)" style="width:150px"></div>
      <button type="submit">Create</button>
    </form>
  </div>

  <div class="card">
    <table>
      <thead><tr>
        <th>Name</th><th>Status</th><th>Plan</th><th>Activity</th>
        <th>Input tokens</th><th>Output tokens</th><th>Est. cost</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows(users)}</tbody>
    </table>
  </div>
</main>
<script>
function toggleCap(id) {
  const el = document.getElementById('cap-' + id);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
</script>
</body></html>`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const adminRoute = new Hono();

adminRoute.use("*", async (c, next) => {
  const pw = loadEnv().EVA_INSIGHT_ADMIN_PASSWORD;
  if (!pw) {
    return c.text(
      "Admin panel disabled: set EVA_INSIGHT_ADMIN_PASSWORD in .env",
      503,
    );
  }
  // Login and logout don't require an existing session.
  const path = c.req.path;
  if (path.endsWith("/login") || path.endsWith("/logout")) return next();
  if (!isAuthed(c, pw)) return c.html(loginHtml(), 401);
  return next();
});

adminRoute.get("/", (c) => c.html(dashboardHtml(listUsers())));

adminRoute.post("/login", async (c) => {
  const pw = loadEnv().EVA_INSIGHT_ADMIN_PASSWORD!;
  const body = await c.req.parseBody();
  const given = String(body.password ?? "");
  const expectedBuf = Buffer.from(sessionToken(pw), "hex");
  const givenBuf = Buffer.from(sessionToken(given), "hex");
  if (!timingSafeEqual(givenBuf, expectedBuf)) {
    return c.html(loginHtml("Incorrect password"), 401);
  }
  setCookie(c, "eva_admin_sess", sessionToken(pw), {
    httpOnly: true,
    sameSite: "Strict",
    path: "/admin",
    maxAge: 60 * 60 * 24 * 7,
  });
  return c.redirect("/admin");
});

adminRoute.get("/logout", (c) => {
  deleteCookie(c, "eva_admin_sess", { path: "/admin" });
  return c.redirect("/admin");
});

adminRoute.post("/users", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  if (!name) return c.html(dashboardHtml(listUsers()), 400);
  const inputCap = body.input_cap ? Number(body.input_cap) : undefined;
  const outputCap = body.output_cap ? Number(body.output_cap) : undefined;
  const user = createUser({
    name,
    monthlyCapInputTokens: inputCap,
    monthlyCapOutputTokens: outputCap,
  });
  return c.html(dashboardHtml(listUsers(), { token: user.token, name: user.name }));
});

adminRoute.post("/users/:id/revoke", (c) => {
  revokeUser(c.req.param("id"));
  return c.redirect("/admin");
});

adminRoute.post("/users/:id/cap", async (c) => {
  const body = await c.req.parseBody();
  const input = body.input_tokens ? Number(body.input_tokens) : null;
  const output = body.output_tokens ? Number(body.output_tokens) : null;
  adjustCap(c.req.param("id"), input, output);
  return c.redirect("/admin");
});

// One-click plan change — sets plan AND both token caps to the plan's values.
adminRoute.post("/users/:id/plan", async (c) => {
  const body = await c.req.parseBody();
  const plan = String(body.plan ?? "");
  if (plan in PLANS) {
    setUserPlan(c.req.param("id"), plan as PlanId);
  }
  return c.redirect("/admin");
});
