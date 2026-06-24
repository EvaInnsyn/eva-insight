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
import { isConfigured, readSettings } from "./settings";
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
  if (!isConfigured(settings)) {
    safePost(port, {
      type: "chat/error",
      assistantMessageId,
      errorType: "not_configured",
      message:
        "Set the proxy URL and shared secret in the side panel settings.",
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
    const { info } = await runAgentLoop({
      settings,
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
    safePost(port, {
      type: "chat/done",
      assistantMessageId,
      info,
    });
    // Fire-and-forget: save this session's actions to the Eva Innsýn platform
    // (no-op if the user hasn't connected their account).
    void maybePushSession(messages, sessionActions, sessionStartedAt);
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
): Promise<void> {
  if (actions.length === 0) return;
  try {
    const result = await pushSession({
      title: deriveSessionTitle(messages),
      actions,
      startedAt,
      endedAt: new Date().toISOString(),
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
  return "Eva Insight session";
}
