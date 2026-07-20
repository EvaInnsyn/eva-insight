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
  bindTaskTab,
  boundTaskTabId,
  clickInActivePage,
  findInActivePage,
  formInputInActivePage,
  getTaskTab,
  readActivePage,
  rectInActivePage,
  scrollActivePageTo,
  findFileInputInActivePage,
  setFileInActivePage,
  textOfActivePage,
  typeInActivePage,
  waitForSettleInActivePage,
} from "../page-bridge";
import { runChat, saveMemory } from "../proxy-client";
import { PLATFORM } from "../../shared/platform";
import type { EvaSettings } from "../settings";

export type ToolHandler = (input: any) => Promise<unknown>;

// ── Auth context (set per agent run) ─────────────────────────────────────────
// Some tools (deep find) call the proxy themselves and need the run's auth.
let authCtx: { settings: EvaSettings; accessToken: string | null } | null = null;
export function setToolAuthContext(
  ctx: { settings: EvaSettings; accessToken: string | null } | null,
): void {
  authCtx = ctx;
}

// ── Cross-origin frame search ────────────────────────────────────────────────
// Wix's canvas and Word Online's editor live in cross-origin iframes that the
// content script (top frame only) cannot see. We inject a self-contained
// matcher into every frame via chrome.scripting, then translate local hits
// into page coordinates by composing iframe offsets up the frame tree.

interface FrameHit {
  score: number;
  name: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Serialized into each frame — no imports, mirrors find.ts scoring (lite). */
function findInFrameFn(query: string): FrameHit[] {
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\u00f0/g, "d").replace(/\u00fe/g, "th");
  const q = norm(query);
  const tokens = q.split(/\s+/).filter((t) => t.length > 1);
  const sel =
    "a[href],button,input,select,textarea,summary,[role],[contenteditable],[onclick],[aria-label],[tabindex]";
  const out: FrameHit[] = [];
  const els = Array.from(document.querySelectorAll(sel));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el as HTMLElement);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
    const name = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLElement).innerText ||
      el.textContent ||
      ""
    ).trim().replace(/\s+/g, " ").slice(0, 80);
    if (!name) continue;
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const hay = norm(name + " " + role);
    let score = 0;
    if (norm(name) === q) score += 6;
    else if (hay.includes(q)) score += 4;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    if (score <= 0) continue;
    out.push({
      score, name, role,
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      w: r.width, h: r.height,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 6);
}

/** Locate a child frame's iframe element in its parent → viewport offset. */
function frameOffsetFn(childUrl: string): { left: number; top: number } | null {
  const iframes = Array.from(document.querySelectorAll("iframe"));
  let best: HTMLIFrameElement | null = null;
  let bestArea = 0;
  for (const f of iframes) {
    const r = f.getBoundingClientRect();
    const area = r.width * r.height;
    let matches = false;
    try {
      if (f.src) {
        const su = new URL(f.src, location.href);
        matches = childUrl.startsWith(su.origin);
      }
    } catch { /* ignore */ }
    // Prefer a URL match; fall back to the largest visible iframe (the canvas).
    if (matches && area > 0) { best = f as HTMLIFrameElement; break; }
    if (area > bestArea) { bestArea = area; best = f as HTMLIFrameElement; }
  }
  if (!best) return null;
  const r = best.getBoundingClientRect();
  return { left: r.left, top: r.top };
}

/**
 * Search cross-origin frames and return hits in PAGE viewport CSS px.
 * Depth-composed via the webNavigation frame tree.
 */
async function crossFrameFind(tabId: number, query: string): Promise<
  { frame: string; role: string; name: string; cssX: number; cssY: number }[]
> {
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  } catch {
    return [];
  }
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  const topOrigin = (() => {
    try { return new URL(byId.get(0)?.url ?? "").origin; } catch { return ""; }
  })();

  const results: { frame: string; role: string; name: string; cssX: number; cssY: number }[] = [];

  for (const fr of frames) {
    if (fr.frameId === 0) continue;
    let frOrigin = "";
    try { frOrigin = new URL(fr.url).origin; } catch { continue; }
    // Same-origin frames are already covered by the content script's walk.
    if (!frOrigin || frOrigin === topOrigin || fr.url === "about:blank") continue;

    let hits: FrameHit[] = [];
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [fr.frameId] },
        func: findInFrameFn,
        args: [query],
      });
      hits = (res?.result as FrameHit[]) ?? [];
    } catch { continue; }
    if (hits.length === 0) continue;

    // Compose offsets up the parent chain (depth-safe, max 4 hops).
    let dx = 0, dy = 0, ok = true;
    let cur = fr;
    for (let hop = 0; hop < 4 && cur.frameId !== 0; hop++) {
      const parent = byId.get(cur.parentFrameId);
      if (!parent) { ok = false; break; }
      try {
        const [off] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [parent.frameId] },
          func: frameOffsetFn,
          args: [cur.url],
        });
        const o = off?.result as { left: number; top: number } | null;
        if (!o) { ok = false; break; }
        dx += o.left; dy += o.top;
      } catch { ok = false; break; }
      cur = parent;
    }
    if (!ok || cur.frameId !== 0) continue;

    let host = "";
    try { host = new URL(fr.url).host; } catch { /* ignore */ }
    for (const h of hits) {
      results.push({
        frame: host, role: h.role, name: h.name,
        cssX: Math.round(h.x + dx), cssY: Math.round(h.y + dy),
      });
    }
  }
  return results;
}

/** Cheap model for micro-decisions (element matching). Exact pinned id. */
const HELPER_MODEL = "claude-haiku-4-5-20251001";

/**
 * Model-backed element matching: give Haiku the page's interactive elements
 * and the query; it picks the best ids. Used when lexical find comes up
 * empty (or on find{deep:true}) — understands MEANING, not just words
 * ("cancel subscription" → the "No thanks, keep paying" button).
 */
async function deepFind(query: string): Promise<unknown> {
  if (!authCtx) throw new Error("deep find unavailable (no auth context)");
  const snapshot = await readActivePage();
  const items: { id: string; role: string; name?: string; value?: string; cx?: number; cy?: number }[] = [];
  const INTERACTIVE = new Set([
    "link", "button", "textbox", "combobox", "checkbox", "radio", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "option", "searchbox",
    "slider", "switch", "listbox", "submit", "select",
  ]);
  const walk = (n: any) => {
    if (!n) return;
    if (n.visible && (INTERACTIVE.has(n.role) || n.value !== undefined)) {
      items.push({
        id: n.id, role: n.role,
        name: typeof n.name === "string" ? n.name.slice(0, 60) : undefined,
        value: typeof n.value === "string" ? n.value.slice(0, 30) : undefined,
        cx: n.bbox ? Math.round(n.bbox.x + n.bbox.w / 2) : undefined,
        cy: n.bbox ? Math.round(n.bbox.y + n.bbox.h / 2) : undefined,
      });
    }
    (n.children ?? []).forEach(walk);
  };
  walk(snapshot.root);
  while (items.length > 0 && JSON.stringify(items).length > 14_000) {
    items.splice(Math.floor(items.length * 0.85));
  }
  if (items.length === 0) return { matches: [], method: "model", note: "no interactive elements on page" };

  const result = await runChat({
    settings: authCtx.settings,
    accessToken: authCtx.accessToken,
    model: HELPER_MODEL,
    betas: [],
    thinking: "off",
    maxTokens: 200,
    system:
      'You match UI elements to a request. Reply with ONLY a JSON array of up to 3 element id strings, best match first, e.g. ["e12","e88"]. Reply [] if nothing plausibly matches.',
    messages: [
      {
        role: "user",
        content: `Request: ${query}

Elements:
${JSON.stringify(items)}`,
      },
    ],
    tools: [],
    signal: new AbortController().signal,
    onTextDelta: () => {},
  });

  const m = result.text.match(/\[[^\]]*\]/);
  let ids: string[] = [];
  try {
    ids = m ? (JSON.parse(m[0]) as string[]).filter((x) => typeof x === "string") : [];
  } catch {
    ids = [];
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const matches = ids.map((id) => byId.get(id)).filter(Boolean);
  return matches.length
    ? { matches, method: "model" }
    : { matches: [], method: "model", note: "AI matcher found nothing either — the target may be in a canvas area; try a screenshot." };
}

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
    const tab = await getTaskTab();
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

/** Parse a click-modifiers string ("ctrl+shift", "cmd") into CDP bits. */
function parseModifiers(mods?: string): number {
  if (!mods) return 0;
  let bits = 0;
  for (const part of mods.split("+")) {
    const bit = MOD_BITS[part.trim().toLowerCase()];
    if (bit != null) bits |= bit;
  }
  return bits;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Held-buttons bitmask (CDP `buttons`): pages read e.buttons in drag/gesture code. */
const BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4, none: 0 };

async function mouseMove(
  tabId: number, x: number, y: number, modifiers = 0, buttonsHeld = 0,
): Promise<void> {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: Math.round(x), y: Math.round(y),
    button: buttonsHeld ? "left" : "none", clickCount: 0, modifiers,
    buttons: buttonsHeld, ...(buttonsHeld ? { force: 0.5 } : {}),
  });
}

/**
 * Click choreography mirroring the reference build: hover first + 100ms dwell
 * (hover handlers register the pointer before the press), 12ms press-hold,
 * and multi-clicks as FULL press/release pairs with ascending clickCount —
 * double/triple-click detectors need the real pairs, not one clickCount:3
 * event. `buttons` bitmask set while pressed, cleared on release.
 */
async function mouseClick(
  tabId: number, x: number, y: number,
  button: Button, clickCount: number, modifiers = 0,
): Promise<void> {
  const px = Math.round(x);
  const py = Math.round(y);
  const bits = BUTTON_BITS[button] ?? 1;
  await mouseMove(tabId, px, py, modifiers);
  await sleep(100);
  for (let u = 1; u <= clickCount; u++) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: px, y: py, button, clickCount: u, modifiers,
      buttons: bits, force: 0.5,
    });
    await sleep(12);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: px, y: py, button, clickCount: u, modifiers,
      buttons: 0,
    });
    if (u < clickCount) await sleep(100);
  }
}

async function mouseDrag(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers = 0,
): Promise<void> {
  await mouseMove(tabId, from.x, from.y, modifiers);
  await sleep(100); // hover dwell — target registers the pointer first
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: Math.round(from.x), y: Math.round(from.y),
    button: "left", clickCount: 1, modifiers, buttons: 1, force: 0.5,
  });
  // Intermediate moves so drag-aware UIs (selections, sliders) track properly.
  // buttons:1 the whole way — pages track e.buttons to know the drag is live.
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "left", clickCount: 0, modifiers,
      buttons: 1, force: 0.5,
    });
  }
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: Math.round(to.x), y: Math.round(to.y),
    button: "left", clickCount: 1, modifiers, buttons: 0,
  });
}

// ── Verified scrolling ───────────────────────────────────────────────────────
// A CDP mouseWheel gets swallowed by some custom scroll containers, and does
// nothing reliable in background tabs. Reference behavior: check whether
// anything actually moved; if not, scroll the scrollable ancestor at the
// point directly via the DOM.

/** Serialized into the page: scroll offsets of window + ancestor at (x,y). */
function scrollProbeFn(x: number, y: number): { wx: number; wy: number; ex: number; ey: number } {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  let sc: HTMLElement | null = null;
  for (let hop = 0; el && hop < 12; hop++) {
    const st = getComputedStyle(el);
    if (
      /(auto|scroll|overlay)/.test(st.overflowY + st.overflowX) &&
      (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
    ) { sc = el; break; }
    el = el.parentElement;
  }
  return {
    wx: window.scrollX, wy: window.scrollY,
    ex: sc ? sc.scrollLeft : -1, ey: sc ? sc.scrollTop : -1,
  };
}

/** Serialized into the page: scroll the scrollable ancestor at (x,y). */
function domScrollAtFn(x: number, y: number, dx: number, dy: number): { scrolled: string } {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  for (let hop = 0; el && hop < 12; hop++) {
    const st = getComputedStyle(el);
    if (
      /(auto|scroll|overlay)/.test(st.overflowY + st.overflowX) &&
      (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
    ) {
      el.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
      return { scrolled: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") };
    }
    el = el.parentElement;
  }
  (document.scrollingElement ?? document.documentElement).scrollBy({
    left: dx, top: dy, behavior: "instant" as ScrollBehavior,
  });
  return { scrolled: "window" };
}

// ── Per-character typing (reference-build behavior) ─────────────────────────
// Pure Input.insertText never fires keydown/keyup, so autocomplete lists,
// search-as-you-type filters and keyboard-driven widgets don't react. The
// reference build types each ASCII char as REAL key events (with shift when
// needed) and falls back to insertText only for unmapped chars (þ, ð, é…).

interface CharKey { key: string; code: string; keyCode: number; shift: boolean }

const CHAR_KEYS: Record<string, CharKey> = {};
{
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    const code = `Key${upper}`;
    CHAR_KEYS[lower] = { key: lower, code, keyCode: 65 + i, shift: false };
    CHAR_KEYS[upper] = { key: upper, code, keyCode: 65 + i, shift: true };
  }
  const digits = ")!@#$%^&*(";
  for (let d = 0; d <= 9; d++) {
    const code = `Digit${d}`;
    CHAR_KEYS[String(d)] = { key: String(d), code, keyCode: 48 + d, shift: false };
    CHAR_KEYS[digits[d]] = { key: digits[d], code, keyCode: 48 + d, shift: true };
  }
  const punct: [string, string, string, number][] = [
    [";", ":", "Semicolon", 186], ["=", "+", "Equal", 187], [",", "<", "Comma", 188],
    ["-", "_", "Minus", 189], [".", ">", "Period", 190], ["/", "?", "Slash", 191],
    ["`", "~", "Backquote", 192], ["[", "{", "BracketLeft", 219],
    ["\\", "|", "Backslash", 220], ["]", "}", "BracketRight", 221], ["'", "\"", "Quote", 222],
  ];
  for (const [plain, shifted, code, keyCode] of punct) {
    CHAR_KEYS[plain] = { key: plain, code, keyCode, shift: false };
    CHAR_KEYS[shifted] = { key: shifted, code, keyCode, shift: true };
  }
  CHAR_KEYS[" "] = { key: " ", code: "Space", keyCode: 32, shift: false };
}

/** Type text at the cursor: real key events per char; insertText fallback. */
async function typeAtCursor(tabId: number, text: string): Promise<void> {
  // Queue all dispatches in order (CDP serializes per target) — awaiting each
  // round trip would make long texts crawl.
  const dispatches: Promise<unknown>[] = [];
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      const mods = 0;
      dispatches.push(cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        text: "\r", unmodifiedText: "\r", modifiers: mods,
      }));
      dispatches.push(cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: mods,
      }));
      continue;
    }
    const def = CHAR_KEYS[ch];
    if (def) {
      const mods = def.shift ? 8 : 0;
      dispatches.push(cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown", key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
        text: ch, unmodifiedText: ch, modifiers: mods,
      }));
      dispatches.push(cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers: mods,
      }));
    } else {
      dispatches.push(cdp(tabId, "Input.insertText", { text: ch }));
    }
  }
  await Promise.all(dispatches);
}

// ── Screenshot / zoom ─────────────────────────────────────────────────────────

async function captureRaw(): Promise<{ dataUrl: string; dpr: number; tab: chrome.tabs.Tab }> {
  const tab = await getTaskTab();
  if (tab.id === undefined) throw new Error("no task tab");
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
  // Visible path: classic capture, no debugger banner needed. A minimized
  // window can return a stale frame WITHOUT throwing, so check state first.
  if (tab.active && tab.windowId !== undefined) {
    let minimized = false;
    try {
      minimized = (await chrome.windows.get(tab.windowId)).state === "minimized";
    } catch { /* window gone — CDP path handles it */ }
    if (!minimized) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 70,
        });
        return { dataUrl, dpr, tab };
      } catch {
        // Capture blocked — fall through to CDP below.
      }
    }
  }
  // Background path: the user is on another tab or window. CDP renders OUR
  // tab regardless of focus, so the task keeps running while they browse.
  const res = (await cdp(tab.id, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 70,
  })) as { data?: string } | undefined;
  if (!res?.data) {
    throw new Error(
      "screenshot failed — the task tab may be unloaded; use tabs_switch to bring it forward once",
    );
  }
  return { dataUrl: `data:image/jpeg;base64,${res.data}`, dpr, tab };
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
  /** Target a measured element instead of pixels (schema name: ref). */
  element_id?: string;
  ref?: string;
  /** Click-action modifier string, e.g. "ctrl+shift". */
  modifiers?: string;
  /** key action: repeat the key sequence N times (1-100). */
  repeat?: number;
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
  region?: [number, number, number, number];
}

/** A batch step: a computer action, or a whitelisted DOM tool invocation. */
interface BatchStep extends ComputerInput {
  tool?: string;
  input?: Record<string, unknown>;
}

/**
 * Tools allowed inside batch_actions. Excluded on purpose: navigate/tabs_*
 * (need the agent loop's confirmation policy), javascript_eval (always
 * user-confirmed), batch_actions (recursion).
 */
const BATCHABLE_TOOLS = new Set([
  "find",
  "read_page",
  "get_page_text",
  "click",
  "type",
  "form_input",
  "hover",
  "scroll_to",
  "get_active_tab",
  "read_console",
  "read_network",
]);

function requireCoord(input: ComputerInput): [number, number] {
  const c = input.coordinate;
  if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
    throw new Error(`action "${input.action}" requires coordinate: [x, y]`);
  }
  return c as [number, number];
}

async function activeTabId(): Promise<number> {
  const tab = await getTaskTab();
  if (tab.id === undefined) throw new Error("no task tab");
  return tab.id;
}

/**
 * If the last action started a page load (link click, form submit), wait for
 * it to finish before the result screenshot — otherwise the model sees a
 * half-loaded page and acts on it. No-op (one tabs.get) when already loaded.
 */
async function waitForTabLoad(timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    let status: string | undefined;
    try {
      status = (await getTaskTab()).status;
    } catch {
      return;
    }
    if (status !== "loading") return;
    if (Date.now() - start >= timeoutMs) return;
    await new Promise((r) => setTimeout(r, 200));
  }
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
      // Element targeting (ref from find/read_page): measure live center, CSS px.
      const clickTarget = input.ref ?? input.element_id;
      const clickMods = parseModifiers(input.modifiers) || modsFromText(input.text);
      if (clickTarget) {
        let rect;
        try {
          rect = await rectInActivePage(clickTarget);
        } catch (err) {
          if (err instanceof Error && err.name === "stale_element") {
            throw new Error(
              `Element with ref '${clickTarget}' not found. It may have been removed from the page. Use read_page or find to get fresh refs.`,
            );
          }
          throw err;
        }
        const tabId0 = await activeTabId();
        const button0: Button =
          action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
        const clicks0 = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        await mouseClick(tabId0, rect.cx, rect.cy, button0, clicks0, clickMods);
        lastPos = { x: Math.round(rect.cx / coordScale), y: Math.round(rect.cy / coordScale) };
        return { ok: true, action, ref: clickTarget, at_css: [rect.cx, rect.cy] };
      }
      const c = requireCoord(input);
      const { x, y } = toCss(c);
      lastPos = { x: c[0], y: c[1] };
      const button: Button =
        action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      const tabId = await activeTabId();
      // mouseClick handles dwell, press-hold, buttons bitmask and the
      // escalating full press/release pairs multi-click detectors need.
      await mouseClick(tabId, x, y, button, clicks, clickMods);      return { ok: true, action, at: c };
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
        buttons: 1, force: 0.5,
      });
      return { ok: true, action, at: c };
    }

    case "left_mouse_up": {
      const c = input.coordinate ? requireCoord(input) : ([lastPos.x, lastPos.y] as [number, number]);
      const { x, y } = toCss(c);
      lastPos = { x: c[0], y: c[1] };
      await cdp(await activeTabId(), "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0,
        buttons: 0,
      });
      return { ok: true, action, at: c };
    }

    case "type": {
      if (typeof input.text !== "string" || input.text.length === 0) {
        throw new Error("type requires text");
      }
      const tabId = await activeTabId();
      // With ref/element_id: click the field first (focus), then type.
      const typeTarget = input.ref ?? input.element_id;
      if (typeTarget) {
        const rect = await rectInActivePage(typeTarget);
        await mouseClick(tabId, rect.cx, rect.cy, "left", 1, 0);
        await new Promise((r) => setTimeout(r, 120));
      }
      await typeAtCursor(tabId, input.text);
      return { ok: true, action, length: input.text.length };
    }

    case "key": {
      if (typeof input.text !== "string" || !input.text.trim()) {
        throw new Error('key requires text, e.g. "Return", "ctrl+s" or "Down Down Enter"');
      }
      const combos = input.text.trim().split(/\s+/);
      const repeat = Math.min(Math.max(Math.round(input.repeat ?? 1), 1), 100);
      if (combos.length * repeat > 200) {
        throw new Error("key sequence too long (max 200 presses per call)");
      }
      const tabId = await activeTabId();
      for (let r = 0; r < repeat; r++) {
        for (const combo of combos) {
          await pressCombo(tabId, combo);
          // tiny gap so keyboard-navigation UIs track each press
          if (combos.length * repeat > 1) await sleep(30);
        }
      }
      return { ok: true, action, key: input.text, presses: combos.length * repeat };
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
      const tab = await getTaskTab();
      if (tab.id === undefined) throw new Error("no task tab");
      const tabId = tab.id;
      const probe = () =>
        chrome.scripting
          .executeScript({ target: { tabId }, func: scrollProbeFn, args: [x, y] })
          .then((r) => r[0]?.result as { wx: number; wy: number; ex: number; ey: number } | undefined)
          .catch(() => undefined);
      const domScroll = () =>
        chrome.scripting
          .executeScript({ target: { tabId }, func: domScrollAtFn, args: [x, y, deltaX, deltaY] })
          .then((r) => (r[0]?.result as { scrolled: string } | undefined)?.scrolled ?? "window");
      // Background tab: wheel rendering is unreliable — scroll the DOM directly.
      if (!tab.active) {
        const scrolled = await domScroll().catch(() => null);
        if (scrolled) return { ok: true, action, direction: dir, amount, method: "dom", scrolled };
      }
      const before = await probe();
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX, deltaY,
        button: "none", clickCount: 0, modifiers: modsFromText(input.text),
      });
      if (before) {
        await sleep(200);
        const after = await probe();
        if (after) {
          const winMoved = Math.abs(after.wx - before.wx) > 5 || Math.abs(after.wy - before.wy) > 5;
          const elMoved =
            before.ex >= 0 && after.ex >= 0 &&
            (Math.abs(after.ex - before.ex) > 5 || Math.abs(after.ey - before.ey) > 5);
          if (!winMoved && !elMoved) {
            // Wheel swallowed — scroll the container directly.
            const scrolled = await domScroll().catch(() => null);
            if (scrolled) return { ok: true, action, direction: dir, amount, method: "dom-fallback", scrolled };
          }
        }
      }
      return { ok: true, action, direction: dir, amount, method: "wheel" };
    }

    case "hover": {
      const target = input.ref ?? input.element_id;
      const tabId = await activeTabId();
      if (target) {
        const rect = await rectInActivePage(target);
        await mouseMove(tabId, rect.cx, rect.cy, parseModifiers(input.modifiers));
        lastPos = { x: Math.round(rect.cx / coordScale), y: Math.round(rect.cy / coordScale) };
      } else {
        const c = requireCoord(input);
        const { x, y } = toCss(c);
        lastPos = { x: c[0], y: c[1] };
        await mouseMove(tabId, x, y, parseModifiers(input.modifiers));
      }
      // dwell so hover-driven UI (tooltips, submenus) has time to open
      await sleep(400);
      return { ok: true, action };
    }

    case "scroll_to": {
      const target = input.ref ?? input.element_id;
      if (!target) throw new Error("scroll_to requires ref (from read_page or find)");
      const pos = await scrollActivePageTo(target);
      return { ok: true, action, ref: target, scrolled_to: pos };
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
    const result = await executeComputerAction(input ?? {});
    // Reference-harness behavior the model is trained on: every acting
    // step returns a fresh screenshot of the result, so act+see is ONE
    // round instead of two. Pure reads keep their JSON result.
    const a = input?.action ?? "";
    const NO_SHOT = new Set(["screenshot", "zoom", "wait", "cursor_position", "scroll_to"]);
    if (a && !NO_SHOT.has(a)) {
      await waitForTabLoad().catch(() => {});
      await waitForSettleInActivePage(800).catch(
        () => new Promise((r) => setTimeout(r, 250)),
      );
      const shot = await takeScreenshot().catch(() => null);
      if (shot) {
        return { ...shot, note: `${a} done — screenshot shows the result` };
      }
    }
    return result;
  },

  /**
   * Run several steps in one round trip. A step is either a computer action
   * ({action: "left_click", ...}) or a whitelisted DOM tool
   * ({tool: "find", input: {query: "..."}}) — so look→act sequences like
   * hover → read_page → click land in ONE round instead of three. Stops on
   * the first error; always finishes with a fresh screenshot. Tool steps'
   * results come back in step_results (clipped) so the model can use what
   * a read/find step saw.
   */
  async batch_actions({ actions }: { actions?: BatchStep[] }) {
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error("batch_actions requires actions: [{action: ...} | {tool: ..., input: {...}}, ...]");
    }
    if (actions.length > 20) throw new Error("batch_actions is limited to 20 steps");

    let completed = 0;
    let errorMsg: string | null = null;
    const stepResults: { step: number; ran: string; result?: string }[] = [];
    let resultBudget = 12_000; // total chars of tool-step output we pass back

    for (const step of actions) {
      const idx = completed + 1;
      // Screenshots mid-batch are pointless (the model can't see them until
      // the batch returns) — skip them; one is appended at the end anyway.
      if (step?.action === "screenshot") { completed++; continue; }
      try {
        if (step?.tool) {
          const name = String(step.tool);
          if (!BATCHABLE_TOOLS.has(name)) {
            throw new Error(
              `tool "${name}" cannot run inside a batch (allowed: ${[...BATCHABLE_TOOLS].join(", ")}) — call it on its own`,
            );
          }
          const handler = HANDLERS[name];
          const value = await handler(step.input ?? {});
          const clip = Math.min(3_000, Math.max(0, resultBudget));
          const text = JSON.stringify(value ?? null).slice(0, clip);
          resultBudget -= text.length;
          stepResults.push({ step: idx, ran: name, result: text });
        } else {
          await executeComputerAction(step ?? {});
          stepResults.push({ step: idx, ran: step?.action ?? "?" });
        }
        completed++;
        // If the step kicked off a navigation, let it finish before the next
        // step fires into a half-loaded page.
        await waitForTabLoad(6000).catch(() => {});
        // Anthropic best practice: give UIs ~300ms to react between steps.
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        errorMsg = `step ${idx} (${step?.tool ?? step?.action}) failed: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    // Let the page settle (DOM quiet or 1.2s cap) before the result shot.
    await waitForTabLoad().catch(() => {});
    await waitForSettleInActivePage(1200).catch(
      () => new Promise((r) => setTimeout(r, 350)),
    );
    const shot = await takeScreenshot().catch(() => null);
    return {
      ...(shot ?? {}),
      step_results: stepResults,
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
    const tab = await getTaskTab();
    if (tab.id === undefined) throw new Error("no task tab");
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

  async read_page({ filter, max_chars, ref_id, depth }: { filter?: string; max_chars?: number; ref_id?: string; depth?: number } = {}) {
    const snapshot = await readActivePage();
    const cap = Math.min(Math.max(max_chars ?? 50_000, 4_000), 200_000);
    const maxDepth = Math.min(Math.max(depth ?? 15, 1), 40);

    // Reference-format serialization: indented text lines, one element each —
    // `role "name" [ref] value="…"` — the shape the model reads natively, at
    // a fraction of the tokens of a JSON tree.
    const INTERACTIVE = new Set([
      "link", "button", "textbox", "combobox", "checkbox", "radio", "menuitem",
      "menuitemcheckbox", "menuitemradio", "tab", "option", "searchbox",
      "slider", "switch", "listbox", "submit", "select",
    ]);
    const esc = (v: unknown, max = 100) =>
      String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max).replace(/"/g, '\\"');
    const lines: string[] = [];
    const emit = (n: any, d: number) => {
      if (!n || lines.length >= 10_000 || d > maxDepth) return;
      const interactiveOnly = filter === "interactive";
      const shows = interactiveOnly
        ? n.visible && (INTERACTIVE.has(n.role) || n.value !== undefined)
        : true;
      if (shows) {
        let line = " ".repeat(interactiveOnly ? 0 : d) + (n.role || "generic");
        const nm = esc(n.name);
        if (nm) line += ` "${nm}"`;
        line += ` [${n.id}]`;
        if (n.value !== undefined && n.value !== "") line += ` value="${esc(n.value)}"`;
        lines.push(line);
        const txt = esc(n.text, 200);
        if (txt && !interactiveOnly) lines.push(" ".repeat(d + 1) + `text "${txt}"`);
      }
      for (const ch of n.children ?? []) emit(ch, shows && filter !== "interactive" ? d + 1 : d);
    };

    let root: any = snapshot.root;
    if (ref_id) {
      let found: any = null;
      const locate = (n: any) => {
        if (!n || found) return;
        if (n.id === ref_id) { found = n; return; }
        (n.children ?? []).forEach(locate);
      };
      locate(snapshot.root);
      if (!found) {
        throw new Error(
          `Element with ref '${ref_id}' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.`,
        );
      }
      root = found;
    }
    emit(root, 0);

    let pageContent = lines.join("\n");
    let note: string | undefined;
    if (pageContent.length > cap) {
      const cut = pageContent.lastIndexOf("\n", cap);
      const full = pageContent.length;
      pageContent = pageContent.slice(0, cut > 0 ? cut : cap);
      note = `truncated at a line boundary — full size ${full} chars. Pass a larger max_chars, or use depth/ref_id/filter:'interactive' to focus.`;
    }
    return {
      url: snapshot.url,
      title: snapshot.title,
      ...(note ? { note } : {}),
      page_content: pageContent,
    };
  },

  /**
   * Semantic element search — "font selector", "save button", "menu item
   * Lexend". Returns ranked matches with ids (for click/hover/type) and
   * measured centers. Far cheaper and more precise than a full read_page.
   */
  async find({ query, deep }: { query: string; deep?: boolean }) {
    requireString(query, "query");
    if (deep === true && authCtx) {
      return await deepFind(query);
    }
    const matches = await findInActivePage(query);

    // Also search cross-origin frames (Wix canvas, Word Online editor…).
    // Their hits can't be clicked by id — they come back as screenshot
    // coordinates for the computer tool / batch_actions instead.
    let frameMatches: unknown[] = [];
    try {
      const tab = await getTaskTab();
      if (tab.id !== undefined) {
        const hits = await crossFrameFind(tab.id, query);
        frameMatches = hits.slice(0, 6).map((h) => ({
          frame: h.frame,
          role: h.role,
          name: h.name,
          click_coordinate: [
            Math.round(h.cssX / coordScale),
            Math.round(h.cssY / coordScale),
          ],
        }));
      }
    } catch { /* frame search is best-effort */ }

    if (Array.isArray(matches) && matches.length > 0 && frameMatches.length > 0) {
      return {
        matches,
        frame_matches: frameMatches,
        note: "frame_matches are inside embedded frames — click those with the computer tool at click_coordinate (no element id).",
      };
    }
    if (frameMatches.length > 0 && (!Array.isArray(matches) || matches.length === 0)) {
      return {
        matches: [],
        frame_matches: frameMatches,
        note: "Found inside an embedded frame — click with the computer tool at click_coordinate (element ids don't work across frames).",
      };
    }
    if (Array.isArray(matches) && matches.length === 0) {
      // Word search missed — let the AI matcher try meaning before giving up.
      if (authCtx) {
        try {
          return await deepFind(query);
        } catch {
          // fall through to the plain empty result
        }
      }
      return {
        matches: [],
        note: "No visible element matched. Try different words, read_page for the full tree, or a screenshot if this is a canvas area.",
      };
    }
    return { matches, method: "lexical" };
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
  async read_console({ limit, pattern, onlyErrors, clear }: { limit?: number; pattern?: string; onlyErrors?: boolean; clear?: boolean } = {}) {
    const tab = await getTaskTab();
    if (tab.id === undefined) throw new Error("no task tab");
    let entries = consoleBuf.get(tab.id) ?? [];
    if (onlyErrors) entries = entries.filter((e) => e.level === "error");
    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        entries = entries.filter((e) => re.test(e.text));
      } catch {
        throw new Error(`invalid regex pattern: ${pattern}`);
      }
    }
    entries = entries.slice(-(limit ?? 40));
    if (clear) consoleBuf.set(tab.id, []);
    return entries.length
      ? { entries }
      : { entries: [], note: "No matching console output captured yet — it records while Eva is acting on the page. Interact first, then read again." };
  },

  /** Recent network requests captured while Eva works. */
  async read_network({ filter, limit, clear }: { filter?: string; limit?: number; clear?: boolean } = {}) {
    const tab = await getTaskTab();
    if (tab.id === undefined) throw new Error("no task tab");
    let entries = networkBuf.get(tab.id) ?? [];
    if (clear) networkBuf.set(tab.id, []);
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

  /**
   * Vista skrá af vefslóð beint í verkefnamöppu notandans á Eva-platforminum.
   * Beina leiðin: ekkert vafur, eitt API-kall.
   */
  async save_to_folder({ folder, url, filename }: { folder: string; url: string; filename?: string }) {
    requireString(folder, "folder");
    requireString(url, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
    if (!authCtx?.accessToken) {
      throw new Error("notandinn er ekki tengdur Eva-platforminum (skrá inn í stillingum)");
    }
    const headers = { Authorization: `Bearer ${authCtx.accessToken}` };

    // Finna möppuna: nákvæmt id, svo nafn (case-insensitive), svo hlutstrengur.
    const listRes = await fetch(`${PLATFORM.apiUrl}${PLATFORM.foldersPath}`, { headers });
    if (!listRes.ok) throw new Error(`náði ekki möppulistanum (HTTP ${listRes.status})`);
    const listBody = (await listRes.json()) as {
      data?: { folders?: { id: string; name: string }[] };
    };
    const folders = listBody.data?.folders ?? [];
    const q = folder.trim().toLowerCase();
    const match =
      folders.find((f) => f.id === folder) ??
      folders.find((f) => f.name.toLowerCase() === q) ??
      folders.find((f) => f.name.toLowerCase().includes(q));
    if (!match) {
      throw new Error(
        `fann enga möppu sem heitir "${folder}" — til: ${folders.slice(0, 8).map((f) => f.name).join(", ") || "engar möppur"}`,
      );
    }

    const upRes = await fetch(`${PLATFORM.apiUrl}${PLATFORM.folderUploadPath(match.id)}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...(filename ? { filename } : {}) }),
    });
    const upBody = (await upRes.json().catch(() => null)) as
      | { data?: { file?: { name?: string } }; error?: string }
      | null;
    if (!upRes.ok) {
      throw new Error(upBody?.error ?? `upphleðsla mistókst (HTTP ${upRes.status})`);
    }
    return {
      saved: true,
      folder: match.name,
      file: upBody?.data?.file?.name ?? filename ?? url.split("/").pop(),
    };
  },

  /**
   * Replace Eva's lasting memory about this user (business facts, sites,
   * preferences). Injected into every future run; user-editable in Settings.
   */
  async remember({ content }: { content: string }) {
    requireString(content, "content");
    if (!authCtx) throw new Error("memory unavailable (no auth context)");
    const res = await saveMemory(authCtx.settings, authCtx.accessToken, content);
    if (!res.ok) throw new Error(`could not save memory: ${res.error}`);
    return { saved: true, chars: content.length };
  },

  async get_active_tab() {
    const tab = await getTaskTab();
    return {
      url: tab.url ?? "(unknown)",
      title: tab.title ?? "(no title)",
      tabId: tab.id,
      ...(tab.active
        ? {}
        : { note: "your task tab (running in the background — the user is viewing another tab; keep working here)" }),
    };
  },

  async click({ element_id }: { element_id: string }) {
    requireString(element_id, "element_id");
    // Trusted click: measure the element's live center, then press a REAL
    // mouse there via CDP. Synthetic .click() fires no mousedown, which
    // mousedown-driven widgets (Google Docs toolbar, custom menus) ignore.
    try {
      const rect = await rectInActivePage(element_id);
      const tab = await getTaskTab();
      if (tab.id === undefined) throw new Error("no task tab");
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
    const tab = await getTaskTab();
    if (tab.id === undefined) throw new Error("no task tab");
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
    const tab = await getTaskTab();
    if (tab.id === undefined) throw new Error("task tab has no id");
    const tabId = tab.id;
    if (url === "back" || url === "forward") {
      if (url === "back") await chrome.tabs.goBack(tabId);
      else await chrome.tabs.goForward(tabId);
      await new Promise((r) => setTimeout(r, 800));
      const t = await chrome.tabs.get(tabId);
      return { url: t.url ?? "", title: t.title ?? "", history: url };
    }
    let target = url;
    if (!/^https?:\/\//i.test(target)) {
      // Reference behavior: protocol may be omitted — default to https.
      if (/^[\w-]+(\.[\w-]+)+/.test(target)) target = `https://${target}`;
      else throw new Error('url must be a web address (or "back"/"forward")');
    }
    return await navigateAndWait(tabId, target);
  },

  async form_input({
    element_id,
    value,
  }: {
    element_id: string;
    value: string | number | boolean;
  }) {
    requireString(element_id, "element_id");
    if (value === undefined || value === null) throw new Error("value is required");
    // Booleans (checkboxes) and numbers arrive per the reference schema.
    const v = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    return await formInputInActivePage(element_id, v);
  },

  async tabs_list() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const bound = boundTaskTabId();
    return tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      pinned: t.pinned,
      ...(t.id !== undefined && t.id === bound ? { your_task_tab: true } : {}),
    }));
  },

  async tabs_create({ url, background }: { url: string; background?: boolean }) {
    requireString(url, "url");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("url must start with http:// or https://");
    }
    // background:true opens the tab WITHOUT stealing the user's view — Eva's
    // binding moves there and she works via CDP capture, invisibly.
    const tab = await chrome.tabs.create({ url, active: background !== true });
    if (tab.id !== undefined) bindTaskTab(tab.id);
    return {
      id: tab.id,
      url: tab.url ?? url,
      ...(background === true ? { note: "opened in background — you're bound to it; the user's view is undisturbed" } : {}),
    };
  },

  async tabs_switch({ tab_id, background }: { tab_id: number; background?: boolean }) {
    if (typeof tab_id !== "number") throw new Error("tab_id must be a number");
    if (background === true) {
      // Just move the binding — don't yank the user's view around.
      const tab = await chrome.tabs.get(tab_id);
      bindTaskTab(tab_id);
      return { id: tab.id, url: tab.url, note: "binding moved without focusing the tab" };
    }
    const tab = await chrome.tabs.update(tab_id, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    bindTaskTab(tab_id);
    return { id: tab.id, url: tab.url };
  },

  async tabs_close({ tab_id }: { tab_id: number }) {
    if (typeof tab_id !== "number") throw new Error("tab_id must be a number");
    await chrome.tabs.remove(tab_id);
    // Closing the bound tab: next tool call rebinds to the active tab.
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
