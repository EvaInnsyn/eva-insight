/**
 * Tool dispatcher.
 *
 * Each handler returns a JSON-serializable value; the result gets
 * `JSON.stringify`'d before going back to Claude as `tool_result.content`.
 *
 * Handlers throw on failure; the agent loop catches and returns
 * `is_error: true` to the model.
 */

import {
  clickInActivePage,
  formInputInActivePage,
  getActiveTab,
  readActivePage,
  scrollActivePage,
  scrollActivePageTo,
  typeInActivePage,
} from "../page-bridge";
import type { EvaToolName } from "../../shared/tools";

export type ToolHandler = (input: any) => Promise<unknown>;

const HANDLERS: Record<EvaToolName, ToolHandler> = {
  async read_page() {
    const snapshot = await readActivePage();
    const json = JSON.stringify(snapshot);
    // Webflow and other complex sites can produce enormous snapshots.
    // Cap at 40K chars (~10K tokens) so a single read never blows the context.
    if (json.length <= 40_000) return snapshot;
    return {
      _truncated: true,
      _note: "Page snapshot was too large and has been truncated to fit the context window. Focus on visible elements only.",
      data: json.slice(0, 40_000),
    };
  },

  async get_active_tab() {
    const tab = await getActiveTab();
    return {
      url: tab.url ?? "(unknown)",
      title: tab.title ?? "(no title)",
      tabId: tab.id,
    };
  },

  async click({ element_id }: { element_id: string }) {
    requireString(element_id, "element_id");
    return await clickInActivePage(element_id);
  },

  async type({
    element_id,
    text,
    append,
  }: {
    element_id: string;
    text: string;
    append?: boolean;
  }) {
    requireString(element_id, "element_id");
    requireString(text, "text");
    return await typeInActivePage(element_id, text, !append);
  },

  async scroll({
    direction,
    amount_px,
  }: {
    direction: "up" | "down";
    amount_px?: number;
  }) {
    if (direction !== "up" && direction !== "down") {
      throw new Error(`direction must be 'up' or 'down', got '${direction}'`);
    }
    return await scrollActivePage(direction, amount_px);
  },

  async scroll_to({ element_id }: { element_id: string }) {
    requireString(element_id, "element_id");
    return await scrollActivePageTo(element_id);
  },

  async navigate({ url }: { url: string }) {
    requireString(url, "url");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("url must start with http:// or https://");
    }
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("active tab has no id");
    const tabId = tab.id;
    return await navigateAndWait(tabId, url);
  },

  async screenshot() {
    const tab = await getActiveTab();
    if (tab.windowId === undefined) throw new Error("no active window");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    return {
      mime_type: "image/png",
      // Strip the data URL prefix for clean base64 the model can ingest.
      // Keep the size small in the JSON.stringify by truncating display
      // — full bytes are still in the field for Phase 7 vision use.
      base64: dataUrl.replace(/^data:image\/png;base64,/, ""),
      url: tab.url,
      title: tab.title,
    };
  },

  async form_input({
    element_id,
    value,
  }: {
    element_id: string;
    value: string;
  }) {
    requireString(element_id, "element_id");
    requireString(value, "value");
    return await formInputInActivePage(element_id, value);
  },

  async tabs_list() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      pinned: t.pinned,
    }));
  },

  async tabs_create({ url }: { url: string }) {
    requireString(url, "url");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("url must start with http:// or https://");
    }
    const tab = await chrome.tabs.create({ url, active: true });
    return { id: tab.id, url: tab.url ?? url };
  },

  async tabs_switch({ tab_id }: { tab_id: number }) {
    if (typeof tab_id !== "number") throw new Error("tab_id must be a number");
    const tab = await chrome.tabs.update(tab_id, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return { id: tab.id, url: tab.url };
  },

  async tabs_close({ tab_id }: { tab_id: number }) {
    if (typeof tab_id !== "number") throw new Error("tab_id must be a number");
    await chrome.tabs.remove(tab_id);
    return { closed: tab_id };
  },
};

async function navigateAndWait(
  tabId: number,
  url: string,
): Promise<{ url: string; title: string }> {
  const waitForLoad = new Promise<{ url: string; title: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("page load timed out after 15s"));
      }, 15_000);
      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        updatedTab: chrome.tabs.Tab,
      ) => {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({
            url: updatedTab.url ?? url,
            title: updatedTab.title ?? "",
          });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    },
  );
  await chrome.tabs.update(tabId, { url });
  const result = await waitForLoad;
  await new Promise((r) => setTimeout(r, 400));
  return result;
}

function requireString(v: unknown, name: string): asserts v is string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

export async function runTool(
  name: string,
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  const handler = (HANDLERS as Record<string, ToolHandler | undefined>)[name];
  if (!handler) {
    return {
      output: JSON.stringify({
        error: { type: "unknown_tool", message: `no tool named "${name}"` },
      }),
      isError: true,
    };
  }
  try {
    const result = await handler(input ?? {});
    return { output: JSON.stringify(result), isError: false };
  } catch (err) {
    const errObj = {
      error: {
        type: err instanceof Error ? err.name : "tool_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
    return { output: JSON.stringify(errObj), isError: true };
  }
}
