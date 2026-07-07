/**
 * Eva Insight content script.
 *
 * Phase 3: handles page/* messages from the background worker — reads the
 * accessibility tree, clicks, types, scrolls.
 *
 * The script lives in the isolated world per Manifest V3 defaults. It can
 * see and mutate the DOM but cannot read page JS globals. That's fine for
 * everything we do here.
 */

import { buildSnapshot } from "./a11y-tree";
import { findElements } from "./find";
import {
  click,
  formInput,
  rectOf,
  scroll,
  scrollTo,
  StaleElementError,
  typeText,
  waitForSettle,
} from "./actions";
import { resetRegistry } from "./element-registry";
import type { PageRequest, PageResponse } from "@/shared/page";

console.log("[eva-insight] content script v0.1 loaded:", location.href);

// --- SPA navigation: reset element ids when the URL changes ----------
let lastUrl = location.href;
const checkUrl = () => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    resetRegistry();
    console.debug("[eva-insight] reset element registry after navigation");
  }
};
window.addEventListener("popstate", checkUrl);
window.addEventListener("hashchange", checkUrl);
// pushState / replaceState don't fire events — patch them so we can react.
const wrap = <T extends "pushState" | "replaceState">(name: T) => {
  const orig = history[name];
  history[name] = function (this: History, ...args: Parameters<typeof orig>) {
    const ret = orig.apply(this, args);
    queueMicrotask(checkUrl);
    return ret;
  } as (typeof history)[T];
};
wrap("pushState");
wrap("replaceState");

// --- Background → content message handler -----------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPageRequest(message)) return false;
  // sendResponse must be sync OR we return true to keep the channel open
  void handle(message)
    .then((res) => sendResponse(res))
    .catch((err) => {
      const errType =
        err instanceof StaleElementError ? "stale_element" :
        err instanceof Error ? err.name : "page_error";
      const message =
        err instanceof Error ? err.message : "unknown content-script error";
      const response: PageResponse = {
        ok: false,
        error: { type: errType, message },
      };
      sendResponse(response);
    });
  return true; // async
});

function isPageRequest(m: unknown): m is PageRequest {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as { type?: unknown }).type === "string" &&
    ((m as { type: string }).type).startsWith("page/")
  );
}

async function handle(req: PageRequest): Promise<PageResponse> {
  switch (req.type) {
    case "page/read":
      return { ok: true, result: buildSnapshot() };
    case "page/click":
      return { ok: true, result: click(req.elementId) };
    case "page/type":
      return {
        ok: true,
        result: typeText(req.elementId, req.text, req.replace ?? true),
      };
    case "page/scroll":
      return {
        ok: true,
        result: scroll(req.direction, req.amount),
      };
    case "page/scrollTo":
      return { ok: true, result: scrollTo(req.elementId) };
    case "page/formInput":
      return {
        ok: true,
        result: formInput(req.elementId, req.value),
      };
    case "page/rect":
      return { ok: true, result: rectOf(req.elementId) };
    case "page/find":
      return { ok: true, result: findElements(req.query) };
    case "page/waitFor":
      return { ok: true, result: await waitForSettle(req.timeoutMs) };
  }
}
