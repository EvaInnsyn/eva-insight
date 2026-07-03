/**
 * Eva Insight — background service worker.
 *
 * Phase 2: owns the chat conversation, streams from the proxy, fans
 * tokens out to whatever side panel(s) are connected.
 *
 * Service workers terminate after ~30s idle. State is persisted in
 * chrome.storage.session and rehydrated on wake; in-flight streams
 * keep the worker alive via the open fetch + open port.
 */

import {
  CHAT_PORT_NAME,
  type BackgroundToSidePanel,
  type SidePanelToBackground,
} from "../shared/messages";
import type { ChatMessage, ProxyMessage } from "../shared/chat";
import { readSettings } from "./settings";
import { ProxyError } from "./proxy-client";
import { runAgentLoop } from "./agent-loop";
import { loadHistory, saveHistory } from "./session-store";
import {
  clickInActivePage,
  readActivePage,
  scrollActivePage,
  scrollActivePageTo,
  typeInActivePage,
} from "./page-bridge";
import {
  signIn as platformSignIn,
  signOut as platformSignOut,
  getStatus as platformStatus,
  getAccessToken,
  syncSession as platformSyncSession,
} from "./platform-auth";
import { pushSession, describeAction } from "./platform-sync";
import type {
  PlatformRequest,
  PlatformResponse,
  SessionAction,
} from "../shared/platform";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[eva-insight] background installed");
});

// --- Service-worker keepalive -------------------------------------------
// Chrome MV3 workers terminate after ~30 s idle. Between tool-call rounds
// there can be a gap where the fetch is done but the next hasn't started;
// an alarm every 25 s prevents termination during long agentic runs.
const KEEPALIVE_ALARM = "eva-keepalive";
let activeStreamCount = 0;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op: being invoked is enough to reset the idle timer.
  }
});

function startKeepAlive() {
  activeStreamCount++;
  if (activeStreamCount === 1) {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 25 / 60 });
  }
}

function stopKeepAlive() {
  activeStreamCount = Math.max(0, activeStreamCount - 1);
  if (activeStreamCount === 0) {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }
}

// One-click toolbar → open side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[eva-insight] setPanelBehavior failed", err));

// --- Per-port stream + confirmation registry ---------------------------

interface ActiveStream {
  controller: AbortController;
  assistantMessageId: string;
}

const activeStreams = new WeakMap<chrome.runtime.Port, ActiveStream>();

interface PendingConfirm {
  resolve: (decision: { allow: boolean; rememberOrigin?: string }) => void;
}
const pendingConfirms = new Map<string, PendingConfirm>();

// --- Connection handling -----------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHAT_PORT_NAME) return;

  port.onMessage.addListener((raw) => {
    handlePortMessage(port, raw as SidePanelToBackground).catch((err) => {
      console.error("[eva-insight] port message failed", err);
    });
  });

  port.onDisconnect.addListener(() => {
    const active = activeStreams.get(port);
    if (active) {
      active.controller.abort();
      activeStreams.delete(port);
    }
  });
});

async function handlePortMessage(
  port: chrome.runtime.Port,
  msg: SidePanelToBackground,
): Promise<void> {
  switch (msg.type) {
    case "chat/load":
      await replyHistory(port);
      return;
    case "chat/setHistory":
      await saveHistory(msg.messages);
      return;
    case "chat/abort": {
      const active = activeStreams.get(port);
      if (active) active.controller.abort();
      return;
    }
    case "chat/send":
      await startStream(port, msg.messages, msg.assistantMessageId);
      return;
    case "chat/confirmResponse": {
      const pending = pendingConfirms.get(msg.requestId);
      if (pending) {
        pending.resolve({
          allow: msg.allow,
          rememberOrigin: msg.rememberOrigin,
        });
        pendingConfirms.delete(msg.requestId);
      }
      return;
    }
  }
}

async function replyHistory(port: chrome.runtime.Port): Promise<void> {
  const messages = await loadHistory();
  safePost(port, { type: "chat/history", messages });
}

async function startStream(
  port: chrome.runtime.Port,
  messages: ProxyMessage[],
  assistantMessageId: string,
): Promise<void> {
  // Cancel any prior stream on this port.
  const prior = activeStreams.get(port);
  if (prior) prior.controller.abort();

  const settings = await readSettings();
  const accessToken = await getAccessToken();

  // Require either a Supabase login (accessToken) or a dev shared secret.
  if (!settings.proxyUrl.trim()) {
    safePost(port, {
      type: "chat/error",
      assistantMessageId,
      errorType: "not_configured",
      message: "Proxy URL is missing — open Settings and sign in to Eva.",
    });
    return;
  }
  if (!accessToken && !settings.sharedSecret.trim()) {
    safePost(port, {
      type: "chat/error",
      assistantMessageId,
      errorType: "not_configured",
      message: "Sign in to your Eva account to start chatting.",
    });
    return;
  }

  const controller = new AbortController();
  activeStreams.set(port, { controller, assistantMessageId });
  startKeepAlive();

  // Captured for the platform session log (synced after the turn completes).
  const sessionActions: SessionAction[] = [];
  const sessionStartedAt = new Date().toISOString();

  try {
    const { info, paused, messages: finalMessages } = await runAgentLoop({
      settings,
      accessToken,
      initialMessages: messages,
      signal: controller.signal,
      callbacks: {
        onTextDelta: (text) => {
          safePost(port, {
            type: "chat/delta",
            assistantMessageId,
            text,
          });
        },
        onToolStart: (tu, startedAt) => {
          sessionActions.push({
            type: tu.name,
            description: describeAction(tu.name, tu.input),
          });
          safePost(port, {
            type: "chat/toolStart",
            assistantMessageId,
            toolUseId: tu.id,
            name: tu.name,
            input: tu.input,
            startedAt,
          });
        },
        onToolEnd: (toolUseId, output, isError, finishedAt) => {
          safePost(port, {
            type: "chat/toolEnd",
            assistantMessageId,
            toolUseId,
            output,
            isError,
            finishedAt,
          });
        },
        onConfirm: (req) =>
          new Promise((resolve) => {
            const requestId = `conf_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
            pendingConfirms.set(requestId, { resolve });
            // Cleanup if the stream aborts before user decides
            const onAbort = () => {
              if (pendingConfirms.has(requestId)) {
                pendingConfirms.delete(requestId);
                resolve({ allow: false });
                controller.signal.removeEventListener("abort", onAbort);
              }
            };
            controller.signal.addEventListener("abort", onAbort);
            safePost(port, {
              type: "chat/confirmRequest",
              requestId,
              toolName: req.toolName,
              prompt: req.prompt,
              allowAlways: req.allowAlways,
            });
          }),
      },
      onAllowedDomainsChange: async (next) => {
        const cur = await readSettings();
        await chrome.storage.local.set({
          "eva-insight/settings": { ...cur, allowedDomains: next },
        });
      },
    });
    // If Eva paused at the round cap, tell the user — and make the note aware
    // of their monthly budget so they can decide before continuing burns it.
    if (paused) {
      const bearer = accessToken ?? settings.sharedSecret;
      const frac = await fetchUsageFraction(settings.proxyUrl, bearer);
      safePost(port, {
        type: "chat/delta",
        assistantMessageId,
        text: pauseNote(frac),
      });
    }
    safePost(port, {
      type: "chat/done",
      assistantMessageId,
      info,
    });
    // Fire-and-forget: save this session's actions to the Eva Innsýn platform
    // (no-op if the user hasn't connected their account).
    void maybePushSession(
      messages,
      sessionActions,
      sessionStartedAt,
      buildSessionSummary(finalMessages, paused, sessionActions.length),
    );
  } catch (err) {
    if (controller.signal.aborted) {
      safePost(port, {
        type: "chat/done",
        assistantMessageId,
        info: { stop_reason: "aborted" },
      });
      return;
    }
    const errorType =
      err instanceof ProxyError
        ? err.errorType
        : err instanceof Error
          ? err.name
          : "server_error";
    const message =
      err instanceof Error ? err.message : "unexpected error in proxy call";
    safePost(port, {
      type: "chat/error",
      assistantMessageId,
      errorType,
      message,
    });
  } finally {
    stopKeepAlive();
    if (activeStreams.get(port)?.controller === controller) {
      activeStreams.delete(port);
    }
  }
}

function safePost(
  port: chrome.runtime.Port,
  msg: BackgroundToSidePanel,
): void {
  try {
    port.postMessage(msg);
  } catch (err) {
    // Port may have disconnected mid-stream. That's fine — abort logic
    // handles cleanup via onDisconnect.
    console.debug("[eva-insight] postMessage on dead port", err);
  }
}

// Side panel persists messages by re-sending the whole array via
// chat/setHistory after every turn. Background also persists the
// assistant placeholder progressively so a worker restart mid-stream
// can recover. Phase 5 may move this to a write-through cache.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { type?: string };

  // Phase 2: persist chat history
  if (
    m.type === "chat/persist" &&
    Array.isArray((message as { messages?: ChatMessage[] }).messages)
  ) {
    saveHistory((message as { messages: ChatMessage[] }).messages).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  // Phase 3: debug routes (callable from side panel devtools console).
  // The side panel and the background worker share runtime.sendMessage,
  // so these become a poor-man's REPL until the Phase 4 tool dispatcher
  // wires them in to Claude proper.
  if (m.type?.startsWith("debug/page/")) {
    handleDebugPage(m as DebugPageMessage)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: {
            type: err?.name ?? "error",
            message: err?.message ?? String(err),
          },
        }),
      );
    return true;
  }

  // Eva Innsýn platform: sign in / out / status (request-response).
  if (
    m.type === "platform/signIn" ||
    m.type === "platform/signOut" ||
    m.type === "platform/status"
  ) {
    handlePlatformMessage(message as PlatformRequest)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies PlatformResponse),
      );
    return true;
  }

  // Auto-connect: content script on app.evai.is relays the platform session.
  if (m.type === "platform/syncSession") {
    platformSyncSession(
      m as {
        type: string;
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        email: string;
        userId: string;
      },
    ).catch((err) =>
      console.warn("[eva-insight] session relay failed:", err),
    );
    return false;
  }

  return false;
});

type DebugPageMessage =
  | { type: "debug/page/read" }
  | { type: "debug/page/click"; elementId: string }
  | { type: "debug/page/type"; elementId: string; text: string; replace?: boolean }
  | { type: "debug/page/scroll"; direction: "up" | "down"; amount?: number }
  | { type: "debug/page/scrollTo"; elementId: string };

async function handleDebugPage(msg: DebugPageMessage): Promise<unknown> {
  switch (msg.type) {
    case "debug/page/read":
      return await readActivePage();
    case "debug/page/click":
      return await clickInActivePage(msg.elementId);
    case "debug/page/type":
      return await typeInActivePage(msg.elementId, msg.text, msg.replace);
    case "debug/page/scroll":
      return await scrollActivePage(msg.direction, msg.amount);
    case "debug/page/scrollTo":
      return await scrollActivePageTo(msg.elementId);
  }
}

// --- Eva Innsýn platform integration -----------------------------------

async function handlePlatformMessage(
  msg: PlatformRequest,
): Promise<PlatformResponse> {
  switch (msg.type) {
    case "platform/signIn": {
      const status = await platformSignIn(msg.email, msg.password);
      return { ok: true, status };
    }
    case "platform/signOut":
      await platformSignOut();
      return { ok: true, status: { connected: false } };
    case "platform/status":
      return { ok: true, status: await platformStatus() };
    default:
      return { ok: false, error: "Unknown platform request" };
  }
}

/**
 * Save the just-finished turn's actions to the platform. Fire-and-forget:
 * never blocks or breaks the chat if the user isn't connected or sync fails.
 */
async function maybePushSession(
  messages: ProxyMessage[],
  actions: SessionAction[],
  startedAt: string,
  summary?: string,
): Promise<void> {
  if (actions.length === 0) return;
  try {
    const result = await pushSession({
      title: deriveSessionTitle(messages),
      actions,
      startedAt,
      endedAt: new Date().toISOString(),
      summary,
    });
    if (result.ok) {
      console.log(
        `[eva-insight] session synced to platform (${result.actionsStored} actions)`,
      );
    } else if (result.reason === "error") {
      console.warn("[eva-insight] session sync failed:", result.message);
    }
  } catch (err) {
    console.warn("[eva-insight] session sync threw", err);
  }
}

/**
 * Fetch how much of the user's monthly token budget is spent (0–1), taking the
 * higher of the input/output fractions. Returns null for dev-unlimited users or
 * on any error — callers treat null as "no budget warning".
 */
async function fetchUsageFraction(
  proxyUrl: string,
  bearer: string,
): Promise<number | null> {
  if (!proxyUrl.trim() || !bearer.trim()) return null;
  try {
    const res = await fetch(new URL("/v1/me", proxyUrl).toString(), {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      mode?: string;
      cap?: { input_tokens?: number; output_tokens?: number };
      used?: { input_tokens?: number; output_tokens?: number };
    };
    if (data.mode !== "metered" || !data.cap || !data.used) return null;
    const inFrac =
      (data.cap.input_tokens ?? 0) > 0
        ? (data.used.input_tokens ?? 0) / (data.cap.input_tokens ?? 1)
        : 0;
    const outFrac =
      (data.cap.output_tokens ?? 0) > 0
        ? (data.used.output_tokens ?? 0) / (data.cap.output_tokens ?? 1)
        : 0;
    return Math.max(inFrac, outFrac);
  } catch {
    return null;
  }
}

/**
 * The note Eva shows when she pauses at the round cap. If the user is deep into
 * their monthly budget, warn them before continuing spends the rest.
 */
function pauseNote(usageFraction: number | null): string {
  if (usageFraction != null && usageFraction >= 0.7) {
    const pct = Math.min(99, Math.round(usageFraction * 100));
    return (
      `\n\n_Ég hef tekið mörg skref og geri hlé hér. ⚠️ Þú ert búin að nota um **${pct}%** af Eva-notkuninni þinni í þessum mánuði — ef ég held áfram gæti þetta verk klárað stóran hluta af því sem eftir er. Skrifaðu **haltu áfram** ef þú vilt samt að ég haldi áfram._`
    );
  }
  return (
    "\n\n_Ég hef tekið mörg skref og geri hlé hér. Verkinu er kannski ekki alveg lokið — skrifaðu **haltu áfram** og ég held áfram þaðan sem frá var horfið._"
  );
}

/**
 * Compact Lotur overview built from text we already have — no AI call, so it
 * costs the client nothing. The title already carries the task (latest user
 * message); the summary carries the OUTCOME: Eva's final reply, clipped, plus
 * a paused marker when the task needs a "haltu áfram".
 */
function buildSessionSummary(
  finalMessages: ProxyMessage[],
  paused: boolean,
  actionCount: number,
): string {
  let finalReply = "";
  for (let i = finalMessages.length - 1; i >= 0; i--) {
    const m = finalMessages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      finalReply = m.content.trim();
    } else if (Array.isArray(m.content)) {
      finalReply = (m.content as any[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ")
        .trim();
    }
    if (finalReply) break;
  }

  const outcome = finalReply
    ? clipText(finalReply, 400)
    : `${actionCount} aðgerðir framkvæmdar.`;
  return paused ? `Í bið — verki ekki lokið. ${outcome}` : outcome;
}

function clipText(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Use the latest user message as the session title. */
function deriveSessionTitle(messages: ProxyMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.trim().length > 0
    ) {
      return m.content.trim();
    }
  }
  return "Eva Innsýn session";
}
