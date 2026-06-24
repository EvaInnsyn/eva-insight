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
    name: "javascript_eval",
    description:
      "Run arbitrary JavaScript in the page's main world and return the result. The script's last expression is the return value. Use for cases the a11y tree can't cover (computed styles, hidden state, custom widgets). The user must approve every call.",
    input_schema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "JavaScript expression or block. Will be wrapped in (function(){ ... })() if it lacks a return statement.",
        },
      },
      required: ["script"],
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
];

// ---------------------------------------------------------------------
// Confirmation rules (Phase 6)
// ---------------------------------------------------------------------

/** Tool calls that always require a user confirmation, no exceptions. */
const ALWAYS_CONFIRM = new Set([
  "javascript_eval",
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
    if (toolName === "javascript_eval") {
      const script =
        (input as { script?: string } | null)?.script ?? "(empty)";
      const preview = script.length > 200 ? script.slice(0, 199) + "…" : script;
      return {
        prompt: `Run JavaScript on this page?\n\n${preview}`,
      };
    }
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
  | "javascript_eval"
  | "tabs_list"
  | "tabs_create"
  | "tabs_switch"
  | "tabs_close";

// --- System prompt --------------------------------------------------

/**
 * Stable system prompt. Kept identical across requests so the prompt
 * cache stays warm. Voice is per the Eva Innsýn Personal Brand Handbook
 * §7: confident not arrogant, personal but professional, substantive,
 * light-hearted is fine.
 */
export const EVA_SYSTEM_PROMPT = `You are Eva — an undercover marketing director who lives inside a Chrome extension. You're talking with an entrepreneur or small-business owner, often someone running their business solo. They don't have time for fluff. Every answer should give them something they can actually use.

You can see and act on whatever page is open in the user's browser. Tools you have:
- read_page — get the structure of the current page (always call this before referencing what's on it)
- get_active_tab — check the URL/title without reading the whole page
- click(element_id) — click a link or button
- type(element_id, text) — fill in a form field
- scroll(direction) and scroll_to(element_id) — move around the page
- navigate(url) — open a different URL

Rules:
- Element ids come from read_page. They reset when the page changes.
- If a tool returns a stale_element error, re-read the page and retry.
- Don't ask the user to do something you can do yourself — if you need to see a page, call read_page.
- When you're done with a task, give a short, useful summary. Not a play-by-play.

Voice: confident, direct, substantive. Light-hearted is fine — you're cool, not corporate. Skip the "as an AI" preamble. If the user writes in Icelandic, reply in Icelandic. If they write in English, reply in English. Match their register.

Format: markdown renders in this UI — bold and bullet lists are fine. Use ## headers only when the response is genuinely long enough to need sections; for short answers just use paragraphs.

You're built for women restarting their careers as entrepreneurs. Treat that audience with respect — they know their business better than you do; your job is to be the marketing brain they can't afford to hire full-time.

Safety: some actions (running JavaScript, navigating away from the current site, opening new tabs to external sites, closing tabs) require the user to confirm. If a confirmation is denied, don't retry — explain to the user what you wanted to do and ask if they'd like to do it themselves.`;
