/**
 * Shared types for page-reading and page-acting.
 *
 * Same wire format used by the content script (producer) and the
 * background worker (consumer + forwarder to the LLM tool layer in Phase 4).
 */

/** One node in the serialized accessibility-flavored tree. */
export interface PageNode {
  /** Stable id assigned by the content script's element registry. */
  id: string;
  /** ARIA role, or implicit role from tag name. */
  role: string;
  /** Accessible name (aria-label / labelledby / label / text). */
  name?: string;
  /** Current value for inputs / selects / textareas. */
  value?: string;
  /** Bounding box in viewport coordinates (only included when visible). */
  bbox?: { x: number; y: number; w: number; h: number };
  /** True if the node is currently visible in the layout. */
  visible: boolean;
  /** Free-text content that isn't otherwise captured by name (e.g. paragraphs). */
  text?: string;
  /** Subtree. */
  children?: PageNode[];
}

/** Top-level snapshot returned by the content script. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Viewport width / height in CSS pixels. */
  viewport: { w: number; h: number };
  /** Current page scroll position. */
  scroll: { x: number; y: number };
  /** Root of the a11y tree (body by default). */
  root: PageNode;
  /** Captured at this ISO timestamp. */
  capturedAt: string;
  /** Count of distinct elements assigned IDs in this capture. */
  elementCount: number;
}

// --- Messages: side panel/background → content script ----------------

export type PageRequest =
  | { type: "page/read" }
  | { type: "page/click"; elementId: string }
  | { type: "page/type"; elementId: string; text: string; replace?: boolean }
  | { type: "page/scroll"; direction: "up" | "down"; amount?: number }
  | { type: "page/scrollTo"; elementId: string }
  | { type: "page/formInput"; elementId: string; value: string }
  | { type: "page/rect"; elementId: string }
  | { type: "page/find"; query: string }
  | { type: "page/waitFor"; timeoutMs?: number };

/** Fresh viewport-CSS-px geometry of an element (after scroll-into-view). */
export interface ElementRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center point — where a real mouse click should land. */
  cx: number;
  cy: number;
}

export type PageResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { type: string; message: string } };

/** Helper for the message handler to construct an error response. */
export function pageError(type: string, message: string): PageResponse {
  return { ok: false, error: { type, message } };
}
