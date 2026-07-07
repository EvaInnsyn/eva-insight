/**
 * Background-side wrapper around chrome.tabs.sendMessage for talking to
 * the content script. All page interactions go through here so the rest
 * of the worker code stays out of the chrome.tabs API.
 */

import type {
  ElementRect,
  PageRequest,
  PageResponse,
  PageSnapshot,
} from "@/shared/page";

const PROTECTED_URL_RE = /^(chrome|chrome-extension|edge|about|file|view-source):/i;

export class NoActiveTabError extends Error {
  constructor() {
    super("no active tab in current window");
    this.name = "NoActiveTabError";
  }
}

export class ProtectedTabError extends Error {
  constructor(public readonly url: string) {
    super(`cannot interact with protected URL: ${url}`);
    this.name = "ProtectedTabError";
  }
}

export class ContentScriptUnavailableError extends Error {
  constructor() {
    super("content script unavailable in active tab (try reloading the page)");
    this.name = "ContentScriptUnavailableError";
  }
}

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
  // First try the obvious path: the active tab in the current window.
  // When the user has DevTools focused this can return nothing — DevTools
  // counts as the "current window" but has no browser tabs of its own.
  let [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  // Fallback: find the most recently focused *normal* browser window and
  // use its active tab. This survives DevTools or the popup having focus.
  if (!tab || tab.id === undefined) {
    try {
      const win = await chrome.windows.getLastFocused({
        windowTypes: ["normal"],
      });
      if (win.id !== undefined) {
        [tab] = await chrome.tabs.query({
          active: true,
          windowId: win.id,
        });
      }
    } catch {
      // ignore — surface a NoActiveTabError below
    }
  }

  if (!tab || tab.id === undefined) throw new NoActiveTabError();
  if (tab.url && PROTECTED_URL_RE.test(tab.url)) {
    throw new ProtectedTabError(tab.url);
  }
  return tab;
}

/**
 * Inject the main content script into a tab on demand. Needed when the tab was
 * already open before the extension loaded (or was just updated) — the declared
 * content script only auto-injects into pages that load *after* install, so
 * pre-existing tabs have no receiver. Rather than ask the user to reload the
 * page, we inject it ourselves and carry on.
 */
async function ensureContentScript(tabId: number): Promise<boolean> {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  const files: string[] = [];
  for (const cs of scripts) {
    if (cs.matches?.includes("<all_urls>") && cs.js) files.push(...cs.js);
  }
  if (files.length === 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch {
    // Protected page or injection blocked — nothing we can do.
    return false;
  }
}

export async function send<T = unknown>(
  tabId: number,
  request: PageRequest,
): Promise<T> {
  let raw: PageResponse<T> | undefined;
  try {
    raw = (await chrome.tabs.sendMessage(tabId, request)) as PageResponse<T>;
  } catch {
    // "Could not establish connection" — content script isn't loaded on this
    // tab yet. Inject it ourselves and retry once, so the user never has to
    // manually reload the page.
    const injected = await ensureContentScript(tabId);
    if (!injected) throw new ContentScriptUnavailableError();
    await new Promise((r) => setTimeout(r, 200));
    try {
      raw = (await chrome.tabs.sendMessage(tabId, request)) as PageResponse<T>;
    } catch {
      throw new ContentScriptUnavailableError();
    }
  }
  if (!raw) throw new ContentScriptUnavailableError();
  if (!raw.ok) {
    const e = new Error(raw.error.message);
    e.name = raw.error.type;
    throw e;
  }
  return raw.result;
}

// Convenience wrappers used by debug routes (and by Phase 4 tool dispatch).

export async function readActivePage(): Promise<PageSnapshot> {
  const tab = await getActiveTab();
  return await send<PageSnapshot>(tab.id!, { type: "page/read" });
}

export async function clickInActivePage(
  elementId: string,
): Promise<{ id: string; tag: string }> {
  const tab = await getActiveTab();
  return await send(tab.id!, { type: "page/click", elementId });
}

export async function typeInActivePage(
  elementId: string,
  text: string,
  replace = true,
): Promise<{ id: string; tag: string; length: number }> {
  const tab = await getActiveTab();
  return await send(tab.id!, { type: "page/type", elementId, text, replace });
}

export async function scrollActivePage(
  direction: "up" | "down",
  amount?: number,
): Promise<{ x: number; y: number }> {
  const tab = await getActiveTab();
  return await send(tab.id!, { type: "page/scroll", direction, amount });
}

export async function scrollActivePageTo(
  elementId: string,
): Promise<{ x: number; y: number }> {
  const tab = await getActiveTab();
  return await send(tab.id!, { type: "page/scrollTo", elementId });
}

export async function formInputInActivePage(
  elementId: string,
  value: string,
): Promise<{ id: string; tag: string; state: string }> {
  const tab = await getActiveTab();
  return await send(tab.id!, { type: "page/formInput", elementId, value });
}

/** Fresh element geometry (scrolled into view) for trusted-click aiming. */
export async function rectInActivePage(elementId: string): Promise<ElementRect> {
  const tab = await getActiveTab();
  return await send<ElementRect>(tab.id!, { type: "page/rect", elementId });
}
