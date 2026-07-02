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

/**
 * Coordinate-space bridge between the screenshot the model sees and the CSS
 * pixels CDP needs. On a retina display captureVisibleTab returns a 2x image;
 * CDP Input events use CSS pixels. We downscale the screenshot to CSS-pixel
 * dimensions (kept under Anthropic's ~1568px rescale threshold) so the model's
 * reported coordinates map 1:1 to the pixels we click. `coordScale` is CSS px
 * per image px — updated on every screenshot, applied on every click.
 */
let coordScale = 1;

/**
 * Bounds that keep the sent image under Anthropic's internal rescale (which
 * would otherwise change the coordinate space): <=1400px long edge AND
 * <=1.1 megapixels total. Staying under both means the model sees exactly the
 * pixels we send, so its click coordinates map cleanly back to CSS px.
 */
const MAX_SHOT_EDGE = 1400;
const MAX_SHOT_AREA = 1_100_000;

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
    if (tab.id === undefined) throw new Error("no active tab");

    // JPEG at q70 is ~5x smaller than PNG and still crisp enough to read UI.
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 70,
    });

    // How many CSS px does the captured (device-px) image represent? On retina
    // dpr=2, so a 2560px-wide capture is a 1280px CSS viewport. We need that to
    // map the model's click coordinates back to CSS px for CDP.
    let dpr = 1;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.devicePixelRatio || 1,
      });
      if (typeof res?.result === "number" && res.result > 0) dpr = res.result;
    } catch {
      // restricted page — assume 1x
    }

    const { base64, scale } = await downscaleShot(dataUrl, dpr);
    coordScale = scale;
    if (!base64) throw new Error("screenshot capture returned no image data");
    return {
      mime_type: "image/jpeg",
      base64,
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

  async click_at_coordinate({ x, y }: { x: number; y: number }) {
    if (typeof x !== "number" || typeof y !== "number") {
      throw new Error("x and y must be numbers");
    }
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    const cx = Math.round(x * coordScale);
    const cy = Math.round(y * coordScale);
    await cdpMouseClick(tab.id, cx, cy, 1);
    return { clicked: { x, y } };
  },

  async double_click_at_coordinate({ x, y }: { x: number; y: number }) {
    if (typeof x !== "number" || typeof y !== "number") {
      throw new Error("x and y must be numbers");
    }
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    const cx = Math.round(x * coordScale);
    const cy = Math.round(y * coordScale);
    await cdpMouseClick(tab.id, cx, cy, 2);
    return { double_clicked: { x, y } };
  },

  async type_at_cursor({ text }: { text: string }) {
    if (typeof text !== "string" || !text) throw new Error("text must be a non-empty string");
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    await cdpInsertText(tab.id, text);
    return { typed: text };
  },

  async key_press({ key, modifiers }: { key: string; modifiers?: string[] }) {
    if (typeof key !== "string" || !key) throw new Error("key must be a non-empty string");
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    const mods = Array.isArray(modifiers) ? modifiers : [];
    await cdpKeyPress(tab.id, key, mods);
    return { pressed: key };
  },

  async wait({ ms }: { ms?: number }) {
    const delay = Math.min(Math.max(ms ?? 800, 100), 5000);
    await new Promise((r) => setTimeout(r, delay));
    return { waited_ms: delay };
  },
};

/**
 * Downscale a captured (device-pixel) screenshot so the image the model sees
 * is in CSS pixels and stays under Anthropic's rescale threshold. Returns the
 * base64 JPEG plus `scale` = CSS px per image px, used to map click coords.
 */
async function downscaleShot(
  dataUrl: string,
  dpr: number,
): Promise<{ base64: string; scale: number }> {
  const stripPrefix = (u: string) => u.replace(/^data:image\/[a-z]+;base64,/, "");
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);

    // CSS dimensions of the captured area.
    const cssW = bitmap.width / dpr;
    const cssH = bitmap.height / dpr;

    // Target: CSS size, clamped under BOTH the long-edge and total-area limits.
    const longEdge = Math.max(cssW, cssH);
    const clampEdge = longEdge > MAX_SHOT_EDGE ? MAX_SHOT_EDGE / longEdge : 1;
    const area = cssW * cssH;
    const clampArea = area > MAX_SHOT_AREA ? Math.sqrt(MAX_SHOT_AREA / area) : 1;
    const clamp = Math.min(clampEdge, clampArea);
    const targetW = Math.max(1, Math.round(cssW * clamp));
    const targetH = Math.max(1, Math.round(cssH * clamp));

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { base64: stripPrefix(dataUrl), scale: 1 };
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const buf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    // image px → CSS px factor: one image px covers (cssW/targetW) CSS px.
    const scale = cssW / targetW;
    return { base64: btoa(binary), scale };
  } catch {
    // Fallback: send as-is, best-effort scale from dpr.
    return { base64: stripPrefix(dataUrl), scale: dpr > 0 ? 1 / dpr : 1 };
  }
}

async function cdpMouseClick(tabId: number, x: number, y: number, clickCount = 1): Promise<void> {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3").catch(() => {});
  try {
    // Move first so hover states trigger correctly.
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", clickCount: 0, modifiers: 0,
    });
    const base = { x, y, button: "left" as const, clickCount, modifiers: 0 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function cdpInsertText(tabId: number, text: string): Promise<void> {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3").catch(() => {});
  try {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

const KEY_CODE_MAP: Record<string, { keyCode: number; code: string }> = {
  Enter: { keyCode: 13, code: "Enter" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
};

async function cdpKeyPress(tabId: number, key: string, modifiers: string[]): Promise<void> {
  const target = { tabId };
  const modifierBits = modifiers.reduce((acc, m) => {
    if (m === "ctrl" || m === "control") return acc | 2;
    if (m === "shift") return acc | 8;
    if (m === "alt") return acc | 1;
    if (m === "meta" || m === "cmd") return acc | 4;
    return acc;
  }, 0);
  const extra = KEY_CODE_MAP[key] ?? { keyCode: key.charCodeAt(0), code: `Key${key.toUpperCase()}` };
  await chrome.debugger.attach(target, "1.3").catch(() => {});
  try {
    const base = { key, ...extra, modifiers: modifierBits };
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

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
