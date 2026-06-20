/**
 * DOM → JSON accessibility-flavored tree.
 *
 * Goal: give Claude a compact, readable representation of what's on the
 * page that's useful for both reading content and selecting elements to
 * act on. We bias toward interactive + textual content and prune purely
 * presentational subtrees.
 *
 * This is a pragmatic accname implementation (a full WAI-ARIA accname
 * algorithm is large and not worth the cost for a side-panel tool — we
 * cover the cases the model needs day to day).
 */

import { getId, registrySize } from "./element-registry";
import type { PageNode, PageSnapshot } from "@/shared/page";

// Tags we never want in the tree (no UX or semantic value to the model).
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "META",
  "LINK",
  "HEAD",
  "BR",
]);

// Tags that are always "interactive enough" to keep even when unnamed.
const INTERACTIVE_TAGS = new Set([
  "BUTTON",
  "A",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "LABEL",
  "DETAILS",
  "SUMMARY",
  "OPTION",
]);

// Cap text content to keep the tree compact. The model rarely needs whole
// paragraphs verbatim — and if it does, it can ask the page for them again.
const MAX_TEXT_LEN = 300;

export function buildSnapshot(): PageSnapshot {
  const root: Element = document.body ?? document.documentElement;
  const tree = walkElement(root) ?? {
    id: getId(root),
    role: "document",
    visible: true,
  };
  return {
    url: location.href,
    title: document.title,
    viewport: {
      w: document.documentElement.clientWidth,
      h: document.documentElement.clientHeight,
    },
    scroll: { x: window.scrollX, y: window.scrollY },
    root: tree,
    capturedAt: new Date().toISOString(),
    elementCount: registrySize(),
  };
}

function walkElement(el: Element): PageNode | null {
  if (SKIP_TAGS.has(el.tagName)) return null;

  // Cheap rectangle + visibility check. We allow elements that are
  // technically off-screen — Claude may want to scroll to them. We only
  // skip elements that are display:none / visibility:hidden / 0-area.
  const cs = getComputedStyle(el);
  if (cs.display === "none") return null;
  if (cs.visibility === "hidden") return null;
  if (cs.opacity === "0" && !INTERACTIVE_TAGS.has(el.tagName)) return null;

  const rect = el.getBoundingClientRect();
  const hasArea = rect.width > 0 && rect.height > 0;

  // Recurse into children (and same-origin iframes, and open shadow DOM).
  const children = collectChildren(el);

  // Decide whether to include this node.
  const role = inferRole(el);
  const name = computeAccessibleName(el);
  const value = readValue(el);
  const text = collectOwnText(el);
  const isInteractive = INTERACTIVE_TAGS.has(el.tagName) || el.hasAttribute("role") ||
    role === "button" || role === "link" || role === "textbox" || role === "combobox";

  const hasSemantics =
    isInteractive ||
    name !== undefined ||
    role !== "generic" ||
    text !== undefined ||
    value !== undefined;

  if (!hasSemantics && children.length === 0) {
    return null;
  }

  // If this node has nothing of its own to say but children do, fold it: we
  // return a generic container so the tree shape is preserved without noise.
  const node: PageNode = {
    id: getId(el),
    role,
    visible: hasArea,
  };
  if (name) node.name = name;
  if (value !== undefined) node.value = value;
  if (text && !name) node.text = text;
  if (hasArea) {
    node.bbox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }
  if (children.length > 0) node.children = children;

  return node;
}

function collectChildren(el: Element): PageNode[] {
  const out: PageNode[] = [];

  // Open shadow root, if any
  if (el.shadowRoot) {
    for (const child of Array.from(el.shadowRoot.children)) {
      const node = walkElement(child);
      if (node) out.push(node);
    }
  }

  // Same-origin iframe — descend into its contentDocument body
  if (el.tagName === "IFRAME") {
    try {
      const doc = (el as HTMLIFrameElement).contentDocument;
      if (doc && doc.body) {
        const node = walkElement(doc.body);
        if (node) out.push(node);
      }
    } catch {
      // Cross-origin — record nothing, keep iframe leaf
    }
  }

  for (const child of Array.from(el.children)) {
    const node = walkElement(child);
    if (node) out.push(node);
  }
  return out;
}

/** Pull text content that belongs directly to `el` (not its descendants). */
function collectOwnText(el: Element): string | undefined {
  // Quick exit: if the only children are elements, no own-text.
  let buf = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      buf += child.textContent ?? "";
    }
  }
  buf = buf.replace(/\s+/g, " ").trim();
  if (!buf) return undefined;
  if (buf.length > MAX_TEXT_LEN) buf = buf.slice(0, MAX_TEXT_LEN - 1) + "…";
  return buf;
}

/** Pragmatic accessible-name computation. */
function computeAccessibleName(el: Element): string | undefined {
  // 1. aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const ref = id && document.getElementById(id);
      if (ref) parts.push(textContentOneLine(ref));
    }
    const joined = parts.join(" ").trim();
    if (joined) return clip(joined);
  }
  // 2. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return clip(ariaLabel.trim());

  const tag = el.tagName;

  // 3. Form controls: associated <label>
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (label) return clip(textContentOneLine(label));
    }
    const enclosing = el.closest("label");
    if (enclosing) return clip(textContentOneLine(enclosing));
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return clip(placeholder);
  }

  // 4. Images & inputs[type=image]: alt
  if (tag === "IMG" || tag === "AREA" || (tag === "INPUT" && el.getAttribute("type") === "image")) {
    const alt = el.getAttribute("alt");
    if (alt) return clip(alt);
  }

  // 5. Button / link / heading / similar: visible text
  if (
    tag === "BUTTON" ||
    tag === "A" ||
    tag === "SUMMARY" ||
    tag === "OPTION" ||
    /^H[1-6]$/.test(tag)
  ) {
    const t = textContentOneLine(el);
    if (t) return clip(t);
  }

  // 6. title attribute (last resort)
  const title = el.getAttribute("title");
  if (title) return clip(title);

  return undefined;
}

function textContentOneLine(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
  return s.length > 160 ? s.slice(0, 159) + "…" : s;
}

function cssEscape(s: string): string {
  // CSS.escape isn't always available in older content-script contexts but
  // it is in any browser we care about. Fallback to a basic escape.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/(["\\\]])/g, "\\$1");
}

/** Current value for form controls. */
function readValue(el: Element): string | undefined {
  const tag = el.tagName;
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    const t = (input.type || "text").toLowerCase();
    if (t === "checkbox" || t === "radio") {
      return input.checked ? "checked" : "unchecked";
    }
    if (t === "password") return input.value ? "•".repeat(input.value.length) : "";
    return input.value ?? "";
  }
  if (tag === "TEXTAREA") return (el as HTMLTextAreaElement).value ?? "";
  if (tag === "SELECT") {
    const sel = el as HTMLSelectElement;
    return sel.value ?? "";
  }
  if (tag === "OPTION") {
    return (el as HTMLOptionElement).selected ? "selected" : undefined;
  }
  return undefined;
}

/** Compute the implicit ARIA role for common tags. */
function inferRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName;
  switch (tag) {
    case "A": return el.hasAttribute("href") ? "link" : "generic";
    case "BUTTON": return "button";
    case "INPUT": {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      switch (t) {
        case "button":
        case "submit":
        case "reset":
        case "image":
          return "button";
        case "checkbox": return "checkbox";
        case "radio": return "radio";
        case "range": return "slider";
        case "search":
        case "email":
        case "tel":
        case "url":
        case "text":
        case "password":
          return "textbox";
        default: return "textbox";
      }
    }
    case "TEXTAREA": return "textbox";
    case "SELECT": return "combobox";
    case "OPTION": return "option";
    case "LABEL": return "label";
    case "DETAILS": return "group";
    case "SUMMARY": return "button";
    case "IMG": return "img";
    case "NAV": return "navigation";
    case "MAIN": return "main";
    case "HEADER": return "banner";
    case "FOOTER": return "contentinfo";
    case "ARTICLE": return "article";
    case "SECTION": return "region";
    case "ASIDE": return "complementary";
    case "FORM": return "form";
    case "DIALOG": return "dialog";
    case "TABLE": return "table";
    case "THEAD": case "TBODY": case "TFOOT": return "rowgroup";
    case "TR": return "row";
    case "TD": return "cell";
    case "TH": return "columnheader";
    case "UL": case "OL": return "list";
    case "LI": return "listitem";
    case "H1": case "H2": case "H3":
    case "H4": case "H5": case "H6": return "heading";
    case "IFRAME": return "frame";
    case "P": return "paragraph";
    default: return "generic";
  }
}
