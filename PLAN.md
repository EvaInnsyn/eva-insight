# Eva Insight — Build Plan

A Chrome extension that mirrors the Claude-in-Chrome experience: an AI side panel that can read pages, click, type, navigate, screenshot, and inspect console/network — driven by Claude through a backend proxy.

## Locked decisions

| Area | Choice |
|---|---|
| AI backend | **Backend proxy** (extension → Eva Insight server → Anthropic API) |
| Tool surface | **Fixed built-in toolset** (navigate, read, click, type, screenshot, console, network, JS eval, tabs) |
| Stack | **TypeScript + React + Vite + `@crxjs/vite-plugin`** |
| Distribution | **Unpacked / sideload** during development |

## Repo layout (target)

```
eva-insight/
├── extension/                    # Chrome extension (Manifest V3)
│   ├── manifest.config.ts
│   ├── vite.config.ts
│   ├── src/
│   │   ├── background/           # Service worker
│   │   │   ├── index.ts
│   │   │   ├── proxy-client.ts   # talks to backend
│   │   │   ├── tool-dispatcher.ts
│   │   │   └── session-store.ts
│   │   ├── content/              # Injected into pages
│   │   │   ├── index.ts
│   │   │   ├── a11y-tree.ts      # DOM → serializable tree
│   │   │   ├── element-registry.ts # stable IDs ↔ live nodes
│   │   │   └── actions.ts        # click/type/scroll/fill
│   │   ├── sidepanel/            # React chat UI
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   └── hooks/
│   │   ├── tools/                # Tool implementations
│   │   │   ├── registry.ts
│   │   │   ├── navigate.ts
│   │   │   ├── read-page.ts
│   │   │   ├── click.ts
│   │   │   ├── type.ts
│   │   │   ├── screenshot.ts
│   │   │   ├── console.ts        # via chrome.debugger
│   │   │   ├── network.ts        # via chrome.debugger
│   │   │   ├── js-eval.ts
│   │   │   └── tabs.ts
│   │   ├── shared/               # Types shared across contexts
│   │   │   ├── messages.ts       # discriminated unions for messaging
│   │   │   ├── tools.ts          # tool schemas
│   │   │   └── safety.ts         # confirmation rules
│   │   └── options/              # Settings page
│   └── public/icons/
├── server/                       # Backend proxy (Node + Hono)
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/chat.ts        # streams Anthropic responses
│   │   ├── routes/auth.ts
│   │   ├── auth/                 # device-pair tokens
│   │   └── anthropic-client.ts
│   ├── package.json
│   └── .env.example
└── README.md
```

---

## Phase 0 — Project bootstrap

**Goal:** repo skeleton, both packages installable, manifest loads in Chrome.

Steps:
1. Initialize monorepo (root `package.json` with workspaces: `extension`, `server`)
2. Scaffold `extension/` with Vite + React + TS + `@crxjs/vite-plugin`
3. Scaffold `server/` with Hono + TS + tsx for dev
4. Write Manifest V3 with: `sidePanel`, `tabs`, `scripting`, `activeTab`, `storage`, `webNavigation`, `debugger`, `<all_urls>` host permission
5. Add background service worker, empty content script, empty side panel
6. Add icon assets (placeholder OK)
7. Verify: build extension → load unpacked in Chrome → side panel opens

**Acceptance:** clicking the extension icon opens an empty side panel; service worker shows in `chrome://extensions`.

---

## Phase 1 — Backend proxy (minimum viable)

**Goal:** server streams Anthropic responses; extension can call it.

Steps:
1. `server/`: install `@anthropic-ai/sdk`, `hono`, `@hono/node-server`, `zod`
2. `.env`: `ANTHROPIC_API_KEY`, `EVA_INSIGHT_SHARED_SECRET`, `PORT=8787`
3. Routes:
   - `POST /v1/chat` — body `{ messages, tools, model }`, returns SSE stream from Anthropic Messages API with `stream: true`
   - `GET /healthz`
4. Auth: simple bearer token from `EVA_INSIGHT_SHARED_SECRET` (Phase 5 upgrades to per-device pairing)
5. CORS: allow `chrome-extension://<id>` origin
6. Stream passthrough: forward Anthropic's SSE events verbatim (`message_start`, `content_block_delta`, `tool_use`, `message_stop`)
7. Error handling: rate limits, 5xx with retry hints

**Acceptance:** `curl -N localhost:8787/v1/chat` with a hello prompt streams a Claude response.

---

## Phase 2 — Side panel chat + streaming

**Goal:** working chat UI that streams from proxy. No tools yet.

Steps:
1. Side panel UI: message list, input box, send button, model picker
2. State: `useReducer` for conversation; messages stored in `chrome.storage.session` keyed by tab
3. Streaming client in background worker:
   - `fetch(proxyUrl, { signal })` reading SSE
   - Forward events to side panel via `chrome.runtime.Port`
4. Side panel subscribes to port → renders streaming deltas
5. Settings (options page): proxy URL, shared secret, default model

**Acceptance:** typing "hi" in side panel streams a response from Claude end-to-end.

---

## Phase 3 — Content script foundation

**Goal:** content script can serialize a page and execute simple actions.

Steps:
1. Content script injection on `<all_urls>` at `document_idle`
2. `element-registry.ts`: WeakMap from stable string ID → DOM node; IDs are short (`e123`) and reset per page load
3. `a11y-tree.ts`: walk DOM, produce JSON tree with `{ id, role, name, value, bbox, visible, children }`
   - Use accessible name computation (ARIA-aware)
   - Skip non-visible, non-interactive subtrees by default; include text nodes
   - Handle shadow DOM (open shadow roots) and same-origin iframes
4. `actions.ts`:
   - `click(id)` → resolve node, scrollIntoView, dispatch synthetic click
   - `type(id, text)` → focus, set value, dispatch `input` + `change`
   - `scroll(direction, amount)` and `scroll_to(id)`
   - `wait_for(predicate, timeoutMs)` using MutationObserver
5. Background ↔ content messaging via `chrome.tabs.sendMessage` with typed envelope

**Acceptance:** from devtools console of the side panel, can call `readPage()` and get a structured tree; can `clickElement("e42")` on a button and see it fire.

---

## Phase 4 — Tool integration with Claude

**Goal:** Claude can call tools; results flow back; loop continues.

Steps:
1. Define tool schemas in `shared/tools.ts` (JSON Schema, mirrored on server)
2. Server forwards `tools` array to Anthropic Messages API
3. Background worker:
   - On `tool_use` event from stream → look up tool in registry → execute
   - For tab-bound tools, send message to active tab's content script
   - Build `tool_result` content block, append to messages, continue the conversation (new request to proxy with updated history)
4. Side panel UI: render tool calls as cards (collapsed by default, expandable to show input/output)
5. Implement first wave of tools:
   - `navigate(url)`
   - `get_page_text()` → returns a11y tree
   - `find(query)` → semantic search over tree
   - `click(element_id)`
   - `type(element_id, text)`
   - `screenshot()` via `chrome.tabs.captureVisibleTab`
   - `get_active_tab()`

**Acceptance:** prompt "go to wikipedia.org and tell me the featured article" → agent navigates, reads page, summarizes.

---

## Phase 5 — Advanced tools

**Goal:** parity with Claude-in-Chrome's deeper toolset.

Steps:
1. `chrome.debugger` attach/detach lifecycle (with user confirmation banner — Chrome shows its own bar)
2. `read_console_messages(tabId)` — Runtime.consoleAPICalled + Log.entryAdded
3. `read_network_requests(tabId, filter)` — Network domain events
4. `javascript_tool(code)` — `chrome.scripting.executeScript` with world isolation
5. Tab management: `tabs_create`, `tabs_close`, `tabs_switch`, `tabs_list`
6. `form_input(id, value)` for selects/checkboxes/radio
7. `file_upload(id, fileRef)` — handle blob refs from chat attachments

**Acceptance:** "open three tabs (NYT, BBC, Reuters), pull the top headline from each, screenshot each, summarize" works end-to-end.

---

## Phase 6 — Safety, auth, polish

**Goal:** safe to actually use; not embarrassing to demo.

Steps:
1. **Action confirmation modal** in side panel for: navigation off-domain, form submit, file upload, JS eval, `chrome.debugger` attach
2. **Domain policy** in settings: allowlist / blocklist / "ask every time"
3. **Per-site tier** (read-only / click-only / full) mirroring the Claude-in-Chrome model
4. **Link safety**: never auto-click links in pages flagged as untrusted (email clients, chat apps); show URL preview first
5. **Device pairing** in server: replace shared secret with per-install token issued via short-lived code shown in side panel
6. **Rate limiting** on server; abort/cancel in-flight requests on user "stop"
7. **Error UX**: tool failures shown inline, retry button
8. **Onboarding**: first-run flow walks through proxy URL setup, pair code, and a "try it" prompt

**Acceptance:** can hand the extension to someone else, they pair, run the demo prompt, and nothing scary happens.

---

## Phase 7 — Stretch (not blocking v1)

- Multi-tab orchestration (agent operates across tabs in one task)
- Conversation history persistence across browser restarts (encrypted `chrome.storage.local`)
- Replay / share a conversation as a transcript
- Voice input
- Keyboard shortcut to summon side panel with current selection as context

---

## Cross-cutting concerns

**Service worker lifecycle.** SW terminates after ~30s idle. Keep all conversation state in `chrome.storage.session` and re-hydrate on wake. Use `chrome.alarms` for any long-running waits, not `setTimeout`.

**Stable element IDs.** Page mutations can invalidate IDs between turns. Strategy: assign IDs at serialization time, validate liveness before each action, return a clear `stale_element` error to the model so it re-reads.

**Streaming + tool calls.** Anthropic emits `tool_use` mid-stream. Don't render the assistant text turn as "done" until `message_stop`; tool execution happens after `message_stop`, then a new request continues the conversation.

**iframes & shadow DOM.** Same-origin iframes: traverse via `contentDocument`. Cross-origin: would need `all_frames: true` content script injection + frame messaging — Phase 5+ if needed.

**CSP-restricted sites.** Some sites block injected scripts. `chrome.scripting.executeScript` with `world: "MAIN"` works on most; `chrome.debugger` is the universal fallback for reading state.

---

## Open questions to resolve as we build

1. Where will the proxy server be hosted long-term? (Local for dev is fine; production = Fly.io / Railway / your own VPS?)
2. Should we support multiple Claude models, or pin to one (e.g. Sonnet 4.6) for v1?
3. Conversation persistence: per-tab (resets when tab closes) or per-thread (user-named conversations)?
4. Do we want a "vision" path (sending screenshots to Claude as image input) from day one, or text-only for v1?

We'll answer these as they come up — none block Phase 0.

---

## Next action

Start Phase 0: bootstrap the monorepo, scaffold both packages, get an empty side panel loading in Chrome.
