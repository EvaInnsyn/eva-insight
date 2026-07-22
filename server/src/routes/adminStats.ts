/**
 * GET /v1/admin-stats — server-to-server aggregate stats for the Eva Innsýn
 * Command Center (platform /admin). The proxy owns the SQLite usage + credit
 * ledger, so the command center reads month-to-date cost and credit totals
 * from here instead of duplicating the data.
 *
 * Auth: Authorization: Bearer <EVA_INSIGHT_SHARED_SECRET> — same shared secret
 * as /v1/plan. Never exposed to browsers.
 *
 * Read-only: this endpoint never mutates state, so it is safe to poll.
 */

import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { listUsers, monthUsageByModel, getDb } from "../db.js";
import { costUsd, usdIskRate } from "../pricing.js";

export const adminStatsRoute = new Hono();

interface ModelCost {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

adminStatsRoute.get("/", (c) => {
  const env = loadEnv();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.EVA_INSIGHT_SHARED_SECRET) {
    return c.json(
      { error: { type: "authentication_error", message: "invalid secret" } },
      401,
    );
  }

  const users = listUsers();
  const active = users.filter((u) => !u.revoked_at);

  // Month-to-date API cost, priced per actual model.
  const byModel: ModelCost[] = monthUsageByModel().map((row) => ({
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: costUsd(row.model, row.input_tokens, row.output_tokens),
  }));
  const apiCostUsdThisMonth = byModel.reduce((s, m) => s + m.costUsd, 0);
  const rate = usdIskRate();

  const inputTokens = byModel.reduce((s, m) => s + m.inputTokens, 0);
  const outputTokens = byModel.reduce((s, m) => s + m.outputTokens, 0);

  // Credit purchased this calendar month (positive credit_events).
  const purchasedIskThisMonth = (
    getDb()
      .prepare(
        "SELECT COALESCE(SUM(delta_isk),0) AS s FROM credit_events WHERE delta_isk > 0 AND ts >= date('now','start of month')",
      )
      .get() as { s: number }
  ).s;

  const outstandingIsk = active.reduce(
    (s, u) => s + Math.max(0, u.credit_balance_isk ?? 0),
    0,
  );

  return c.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    users: { total: users.length, active: active.length },
    apiCost: {
      usdThisMonth: Number(apiCostUsdThisMonth.toFixed(4)),
      iskThisMonth: Math.round(apiCostUsdThisMonth * rate),
      usdIskRate: rate,
      byModel: byModel
        .map((m) => ({
          model: m.model ?? "óþekkt",
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          iskThisMonth: Math.round(m.costUsd * rate),
        }))
        .sort((a, b) => b.iskThisMonth - a.iskThisMonth),
    },
    credit: {
      purchasedIskThisMonth: Math.round(purchasedIskThisMonth),
      outstandingIsk: Math.round(outstandingIsk),
    },
    tokens: { input: inputTokens, output: outputTokens },
  });
});
