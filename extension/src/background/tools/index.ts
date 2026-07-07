/**
 * Tool dispatcher.
 *
 * Two layers of tools:
 *  - Anthropic's official computer-use tool (`computer`, type computer_20251124)
 *    — the interface the model is trained on: screenshot, clicks, drag, keys,
 *    scroll, zoom. Executed via Chrome Debugger Protocol on the active tab.
 *  - Custom DOM fast-path tools (read_page, click-by-id, type-by-id, …) for
 *    ordinary pages, plus tabs/navigate, plus `batch_actions` which runs a
 *    predictable sequence of computer actions in ONE round trip.
 *
 * Each handler returns a JSON-serializable value; the result gets
 * `JSON.stringify`'d before going back to Claude as `tool_result.content`.
 * Handlers throw on failure; the agent loop returns `is_error: true`.
 */

import {
  clickInActivePage,
  findInActivePage,
  formInputInActivePage,
  getActiveTab,
  readActivePage,
  rectInActivePage,
  scrollActivePageTo,
  findFileInputInActivePage,
  setFileInActivePage,
  textOfActivePage,
  typeInActivePage,
  waitForSettleInActivePage,
} from "../page-bridge";

export type ToolHandler = (input: any) => Promise<unknown>;

// ── Screenshot sizing ─────────────────────────────────────────────────────────

/**
 * Coordinate-space bridge between the screenshot the model sees and the CSS
 * pixels CDP needs. On a retina display captureVisibleTab returns a 2x image;
 * CDP Input events use CSS pixels. We downscale the screenshot to CSS-pixel
 * dimensions (kept under Anthropic's rescale threshold) so the model's
 * reported coordinates map 1:1. `coordScale` = CSS px per image px — updated
 * on every screenshot, applied on every mouse action.
 */
let coordScale = 1;

/** Last known mouse position (image px), for cursor_position / mouse_up. */
let lastPos = { x: 0, y: 0 };

const MAX_SHOT_EDGE = 1400;
const MAX_SHOT_AREA = 1_100_000;

/**
 * Probe the active tab's viewport and return the dimensions screenshots will
 * be sent at — used to declare display_width/height_px on the computer tool.
 * Falls back to a common laptop viewport on restricted pages.
 */
export async function probeDisplayDims(): Promise<{ width: number; height: number }> {
  try {
    const tab = await getActiveTab();
    if (tab.id !== undefined) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ w: window.innerWidth, h: window.innerHeight }),
      });
      const r = res?.result as { w?: number; h?: number } | undefined;
      if (r && typeof r.w === "number" && r.w > 0 && typeof r.h === "number" && r.h > 0) {
        return computeShotDims(r.w, r.h);
      }
    }
  } catch {
    // fall through to default
  }
  return computeShotDims(1280, 800);
}

/**
 * Given a CSS-pixel viewport, the dimensions screenshots will be sent at.
 * Exported so the agent loop can declare display_width/height_px on the
 * computer tool to exactly match what the model will see.
 */
export function computeShotDims(cssW: number, cssH: number): { width: number; height: number } {
  const longEdge = Math.max(cssW, cssH);
  const clampEdge = longEdge > MAX_SHOT_EDGE ? MAX_SHOT_EDGE / longEdge : 1;
  const area = cssW * cssH;
  const clampArea = area > MAX_SHOT_AREA ? Math.sqrt(MAX_SHOT_AREA / area) : 1;
  const clamp = Math.min(clampEdge, clampArea);
  return {
    width: Math.max(1, Math.round(cssW * clamp)),
    height: Math.max(1, Math.round(cssH * clamp)),
  };
}

// ── CDP session (persistent attach, idle detach) ─────────────────────────────

let attachedTabId: number | null = null;
let detachTimer: ReturnType<typeof setTimeout> | null = null;

/** Per-tab console + network buffers, filled while the debugger is attached. */
interface ConsoleEntry { level: string; text: string; ts: number }
interface NetworkEntry { method: string; url: string; status?: number; type?: string; ts: number }
const consoleBuf = new Map<number, ConsoleEntry[]>();
const networkBuf = new Map<number, NetworkEntry[]>();
const pendingReqs = new Map<string, { method: string; url: string }>();
const BUF_CAP = 200;

function pushCapped<T>(map: Map<number, T[]>, tabId: number, entry: T): void {
  const arr = map.get(tabId) ?? [];
  arr.push(entry);
  if (arr.length > BUF_CAP) arr.splice(0, arr.length - BUF_CAP);
  map.set(tabId, arr);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const p = params as any;
  if (method === "Runtime.consoleAPICalled") {
    const text = (p?.args ?? [])
      .map((a: any) => a?.value ?? a?.description ?? "")
      .join(" ")
      .slice(0, 500);
    pushCapped(consoleBuf, tabId, { level: p?.type ?? "log", text, ts: Date.now() });
  } else if (method === "Runtime.exceptionThrown") {
    const d = p?.exceptionDetails;
    const text = (d?.exception?.description ?? d?.text ?? "exception").slice(0, 500);
    pushCapped(consoleBuf, tabId, { level: "error", text, ts: Date.now() });
  } else if (method === "Network.requestWillBeSent") {
    pendingReqs.set(p?.requestId, {
      method: p?.request?.method ?? "GET",
      url: String(p?.request?.url ?? "").slice(0, 300),
    });
  } else if (method === "Page.javascriptDialogOpening") {
    // Native alert/confirm/prompt would freeze the tab forever — accept it,
    // record what it said so the model knows it happened.
    pushCapped(consoleBuf, tabId, {
      level: "dialog",
      text: `[${p?.type ?? "dialog"} auto-accepted] ${String(p?.message ?? "").slice(0, 300)}`,
      ts: Date.now(),
    });
    void chrome.debugger
      .sendCommand({ tabId }, "Page.handleJavaScriptDialog", {
        accept: true,
        promptText: p?.defaultPrompt ?? "",
      })
      .catch(() => {});
  } else if (method === "Network.responseReceived") {
    const req = pendingReqs.get(p?.requestId);
    pendingReqs.delete(p?.requestId);
    pushCapped(networkBuf, tabId, {
      method: req?.method ?? "GET",
      url: req?.url ?? String(p?.response?.url ?? "").slice(0, 300),
      status: p?.response?.status,
      type: p?.type,
      ts: Date.now(),
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) attachedTabId = null;
});

/** Detach immediately — the agent loop calls this when a turn finishes so
 * Chrome's debugger bar doesn't linger after Eva is done. */
export async function releaseDebugger(): Promise<void> {
  if (detachTimer) clearTimeout(detachTimer);
  await detachDebugger();
}

async function detachDebugger(): Promise<void> {
  if (attachedTabId == null) return;
  const target = { tabId: attachedTabId };
  attachedTabId = null;
  await chrome.debugger.detach(target).catch(() => {});
}

/**
 * Send a CDP command, keeping the debugger attached across consecutive
 * actions (a batch = one attach, not N) and detaching after 2s of quiet so
 * Chrome's "is debugging this browser" bar doesn't linger.
 */
async function cdp(tabId: number, method: string, params: object): Promise<unknown> {
  if (attachedTabId !== null && attachedTabId !== tabId) await detachDebugger();
  if (attachedTabId === null) {
    await chrome.debugger.attach({ tabId }, "1.3").catch((err) => {
      // Already attached (e.g. by a previous crash) is fine; anything else isn't.
      if (!String(err?.message ?? err).includes("Already attached")) throw err;
    });
    attachedTabId = tabId;
    // Start collecting console + network while we're attached — powers the
    // read_console / read_network tools with zero extra permissions.
    void chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {}).catch(() => {});
    void chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(() => {});
    void chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => {});
  }
  if (detachTimer) clearTimeout(detachTimer);
  detachTimer = setTimeout(() => void detachDebugger(), 10_000);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Keyboard mapping ──────────────────────────────────────────────────────────

const MOD_BITS: Record<string, number> = {
  alt: 1, option: 1,
  ctrl: 2, control: 2,
  meta: 4, cmd: 4, command: 4, super: 4, win: 4,
  shift: 8,
};

interface KeyDef { key: string; code: string; keyCode: number; text?: string }

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  page_down: { key: "PageDown", code: "PageDown", keyCode: 34 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  page_up: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  minus: { key: "-", code: "Minus", keyCode: 189, text: "-" },
  plus: { key: "+", code: "Equal", keyCode: 187, text: "+" },
  equal: { key: "=", code: "Equal", keyCode: 187, text: "=" },
};

for (let f = 1; f <= 12; f++) {
  NAMED_KEYS[`f${f}`] = { key: `F${f}`, code: `F${f}`, keyCode: 111 + f };
}

/** Parse an xdotool-style combo ("ctrl+shift+s", "Return") into CDP params. */
function parseCombo(combo: string): { modifiers: number; def: KeyDef } {
  const parts = combo.trim().split("+").map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  let keyPart = parts[parts.length - 1] ?? "";
  for (const p of parts.slice(0, -1)) {
    const bit = MOD_BITS[p.toLowerCase()];
    if (bit == null) throw new Error(`unknown modifier "${p}" in "${combo}"`);
    modifiers |= bit;
  }
  // A combo like "ctrl+shift" (modifier as final key) — treat last as modifier press.
  if (MOD_BITS[keyPart.toLowerCase()] != null && parts.length === 1) {
    keyPart = keyPart.toLowerCase();
    const names: Record<string, KeyDef> = {
      ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
      control: { key: "Control", code: "ControlLeft", keyCode: 17 },
      shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
      alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
      option: { key: "Alt", code: "AltLeft", keyCode: 18 },
      meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      cmd: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      command: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      super: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      win: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    };
    return { modifiers: 0, def: names[keyPart] };
  }
  const named = NAMED_KEYS[keyPart.toLowerCase()];
  if (named) return { modifiers, def: named };
  if (keyPart.length === 1) {
    const upper = keyPart.toUpperCase();
    const isLetter = upper >= "A" && upper <= "Z";
    const shifted = (modifiers & 8) !== 0;
    return {
      modifiers,
      def: {
        key: shifted && isLetter ? upper : keyPart,
        code: isLetter ? `Key${upper}` : `Digit${keyPart}`,
        keyCode: upper.charCodeAt(0),
        // Only printable when no ctrl/meta held (else it's a shortcut).
        text: (modifiers & ~8) === 0 ? (shifted && isLetter ? upper : keyPart) : undefined,
      },
    };
  }
  throw new Error(`unknown key "${keyPart}" in combo "${combo}"`);
}

async function pressCombo(tabId: number, combo: string): Promise<void> {
  const { modifiers, def } = parseCombo(combo);
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  await cdp(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: def.text && modifiers === 0 ? "keyDown" : "rawKeyDown",
    ...(def.text && (modifiers & ~8) === 0 ? { text: def.text } : {}),
  });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

// ── Mouse primitives (coordinates arrive in screenshot-image px) ──────────────

type Button = "left" | "right" | "middle";

function toCss(coord: [number, number]): { x: number; y: number } {
  return { x: Math.round(coord[0] * coordScale), y: Math.round(coord[1] * coordScale) };
}

function modsFromText(text?: string): number {
  if (!text) return 0;
  return text.split("+").reduce((acc, p) => acc | (MOD_BITS[p.trim().toLowerCase()] ?? 0), 0);
}

async function mouseMove(tabId: number, x: number, y: number, modifiers = 0): Promise<void> {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", clickCount: 0, modifiers,
  });
}

async function mouseClick(
  tabId: number, x: number, y: number,
  button: Button, clickCount: number, modifiers = 0,
): Promise<void> {
  await mouseMove(tabId, x, y, modifiers);
  const base = { x, y, button, clickCount, modifiers };
  await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
}

async function mouseDrag(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers = 0,
): Promise<void> {
  await mouseMove(tabId, from.x, from.y, modifiers);
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, modifiers,
  });
  // Intermediate moves so drag-aware UIs (selections, sliders) track properly.
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "left", clickCount: 0, modifiers,
    });
  }
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, modifiers,
  });
}

// ── Screenshot / zoom ─────────────────────────────────────────────────────────

async function captureRaw(): Promise<{ dataUrl: string; dpr: number; tab: chrome.tabs.Tab }> {
  const tab = await getActiveTab();
  if (tab.windowId === undefined) throw new Error("no active window");
  if (tab.id === undefined) throw new Error("no active tab");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 70,
  });
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
  return { dataUrl, dpr, tab };
}

async function takeScreenshot(): Promise<Record<string, unknown>> {
  const { dataUrl, dpr, tab } = await captureRaw();
  const { base64, scale } = await downscaleShot(dataUrl, dpr);
  coordScale = scale;
  if (!base64) throw new Error("screenshot capture returned no image data");
  return { mime_type: "image/jpeg", base64, url: tab.url, title: tab.title };
}

/**
 * Zoom: crop `region` (screenshot-image px) from a FRESH raw capture at full
 * device resolution — small toolbar text becomes readable. Output clamped to
 * the same size limits as normal screenshots.
 */
async function zoomRegion(region: [number, number, number, number]): Promise<Record<string, unknown>> {
  const [x1, y1, x2, y2] = region;
  if (!(x2 > x1) || !(y2 > y1)) throw new Error("zoom region must be [x1,y1,x2,y2] with x2>x1, y2>y1");
  const { dataUrl, dpr } = await captureRaw();
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  // screenshot-image px → raw-capture px: image * coordScale = CSS; CSS * dpr = raw.
  const f = coordScale * dpr;
  const sx = Math.max(0, Math.round(x1 * f));
  const sy = Math.max(0, Math.round(y1 * f));
  const sw = Math.min(bitmap.width - sx, Math.round((x2 - x1) * f));
  const sh = Math.min(bitmap.height - sy, Math.round((y2 - y1) * f));
  if (sw < 4 || sh < 4) throw new Error("zoom region is outside the visible page");
  const dims = computeShotDims(sw, sh);
  const canvas = new OffscreenCanvas(dims.width, dims.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dims.width, dims.height);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
  const base64 = await blobToBase64(outBlob);
  return {
    mime_type: "image/jpeg",
    base64,
    note: `zoomed view of [${x1},${y1}]–[${x2},${y2}] — do NOT click using this image's coordinates; take a normal screenshot for coordinates`,
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// ── The computer action executor ──────────────────────────────────────────────

interface ComputerInput {
  action?: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  /** batch_actions extension: target a measured element instead of pixels. */
  element_id?: string;
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
  region?: [number, number, number, number];
}

function requireCoord(input: ComputerInput): [number, number] {
  const c = input.coordinate;
  if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
    throw new Error(`action "${input.action}" requires coordinate: [x, y]`);
  }
  return c as [number, number];
}

async function activeTabId(): Promise<number> {
  const tab = await getActiveTab();
  if (tab.id === undefined) throw new Error("no active tab");
  return tab.id;
}

async function executeComputerAction(input: ComputerInput): Promise<unknown> {
  const action = input.action ?? "";
  switch (action) {
    case "screenshot":
      return await takeScreenshot();

    case "zoom": {
      if (!Array.isArray(input.region) || input.region.length !== 4) {
        throw new Error("zoom requires region: [x1, y1, x2, y2]");
      }
      return await zoomRegion(input.region as [number, number, number, number]);
    }

    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      // Element targeting (batch precision): measure live center, CSS px.
      if (input.element_id) {
        const rect = await rectInActivePage(input.element_id);
        const tabId0 = await activeTabId();
        const button0: Button =
          action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
        const clicks0 = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        if (clicks0 > 1) {
          await mouseMove(tabId0, rect.cx, rect.cy, modsFromText(input.text));
          for (let i = 1; i <= clicks0; i++) {
            const base0 = { x: rect.cx, y: rect.cy, button: button0, clickCount: i, modifiers: modsFromText(input.text) };
            await cdp(tabId0, "Input.dispatchMouseEvent", { ...base0, type: "mousePressed" });
            await cdp(tabId0, "Input.dispatchMouseEvent", { ...base0, type: "mouseReleased" });
          }
        } else {
          await mouseClick(tabId0, rect.cx, rect.cy, button0, 1, modsFromText(input.text));
        }
        return { ok: true, action, element_id: input.element_id, at_css: [rect.cx, rect.cy] };
      }
      const c = requireCoord(input);
      const { x, y } = toCss(c);
      lastPos = { x: c[0], y: c[1] };
      const button: Button =
        action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      const tabId = await activeTabId();
      if (clicks > 1) {
        // Chrome needs escalating clickCount presses for dbl/triple detection.
        await mouseMove(tabId, x, y, modsFromText(input.text));
        for (let i = 1; i <= clicks; i++) {
          const base = { x, y, button, clickCount: i, modifiers: modsFromText(input.text) };
          await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
          await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
        }
      } else {
        await mouseClick(tabId, x, y, button, 1, modsFromText(input.text));
      }
      return { ok: true, action, at: c };
    }

    case "mouse_move": {
      // With element_id this is a HOVER: rest on the element + settle time.
      if (input.element_id) {
        const rect = await rectInActivePage(input.element_id);
        await mouseMove(await activeTabId(), rect.cx, rect.cy, 0);
        await new Promise((r) => setTimeout(r, 600));
        return { ok: true, action: "hover", element_id: input.element_id };
      }
      const c = requireCoord(input);
      const { x, y } = toCss(c);
      lastPos = { x: c[0], y: c[1] };
      await mouseMove(await activeTabId(), x, y);
      return { ok: true, action, at: c };
    }

    case "left_click_drag": {
      const start = input.start_coordinate;
      if (!Array.isArray(start) || start.length !== 2) {
        throw new Error("left_click_drag requires start_coordinate: [x, y]");
      }
      const end = requireCoord(input);
      lastPos = { x: end[0], y: end[1] };
      await mouseDrag(
        await activeTabId(),
        toCss(start as [number, number]),
        toCss(end),
        modsFromText(input.text),
      );
      return { ok: true, action, from: start, to: end };
    }

    case "left_mouse_down": {
      const c = input.coordinate ? requireCoord(input) : ([lastPos.x, lastPos.y] as [number, number]);
      const { x, y } = toCss(c);
      lastPos = { x: c[0], y: c[1] };
      const tabId = await activeTabId();
      await mouseMove(tabId, x, y);
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0,
      });
      return { ok: true, action, at: c };
    }

    case "left_mouse_up": {
      const c = input.coordinate ? requireCoord(input) : ([lastPos.x, lastPos.y] as [number, number]);
      const { x, y } = toCss(c);
      lastPos = { x: c[0], y: c[1] };
      await cdp(await activeTabId(), "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0,
      });
      return { ok: true, action, at: c };
    }

    case "type": {
      if (typeof input.text !== "string" || input.text.length === 0) {
        throw new Error("type requires text");
      }
      const tabId = await activeTabId();
      // With element_id: click the field first (focus), then insert.
      if (input.element_id) {
        const rect = await rectInActivePage(input.element_id);
        await mouseClick(tabId, rect.cx, rect.cy, "left", 1, 0);
        await new Promise((r) => setTimeout(r, 120));
      }
      await cdp(tabId, "Input.insertText", { text: input.text });
      return { ok: true, action, length: input.text.length };
    }

    case "key": {
      if (typeof input.text !== "string" || !input.text.trim()) {
        throw new Error('key requires text, e.g. "Return" or "ctrl+s"');
      }
      await pressCombo(await activeTabId(), input.text);
      return { ok: true, action, key: input.text };
    }

    case "hold_key": {
      if (typeof input.text !== "string" || !input.text.trim()) {
        throw new Error("hold_key requires text");
      }
      const seconds = Math.min(Math.max(input.duration ?? 1, 0.1), 10);
      const { modifiers, def } = parseCombo(input.text);
      const tabId = await activeTabId();
      const base = {
        key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers,
      };
      await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
      await new Promise((r) => setTimeout(r, seconds * 1000));
      await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      return { ok: true, action, held_s: seconds };
    }

    case "scroll": {
      const c = requireCoord(input);
      const { x, y } = toCss(c);
      const amount = Math.min(Math.max(input.scroll_amount ?? 3, 1), 30);
      const dir = input.scroll_direction ?? "down";
      // DOM wheel semantics: positive deltaY scrolls the page down.
      const deltaY = dir === "down" ? amount * 100 : dir === "up" ? -amount * 100 : 0;
      const deltaX = dir === "right" ? amount * 100 : dir === "left" ? -amount * 100 : 0;
      await cdp(await activeTabId(), "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX, deltaY,
        button: "none", clickCount: 0, modifiers: modsFromText(input.text),
      });
      return { ok: true, action, direction: dir, amount };
    }

    case "wait": {
      const seconds = Math.min(Math.max(input.duration ?? 1, 0.1), 10);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return { ok: true, action, waited_s: seconds };
    }

    case "cursor_position":
      return { ok: true, action, position: [lastPos.x, lastPos.y] };

    default:
      throw new Error(`unsupported computer action "${action}"`);
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

const HANDLERS: Record<string, ToolHandler> = {
  async computer(input: ComputerInput) {
    return await executeComputerAction(input ?? {});
  },

  /**
   * Run several computer actions in one round trip. Stops on the first error;
   * always finishes with a fresh screenshot so the model sees the result.
   */
  async batch_actions({ actions }: { actions?: ComputerInput[] }) {
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error("batch_actions requires actions: [{action: ...}, ...]");
    }
    if (actions.length > 20) throw new Error("batch_actions is limited to 20 steps");

    let completed = 0;
    let errorMsg: string | null = null;
    for (const step of actions) {
      // Screenshots mid-batch are pointless (the model can't see them until
      // the batch returns) — skip them; one is appended at the end anyway.
      if (step?.action === "screenshot") { completed++; continue; }
      try {
        await executeComputerAction(step ?? {});
        completed++;
        await new Promise((r) => setTimeout(r, 150));
      } catch (err) {
        errorMsg = `step ${completed + 1} (${step?.action}) failed: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    // Let the page settle (DOM quiet or 1.2s cap) before the result shot.
    await waitForSettleInActivePage(1200).catch(
      () => new Promise((r) => setTimeout(r, 350)),
    );
    const shot = await takeScreenshot().catch(() => null);
    return {
      ...(shot ?? {}),
      note: errorMsg
        ? `completed ${completed}/${actions.length} steps, then: ${errorMsg}. Screenshot shows the state after the last successful step.`
        : `completed ${completed}/${actions.length} steps. Screenshot shows the result.`,
    };
  },

  /**
   * Run JavaScript in the page's MAIN world — the escape hatch when normal
   * tools can't reach something. Always user-confirmed. Result is the last
   * expression's value, stringified and clipped.
   */
  async javascript_eval({ script }: { script: string }) {
    requireString(script, "script");
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (src: string) => {
        try {
          // eslint-disable-next-line no-eval
          const value = (0, eval)(src);
          const out =
            typeof value === "object" && value !== null
              ? JSON.stringify(value)
              : String(value);
          return { ok: true, value: String(out ?? "").slice(0, 4000) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      args: [script],
    });
    const r = res?.result as { ok?: boolean; value?: string; error?: string } | undefined;
    if (!r) throw new Error("script produced no result (page may block injection)");
    if (!r.ok) throw new Error(r.error ?? "script failed");
    return { result: r.value };
  },

  async read_page({ filter, max_chars, ref_id }: { filter?: string; max_chars?: number; ref_id?: string } = {}) {
    const snapshot = await readActivePage();
    const cap = Math.min(Math.max(max_chars ?? 40_000, 4_000), 100_000);

    // Focus on one subtree (e.g. just the menu that opened).
    if (ref_id) {
      let found: any = null;
      const locate = (n: any) => {
        if (!n || found) return;
        if (n.id === ref_id) { found = n; return; }
        (n.children ?? []).forEach(locate);
      };
      locate(snapshot.root);
      if (!found) throw new Error(`element ${ref_id} not found in the current page tree`);
      const json = JSON.stringify(found);
      return json.length <= cap
        ? { url: snapshot.url, subtree: found }
        : { url: snapshot.url, _truncated: true, data: json.slice(0, cap) };
    }

    if (filter === "interactive") {
      // Flat, token-lean list of things Eva can act on.
      const INTERACTIVE = new Set([
        "link", "button", "textbox", "combobox", "checkbox", "radio", "menuitem",
        "menuitemcheckbox", "menuitemradio", "tab", "option", "searchbox",
        "slider", "switch", "listbox", "submit", "select",
      ]);
      const out: unknown[] = [];
      const walk = (n: any) => {
        if (!n) return;
        if (n.visible && (INTERACTIVE.has(n.role) || n.value !== undefined)) {
          out.push({ id: n.id, role: n.role, name: n.name, value: n.value, bbox: n.bbox });
        }
        (n.children ?? []).forEach(walk);
      };
      walk(snapshot.root);
      // Trim whole items until the payload fits the cap.
      while (out.length > 0 && JSON.stringify(out).length > cap) {
        out.splice(Math.floor(out.length * 0.8));
      }
      return { url: snapshot.url, title: snapshot.title, interactive: out };
    }

    const json = JSON.stringify(snapshot);
    if (json.length <= cap) return snapshot;
    return {
      _truncated: true,
      _note: "Page snapshot was too large and has been truncated. Use filter: 'interactive' or the find tool for a leaner view.",
      data: json.slice(0, cap),
    };
  },

  /**
   * Semantic element search — "font selector", "save button", "menu item
   * Lexend". Returns ranked matches with ids (for click/hover/type) and
   * measured centers. Far cheaper and more precise than a full read_page.
   */
  async find({ query }: { query: string }) {
    requireString(query, "query");
    const matches = await findInActivePage(query);
    if (Array.isArray(matches) && matches.length === 0) {
      return {
        matches: [],
        note: "No visible element matched. Try different words, read_page for the full tree, or a screenshot if this is a canvas area.",
      };
    }
    return { matches };
  },

  /** Whole page as clean text — for reading/summarizing articles and docs. */
  async get_page_text() {
    return await textOfActivePage();
  },

  /**
   * Fetch an image/file by URL (background fetch bypasses page CORS) and
   * deliver it into a file input on the page — real uploads without a file
   * picker. 6MB cap.
   */
  async upload_image({ element_id, url, filename }: { element_id?: string; url: string; filename?: string }) {
    requireString(url, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size > 6_000_000) throw new Error("file too large (max 6MB)");
    const mime = blob.type || "application/octet-stream";
    const name =
      filename ??
      (decodeURIComponent(new URL(url).pathname.split("/").pop() || "upload") || "upload");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    let targetId = element_id;
    if (!targetId) {
      const found = (await findFileInputInActivePage()) as { id?: string } | null;
      if (!found?.id) {
        throw new Error(
          "no file-upload field found on the page — click the site's Upload/Add image button first (the input often appears after), then retry",
        );
      }
      targetId = found.id;
    }
    return await setFileInActivePage(targetId, name, mime, btoa(binary));
  },

  /** Recent console output (log/warn/error) captured while Eva works. */
  async read_console({ limit }: { limit?: number }) {
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    const entries = (consoleBuf.get(tab.id) ?? []).slice(-(limit ?? 40));
    return entries.length
      ? { entries }
      : { entries: [], note: "No console output captured yet — it records while Eva is acting on the page. Interact first, then read again." };
  },

  /** Recent network requests captured while Eva works. */
  async read_network({ filter, limit }: { filter?: string; limit?: number }) {
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    let entries = networkBuf.get(tab.id) ?? [];
    if (filter) {
      const f = filter.toLowerCase();
      entries = entries.filter(
        (e) => e.url.toLowerCase().includes(f) || String(e.status ?? "").startsWith(f),
      );
    }
    entries = entries.slice(-(limit ?? 40));
    return entries.length
      ? { requests: entries }
      : { requests: [], note: "No requests captured yet — recording happens while Eva acts on the page." };
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
    // Trusted click: measure the element's live center, then press a REAL
    // mouse there via CDP. Synthetic .click() fires no mousedown, which
    // mousedown-driven widgets (Google Docs toolbar, custom menus) ignore.
    try {
      const rect = await rectInActivePage(element_id);
      const tab = await getActiveTab();
      if (tab.id === undefined) throw new Error("no active tab");
      await mouseClick(tab.id, rect.cx, rect.cy, "left", 1, 0);
      return { clicked: element_id, at: [rect.cx, rect.cy], method: "mouse" };
    } catch (err) {
      // Stale ids must surface so the model re-reads; anything else (CDP
      // unavailable, restricted page) falls back to the DOM click.
      if (err instanceof Error && err.name === "stale_element") throw err;
      const domResult = await clickInActivePage(element_id);
      return { ...domResult, method: "dom" };
    }
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

  /**
   * Rest the real mouse on an element's center without clicking — opens
   * hover-driven UI (submenus with ▸ arrows, tooltips, reveal-on-hover
   * toolbars). Waits 600ms after moving so the UI has time to open.
   */
  async hover({ element_id }: { element_id: string }) {
    requireString(element_id, "element_id");
    const rect = await rectInActivePage(element_id);
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("no active tab");
    await mouseMove(tab.id, rect.cx, rect.cy, 0);
    await new Promise((r) => setTimeout(r, 600));
    return { hovering: element_id, at: [rect.cx, rect.cy] };
  },

  async scroll_to({ element_id }: { element_id: string }) {
    requireString(element_id, "element_id");
    return await scrollActivePageTo(element_id);
  },

  async navigate({ url }: { url: string }) {
    requireString(url, "url");
    const tab = await getActiveTab();
    if (tab.id === undefined) throw new Error("active tab has no id");
    const tabId = tab.id;
    if (url === "back" || url === "forward") {
      if (url === "back") await chrome.tabs.goBack(tabId);
      else await chrome.tabs.goForward(tabId);
      await new Promise((r) => setTimeout(r, 800));
      const t = await chrome.tabs.get(tabId);
      return { url: t.url ?? "", title: t.title ?? "", history: url };
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('url must start with http:// or https:// (or be "back"/"forward")');
    }
    return await navigateAndWait(tabId, url);
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

// ── Shared helpers ────────────────────────────────────────────────────────────

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
    const dims = computeShotDims(cssW, cssH);

    const canvas = new OffscreenCanvas(dims.width, dims.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { base64: stripPrefix(dataUrl), scale: 1 };
    ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const base64 = await blobToBase64(outBlob);
    // image px → CSS px factor: one image px covers (cssW/targetW) CSS px.
    return { base64, scale: cssW / dims.width };
  } catch {
    // Fallback: send as-is, best-effort scale from dpr.
    return { base64: stripPrefix(dataUrl), scale: dpr > 0 ? 1 / dpr : 1 };
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
  const handler = HANDLERS[name];
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
