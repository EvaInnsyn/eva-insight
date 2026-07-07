/**
 * Semantic element search — "find the font selector" → ranked, clickable
 * matches with measured centers. This replaces both pixel-guessing and
 * wading through the full read_page tree for most interactions.
 */

import { getId } from "./element-registry";

export interface FindMatch {
  id: string;
  role: string;
  name: string;
  value?: string;
  /** Viewport CSS px — center point and size. */
  cx: number;
  cy: number;
  w: number;
  h: number;
}

const CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[role]",
  "[contenteditable]",
  "[tabindex]",
  "[onclick]",
  "[aria-label]",
].join(",");

/** Words in a query that hint at a role, granting a bonus to matching roles. */
const ROLE_HINTS: Record<string, string[]> = {
  button: ["button"],
  link: ["a", "link"],
  field: ["input", "textarea", "textbox", "combobox", "searchbox"],
  input: ["input", "textarea", "textbox", "combobox", "searchbox"],
  box: ["input", "textbox", "combobox", "checkbox", "listbox"],
  dropdown: ["combobox", "listbox", "select", "menu"],
  select: ["select", "combobox", "listbox"],
  menu: ["menu", "menuitem", "menubar"],
  item: ["menuitem", "option", "listitem", "treeitem"],
  option: ["option", "menuitem"],
  tab: ["tab"],
  checkbox: ["checkbox", "switch"],
  search: ["searchbox", "input"],
  slider: ["slider"],
  heading: ["h1", "h2", "h3", "heading"],
};

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder?.trim()) return el.placeholder.trim();
    if (el instanceof HTMLInputElement && el.value && el.type === "button") return el.value;
  }

  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();

  const alt = el.getAttribute("alt");
  if (alt?.trim()) return alt.trim();

  const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return text.trim().replace(/\s+/g, " ").slice(0, 120);
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    if (t === "checkbox" || t === "radio" || t === "button" || t === "submit") return t;
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  return tag;
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

function collectCandidates(doc: Document, out: Element[]): void {
  out.push(...Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR)));
  // Same-origin iframes — cross-origin ones throw and are skipped.
  for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
    try {
      const inner = (frame as HTMLIFrameElement).contentDocument;
      if (inner) collectCandidates(inner, out);
    } catch {
      // cross-origin
    }
  }
}

/**
 * Rank visible interactive elements against a natural-language query.
 * Scoring: phrase > all-tokens > per-token, with a role bonus when the query
 * names a widget kind ("button", "dropdown", "menu item" …).
 */
/** Accent-insensitive lowercase ("Letur" matches "letur", "é" matches "e"). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00f0/g, "d") // ð
    .replace(/\u00fe/g, "th"); // þ
}

export function findElements(query: string): FindMatch[] {
  const q = norm(query.trim());
  if (!q) throw new Error("find requires a non-empty query");
  const tokens = q.split(/\s+/).filter((t) => t.length > 1);

  const roleBonuses = new Set<string>();
  for (const [hint, roles] of Object.entries(ROLE_HINTS)) {
    if (q.includes(hint)) roles.forEach((r) => roleBonuses.add(r));
  }

  const candidates: Element[] = [];
  collectCandidates(document, candidates);

  const seen = new Set<Element>();
  const scored: { score: number; el: Element; name: string; role: string }[] = [];

  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;

    const name = accessibleName(el);
    const role = roleOf(el);
    if (!name && !roleBonuses.has(role)) continue;

    const hay = norm(`${name} ${role}`);
    const hayWords = hay.split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    if (norm(name) === q) score += 6;
    else if (hay.includes(q)) score += 4;
    let present = 0;
    for (const t of tokens) {
      if (hay.includes(t)) { score += 1; present++; }
      else if (hayWords.some((w) => w.startsWith(t) || t.startsWith(w))) { score += 0.5; present++; }
    }
    if (tokens.length > 1 && present === tokens.length) score += 2;
    if (roleBonuses.has(role)) score += 2;
    if (score <= 0) continue;

    scored.push({ score, el, name, role });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 10).map(({ el, name, role }) => {
    const r = el.getBoundingClientRect();
    return {
      id: getId(el),
      role,
      name: name.slice(0, 80),
      ...(el instanceof HTMLInputElement || el instanceof HTMLSelectElement
        ? { value: String(el.value).slice(0, 40) }
        : {}),
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}
