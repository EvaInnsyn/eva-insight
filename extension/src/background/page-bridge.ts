/**
 * Background-side wrapper around chrome.tabs.sendMessage for talking to
 * the content script. All page interactions go through here so the rest
 * of the worker code stays out of the chrome.tabs API.
 */

import type {
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

export async function send<T = unknown>(
  tabId: number,
  request: PageRequest,
): Promise<T> {
  let raw: PageResponse<T>;
  try {
    raw = (await chrome.tabs.sendMessage(tabId, request)) as PageResponse<T>;
  } catch (err) {
    // Common case: "Could not establish connection. Receiving end does not exist."
    // means the content script isn't loaded on this page (e.g. user just opened
    // a fresh chrome:// or chrome-extension:// tab).
    throw new ContentScriptUnavailableError();
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
