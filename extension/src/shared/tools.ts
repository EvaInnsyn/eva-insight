/**
 * Tool schemas — what Claude can call mid-conversation.
 *
 * Definitions are JSON Schema compatible (Anthropic Messages API format).
 * Keep this list small and stable for prompt cache hits: every change to
 * the tools array invalidates the cache.
 *
 * Phase 4 ships the page-interaction tools. Phase 5 will add advanced
 * tools (console, network, JS eval, multi-tab).
 */

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const EVA_TOOLS: ToolSchema[] = [
  {
    name: "read_page",
    description:
      "Read the currently active browser tab and return a structured tree of its content (headings, links, buttons, form fields, paragraphs). Always call this BEFORE referencing anything on the page. Each interactive element gets a short `id` (e.g. `e42`) that you use with click/type/scroll. Ids reset whenever the page navigates.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_active_tab",
    description:
      "Get the URL and title of the currently active browser tab. Use this when you only need to know what page the user is on, without reading the full content.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "click",
    description:
      "Click an element on the active page by its id. Use ids returned by `read_page`. If the page changed since the last read, this will return a stale_element error — re-read the page and try again.",
    input_schema: {
      type: "object",
      properties: {
        element_id: {
          type: "string",
          description: "Stable id from a recent read_page (e.g. `e23`).",
        },
      },
      required: ["element_id"],
    },
  },
  {
    name: "type",
    description:
      "Type text into a form field (input, textarea, or contenteditable). Replaces existing content unless `append` is true. Use ids returned by `read_page`.",
    input_schema: {
      type: "object",
      properties: {
        element_id: {
          type: "string",
          description: "Stable id of the form field.",
        },
        text: {
          type: "string",
          description: "The text to type.",
        },
        append: {
          type: "boolean",
          description: "If true, append to existing content instead of replacing it. Default: false.",
        },
      },
      required: ["element_id", "text"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the active page up or down by roughly one viewport (the default), or by a specific pixel amount.",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Direction to scroll.",
        },
        amount_px: {
          type: "number",
          description: "Optional explicit pixel amount.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "scroll_to",
    description:
      "Scroll a specific element into view (center of viewport). Useful before interacting with something far down the page.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
      },
      required: ["element_id"],
    },
  },
  {
    name: "navigate",
    description:
      "Navigate the active tab to a different URL. Use this when the user asks you to open a specific site or follow a link by URL rather than clicking. The page will load fresh — call `read_page` afterwards to see what's on the new page.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL including protocol, e.g. https://example.com/foo.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of the visible part of the active tab. Returns a base64-encoded PNG. Use sparingly — these are expensive to send. Prefer read_page for textual content.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "form_input",
    description:
      "Set the value of a form control that isn't a plain text input — select dropdowns, checkboxes, radio buttons. For text inputs and textareas, use `type` instead.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string", description: "Stable id of the control." },
        value: {
          type: "string",
          description:
            "For select: the option value or visible text to select. For checkbox/radio: 'check', 'uncheck', or 'toggle'.",
        },
      },
      required: ["element_id", "value"],
    },
  },
  {
    name: "tabs_list",
    description:
      "List the user's open tabs in the current window. Returns id, url, title, and active flag for each tab.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "tabs_create",
    description:
      "Open a new browser tab pointed at the given URL. The new tab becomes active.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL with protocol." },
      },
      required: ["url"],
    },
  },
  {
    name: "tabs_switch",
    description: "Switch focus to the given tab id (as returned by tabs_list).",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "number" },
      },
      required: ["tab_id"],
    },
  },
  {
    name: "tabs_close",
    description:
      "Close the given tab id. Requires user confirmation because the user may have unsaved work in that tab.",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "number" },
      },
      required: ["tab_id"],
    },
  },
  {
    name: "click_at_coordinate",
    description:
      "Click at specific pixel coordinates (x, y) on the active tab — measured from the top-left corner of the visible viewport, matching a screenshot. Use this for complex web apps (Wix, Notion, Google Docs, Squarespace, etc.) where DOM element IDs from read_page are unavailable or unreliable, such as canvas-based editors or iframe-embedded content. Workflow: 1) take a screenshot, 2) identify where to click, 3) call this tool with those coordinates. After clicking, wait briefly then take another screenshot to see what changed.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal pixel coordinate from the screenshot." },
        y: { type: "number", description: "Vertical pixel coordinate from the screenshot." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "double_click_at_coordinate",
    description:
      "Double-click at specific pixel coordinates. Use when a single click selects an element but a double-click is needed to enter edit mode (common in Wix, Squarespace, and document editors).",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal pixel coordinate from the screenshot." },
        y: { type: "number", description: "Vertical pixel coordinate from the screenshot." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_at_cursor",
    description:
      "Insert text at the current cursor position — use this after click_at_coordinate or double_click_at_coordinate has focused a text field. Does not need a DOM element id; works inside iframes and complex editors.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to insert." },
      },
      required: ["text"],
    },
  },
  {
    name: "key_press",
    description:
      "Press a keyboard key or key combination on the active tab. Useful after clicking into a field or menu. Examples: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp. For shortcuts combine with modifiers e.g. key='a', modifiers=['ctrl'] for Select All.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, or a single character." },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["ctrl", "shift", "alt", "meta"] },
          description: "Modifier keys to hold. E.g. ['ctrl'] for Ctrl+key.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "wait",
    description:
      "Wait for a given number of milliseconds before continuing. Use after a click or navigation when the page needs time to update before the next action. Default is 800ms.",
    input_schema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds to wait (100–5000). Default: 800." },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------
// Confirmation rules (Phase 6)
// ---------------------------------------------------------------------

/** Tool calls that always require a user confirmation, no exceptions. */
const ALWAYS_CONFIRM = new Set([
  "tabs_close",
]);

/**
 * Decide whether a tool call needs a user confirmation. Returns the
 * prompt to show, or null if the call may proceed silently.
 *
 * `allowedDomains` is the user's settings allowlist (origin strings like
 * "https://wikipedia.org"). A navigate to an allowed origin proceeds
 * without prompting.
 */
export function needsConfirmation(
  toolName: string,
  input: unknown,
  context: { activeOrigin?: string; allowedDomains: string[] },
): { prompt: string; allowAlways?: { kind: "domain"; origin: string } } | null {
  if (ALWAYS_CONFIRM.has(toolName)) {
    if (toolName === "tabs_close") {
      return { prompt: "Close this browser tab?" };
    }
  }
  if (toolName === "navigate" || toolName === "tabs_create") {
    const url = (input as { url?: string } | null)?.url ?? "";
    let origin: string | undefined;
    try {
      origin = new URL(url).origin;
    } catch {
      return { prompt: `Navigate to "${url}"?` };
    }
    if (origin && context.allowedDomains.includes(origin)) return null;
    if (origin && context.activeOrigin === origin) return null;
    return {
      prompt:
        toolName === "navigate"
          ? `Navigate to ${origin}?`
          : `Open a new tab at ${origin}?`,
      allowAlways: origin ? { kind: "domain", origin } : undefined,
    };
  }
  return null;
}

export type EvaToolName2 = string;

// Tool names mirrored for the dispatcher
export type EvaToolName =
  | "read_page"
  | "get_active_tab"
  | "click"
  | "type"
  | "scroll"
  | "scroll_to"
  | "navigate"
  | "screenshot"
  | "form_input"
  | "tabs_list"
  | "tabs_create"
  | "tabs_switch"
  | "tabs_close"
  | "click_at_coordinate"
  | "double_click_at_coordinate"
  | "type_at_cursor"
  | "key_press"
  | "wait";

// --- System prompt --------------------------------------------------

/**
 * Stable system prompt. Kept identical across requests so the prompt
 * cache stays warm. Voice is per the Eva Innsýn Personal Brand Handbook
 * §7: confident not arrogant, personal but professional, substantive,
 * light-hearted is fine.
 */
export const EVA_SYSTEM_PROMPT = `You are Eva — a digital employee who lives inside a Chrome extension. You switch roles on demand: accountant, marketer, HR manager, programmer, data analyst, copywriter, website builder — whatever the task needs. You're talking with an entrepreneur or business owner, often running things solo. They don't have time to explain themselves twice. Just do the work.

You can see and act on whatever page is open in the user's browser.

## Two ways to interact with a page

**DOM mode** (fast, for normal websites):
- read_page — get the structure of the current page; each element gets an id like e42
- click(element_id) — click a link or button by its id
- type(element_id, text) — fill in a form field by its id
- scroll(direction) / scroll_to(element_id) — move around the page
- form_input(element_id, value) — set selects, checkboxes, radios

**Coordinate mode** (for complex editors — Wix, Squarespace, Notion, Google Docs, canvas apps):
- screenshot — take a screenshot; coordinates in the image map directly to click_at_coordinate
- click_at_coordinate(x, y) — click at exact pixel position from the screenshot
- key_press(key, modifiers?) — press Enter, Tab, Escape, arrow keys, or Ctrl/Cmd shortcuts
- wait(ms?) — pause briefly after a click so the UI can update

**When to use coordinate mode:** any time the page is a visual editor, uses iframes for the main content area, or read_page returns elements you can't meaningfully click. Wix editor, Squarespace, webflow, Google Docs — always use coordinate mode. The workflow is: screenshot → identify where to click → click_at_coordinate → wait → screenshot again to see the result. Repeat until done.

**Other tools:**
- get_active_tab — check URL/title without reading the full page
- navigate(url) — open a different URL
- tabs_list / tabs_create / tabs_switch / tabs_close — manage browser tabs

## Rules
- Never ask the user to do something you can do yourself.
- If read_page returns stale_element on a click, re-read and retry.
- In coordinate mode: always take a screenshot first, then act on what you see. Take another screenshot after each action to verify the result before the next step.
- When you finish a task, give a short summary. Not a play-by-play.

## Voice
Confident, direct, substantive. Light-hearted is fine — you're cool, not corporate. Skip the "as an AI" preamble. If the user writes in Icelandic, reply in Icelandic. If they write in English, reply in English. Match their register. Markdown renders in this UI — use it when it helps.

## Safety
Navigating to an external site or opening a new tab asks the user first. Closing a tab always asks. If a confirmation is denied, explain what you wanted to do.`;
