/**
 * Eva Insight — proxy server (Phase 1).
 *
 * Routes:
 *   GET  /healthz   — liveness probe
 *   POST /v1/chat   — SSE-stream a Claude response (bearer-auth'd)
 *
 * The extension's background worker is the only client; CORS is locked
 * down to the configured extension origin.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { allowedOrigins, loadEnv } from "./env.js";
import { initDb } from "./db.js";
import { chatRoute } from "./routes/chat.js";
import { meRoute } from "./routes/me.js";
import { adminRoute } from "./routes/admin.js";

const env = loadEnv();
const origins = allowedOrigins(env);

// Initialize DB on startup so users + metering work from the first request.
initDb(env.EVA_INSIGHT_DB_PATH);

const app = new Hono();

app.use("*", logger());

app.use(
  "/v1/*",
  cors({
    origin: origins,
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86_400,
  }),
);

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    service: "eva-insight-server",
    phase: 7,
    model: env.EVA_INSIGHT_DEFAULT_MODEL,
  }),
);

app.route("/v1/chat", chatRoute);
app.route("/v1/me", meRoute);
app.route("/admin", adminRoute);

app.notFound((c) =>
  c.json(
    { error: { type: "not_found_error", message: `no route for ${c.req.path}` } },
    404,
  ),
);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `[eva-insight] server listening on http://localhost:${info.port}`,
  );
  console.log(
    `[eva-insight] cors origins: ${origins.length ? origins.join(", ") : "(none)"}`,
  );
  console.log(`[eva-insight] default model: ${env.EVA_INSIGHT_DEFAULT_MODEL}`);
});
