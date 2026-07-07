/**
 * Action executors.
 *
 * Resolve a stable element id, scroll it into view, then dispatch the
 * appropriate events. For form controls we use the native value setter
 * pattern that's compatible with React and other framework controlled
 * inputs.
 */

import { getId, resolveId } from "./element-registry";

export class StaleElementError extends Error {
  constructor(id: string) {
    super(`element ${id} is stale — re-read the page and try again`);
    this.name = "StaleElementError";
  }
}

function mustResolve(id: string): Element {
  const el = resolveId(id);
  if (!el) throw new StaleElementError(id);
  return el;
}

export function click(id: string): { id: string; tag: string } {
  const el = mustResolve(id);
  scrollIntoViewSafe(el);
  if (el instanceof HTMLElement) {
    el.focus();
    el.click();
  } else {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
    );
  }
  return { id, tag: el.tagName.toLowerCase() };
}

export function typeText(
  id: string,
  text: string,
  replace = true,
): { id: string; tag: string; length: number } {
  const el = mustResolve(id);
  scrollIntoViewSafe(el);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    const next = replace ? text : (el.value ?? "") + text;
    // Use the native value setter so React-style controlled inputs see the
    // change. Without this, `el.value = ...` is a plain JS assignment that
    // React overwrites on re-render.
    const proto =
      el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, next);
    else (el as { value: string }).value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { id, tag: el.tagName.toLowerCase(), length: next.length };
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    if (replace) el.textContent = text;
    else el.textContent = (el.textContent ?? "") + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return { id, tag: el.tagName.toLowerCase(), length: el.textContent.length };
  }
  throw new Error(`element ${id} is not typeable (tag: ${el.tagName})`);
}

export function scroll(
  direction: "up" | "down",
  amount?: number,
): { x: number; y: number } {
  const step = amount ?? document.documentElement.clientHeight * 0.8;
  const dy = direction === "down" ? step : -step;
  window.scrollBy({ top: dy, behavior: "smooth" });
  return { x: window.scrollX, y: window.scrollY };
}

export function scrollTo(id: string): { x: number; y: number } {
  const el = mustResolve(id);
  scrollIntoViewSafe(el);
  return { x: window.scrollX, y: window.scrollY };
}

/**
 * Fresh viewport geometry for an element, scrolled into view first — used by
 * the background to aim a REAL (CDP) mouse click at the element's center,
 * which works on widgets that ignore synthetic .click() (Google Docs
 * toolbars, custom dropdowns, mousedown-driven menus).
 */
export function rectOf(id: string): {
  x: number; y: number; w: number; h: number; cx: number; cy: number;
} {
  const el = mustResolve(id);
  scrollIntoViewSafe(el);
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    throw new Error(`element ${id} has no layout (hidden?)`);
  }
  return {
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    cx: Math.round(r.left + r.width / 2),
    cy: Math.round(r.top + r.height / 2),
  };
}

/**
 * Set the value of a select/checkbox/radio. For text inputs, use
 * `typeText` instead.
 */
export function formInput(
  id: string,
  value: string,
): { id: string; tag: string; state: string } {
  const el = mustResolve(id);
  scrollIntoViewSafe(el);

  if (el instanceof HTMLSelectElement) {
    // Match by value first, then by visible text
    const byValue = Array.from(el.options).find((o) => o.value === value);
    const byText = Array.from(el.options).find(
      (o) => o.text.trim() === value.trim(),
    );
    const opt = byValue ?? byText;
    if (!opt) {
      throw new Error(
        `no option in select "${id}" matches value "${value}"`,
      );
    }
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { id, tag: "select", state: opt.value };
  }

  if (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  ) {
    el.focus();
    const v = value.trim().toLowerCase();
    let next: boolean;
    if (v === "check" || v === "true" || v === "on" || v === "checked") next = true;
    else if (v === "uncheck" || v === "false" || v === "off" || v === "unchecked") next = false;
    else if (v === "toggle") next = !el.checked;
    else throw new Error(`unrecognized value "${value}" for ${el.type}`);
    if (el.checked !== next) {
      el.checked = next;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { id, tag: el.type, state: el.checked ? "checked" : "unchecked" };
  }

  throw new Error(
    `form_input doesn't handle element type ${el.tagName} — use type() for text inputs`,
  );
}

/**
 * Wait until either `timeoutMs` elapses or the DOM stops mutating for
 * `quietMs` consecutive milliseconds. Useful as a coarse "page has
 * settled" check before re-reading.
 */
export function waitForSettle(
  timeoutMs = 5_000,
  quietMs = 400,
): Promise<{ settled: boolean; waitedMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let quietTimer: number | null = null;
    let resolved = false;

    const finish = (settled: boolean) => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      if (quietTimer != null) clearTimeout(quietTimer);
      clearTimeout(hardCap);
      resolve({ settled, waitedMs: Date.now() - start });
    };

    const scheduleQuiet = () => {
      if (quietTimer != null) clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => finish(true), quietMs);
    };

    const observer = new MutationObserver(() => scheduleQuiet());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    const hardCap = window.setTimeout(() => finish(false), timeoutMs);
    scheduleQuiet();
  });
}

function scrollIntoViewSafe(el: Element): void {
  try {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  } catch {
    // some elements throw on scrollIntoView — ignore
  }
}

/** Full readable text of the page (innerText), clipped. */
export function getPageText(): { title: string; url: string; text: string; truncated: boolean } {
  const raw = document.body?.innerText ?? "";
  const clean = raw.replace(/\n{3,}/g, "\n\n").trim();
  const LIMIT = 60_000;
  return {
    title: document.title,
    url: location.href,
    text: clean.slice(0, LIMIT),
    truncated: clean.length > LIMIT,
  };
}

/**
 * Put a file into an <input type="file"> via DataTransfer — how the page
 * receives an "upload" without a real file picker. Fires change/input so
 * frameworks react.
 */
export function setFileOnInput(
  id: string,
  name: string,
  mime: string,
  base64: string,
): { id: string; name: string; size: number } {
  const el = mustResolve(id);
  if (!(el instanceof HTMLInputElement) || el.type !== "file") {
    throw new Error(`element ${id} is not a file input`);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], name, { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { id, name, size: file.size };
}

/** Locate a file input anywhere on the page (they're usually hidden). */
export function findFileInput(): { id: string; visible: boolean } | null {
  const collect = (doc: Document, out: HTMLInputElement[]) => {
    out.push(...Array.from(doc.querySelectorAll('input[type="file"]')) as HTMLInputElement[]);
    for (const f of Array.from(doc.querySelectorAll("iframe"))) {
      try {
        const inner = (f as HTMLIFrameElement).contentDocument;
        if (inner) collect(inner, out);
      } catch { /* cross-origin */ }
    }
  };
  const inputs: HTMLInputElement[] = [];
  collect(document, inputs);
  if (inputs.length === 0) return null;
  // Prefer the most recently added (sites inject one when Upload is clicked).
  const el = inputs[inputs.length - 1];
  const r = el.getBoundingClientRect();
  return { id: getId(el), visible: r.width > 1 && r.height > 1 };
}
