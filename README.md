# Eva Insight

AI side panel for Chrome — Eva Insight reads the page you're on and acts on it (click, type, navigate, screenshot, inspect console & network). Driven by Claude through a backend proxy.

Full build plan: [PLAN.md](./PLAN.md).

## Repo layout

```
extension/   Chrome extension (Manifest V3, Vite + React + TypeScript)
server/      Backend proxy (Hono + TypeScript)
```

## Prerequisites

- Node.js ≥ 20 (tested on Node 24)
- Chrome ≥ 116
- An Anthropic API key (only needed once we get to Phase 1)

## Install

```bash
npm install
```

That runs across both workspaces (`extension`, `server`).

## Run the extension (development)

```bash
npm run dev:extension
```

This starts Vite with HMR for the side panel. The first build writes `extension/dist/`.

### Load the unpacked extension in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select the `extension/dist/` folder.
5. Pin "Eva Insight" to the toolbar.
6. Click the icon — the side panel opens.

After code changes the build hot-reloads. If anything looks stale, hit the reload button on the extension card in `chrome://extensions`.

### Run the backend proxy (development)

```bash
cp server/.env.example server/.env
# edit server/.env:
#   ANTHROPIC_API_KEY=sk-ant-...
#   EVA_INSIGHT_SHARED_SECRET=$(openssl rand -hex 32)
npm run dev:server
```

Health check:

```bash
curl http://localhost:8787/healthz
# → {"ok":true,"service":"eva-insight-server","phase":1,"model":"claude-opus-4-6"}
```

Smoke-test the streaming chat endpoint (replace `<SECRET>` with your value):

```bash
curl -N -X POST http://localhost:8787/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <SECRET>" \
  -d '{
    "messages": [
      { "role": "user", "content": "Say hi in exactly five words." }
    ],
    "max_tokens": 64
  }'
```

You should see SSE events stream back (`message_start`, `content_block_delta`, …, `message_stop`) with the model's reply in the `content_block_delta` events.

> If `ANTHROPIC_API_KEY` is set to an empty string in your shell (e.g. exported in `.zshrc`), the server clears it on boot so `.env` always wins in dev. The bearer token (`EVA_INSIGHT_SHARED_SECRET`) is checked on every `/v1/*` request and CORS is locked to the extension origin.

## Status

- **Phase 0 — Bootstrap.** ✅ Side panel, background worker, content script, and server skeleton wired.
- **Phase 1 — Backend proxy.** ✅ `POST /v1/chat` streams Anthropic SSE through Hono with bearer auth, CORS for the extension origin, and prompt caching on system + tools.
- Next: Phase 2 (chat UI in side panel streams from the proxy).
