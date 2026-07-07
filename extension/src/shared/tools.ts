/**
 * Tool schemas — what Claude can call mid-conversation.
 *
 * The centrepiece is Anthropic's OFFICIAL computer-use tool
 * (type computer_20251124): the exact interface Claude is trained on for
 * screenshot→act browser driving. Requires the "computer-use-2025-11-24"
 * beta flag, which the proxy forwards as an anthropic-beta header.
 *
 * Around it: `batch_actions` (several computer actions in one round trip —
 * the speed multiplier) and a DOM fast path (read_page / click / type by
 * element id) that beats pixels on ordinary pages.
 */

/** Custom (JSON-schema) tool definition. */
export interface CustomToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Anthropic-defined tool (server knows the schema from `type`). */
export interface AnthropicToolSchema {
  type: string;
  name: string;
  [key: string]: unknown;
}

export type ToolSchema = CustomToolSchema | AnthropicToolSchema;

/** Beta flags the proxy must forward for these tools to work. */
export const EVA_TOOL_BETAS = ["computer-use-2025-11-24"];

const CUSTOM_TOOLS: CustomToolSchema[] = [
  {
    name: "batch_actions",
    description:
      "Execute several computer actions in ONE call — much faster and cheaper than one action per turn. Each item has the same shape as a `computer` tool input (e.g. {action: 'left_click', coordinate: [x,y]}, {action: 'type', text: '...'}, {action: 'key', text: 'Return'}, {action: 'wait', duration: 1}). Use whenever the next several steps are predictable from the current screenshot: click a field → type → press Enter, or a sequence of menu clicks with waits. Runs in order, stops on the first error, and ALWAYS returns a fresh screenshot of the result — do not add a screenshot step yourself. Max 20 steps.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description:
            "Ordered computer-action inputs, executed sequentially. Same fields as the computer tool: action, coordinate, start_coordinate, text, scroll_direction, scroll_amount, duration.",
          items: { type: "object" },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "find",
    description:
      "Find elements by natural language — 'font selector', 'save button', 'menu item Lexend', 'email field'. Returns up to 10 ranked matches with element ids (use with click/hover/type) plus their measured on-screen centers and sizes. START HERE for any interaction with a control: it is faster, cheaper and more precise than reading the whole page or estimating pixels from a screenshot. Only visible elements match.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you're looking for, in a few words. Include the widget kind when known (button, field, dropdown, menu item).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Read the currently active browser tab as a structured tree (headings, links, buttons, form fields, paragraphs). The FAST PATH on ordinary websites — prefer it over screenshots when the page has real DOM content. Each interactive element gets a short id (e.g. `e42`) usable with click/type. Ids reset when the page navigates. On canvas-based editors (Word Online, Google Docs, design tools) this sees little — use the computer tool there.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_active_tab",
    description:
      "Get the URL and title of the active tab without reading its content.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "click",
    description:
      "Click an element by id from read_page — measures the element's live position and presses a REAL mouse at its exact center. More precise than estimating coordinates from a screenshot, and it works on toolbars, dropdown buttons and menus (Google Docs, Wix, custom widgets). PREFER this over computer-tool clicks whenever the target appears in read_page. If it returns stale_element, re-read the page and retry.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string", description: "Id from a recent read_page (e.g. `e23`)." },
      },
      required: ["element_id"],
    },
  },
  {
    name: "type",
    description:
      "Type into a form field by element id from read_page (input, textarea, contenteditable). Replaces content unless append is true.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        text: { type: "string" },
        append: { type: "boolean", description: "Append instead of replace. Default: false." },
      },
      required: ["element_id", "text"],
    },
  },
  {
    name: "form_input",
    description:
      "Set a select dropdown, checkbox, or radio by element id. For text fields use `type`.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        value: {
          type: "string",
          description: "Select: option value or visible text. Checkbox/radio: 'check' | 'uncheck' | 'toggle'.",
        },
      },
      required: ["element_id", "value"],
    },
  },
  {
    name: "hover",
    description:
      "Rest the REAL mouse on an element's measured center WITHOUT clicking, then wait 600ms. Use for hover-driven UI: menu items with a ▸ submenu arrow, tooltips, reveal-on-hover controls. Typical flow: hover the parent item by id → read_page (the submenu is now in the DOM) → click the submenu entry by id.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string", description: "Id from a recent read_page." },
      },
      required: ["element_id"],
    },
  },
  {
    name: "scroll_to",
    description: "Scroll a read_page element into view (center of viewport).",
    input_schema: {
      type: "object",
      properties: { element_id: { type: "string" } },
      required: ["element_id"],
    },
  },
  {
    name: "navigate",
    description:
      "Navigate the active tab to a URL. Waits for the page to load — take a screenshot or read_page afterwards.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL incl. protocol." },
      },
      required: ["url"],
    },
  },
  {
    name: "javascript_eval",
    description:
      "LAST RESORT: run JavaScript in the page and get the last expression's value back. Use only when find/click/computer genuinely cannot do the job (reading hidden state, triggering an app's own API). The user must approve every run. Some sites block script injection.",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript to evaluate in the page." },
      },
      required: ["script"],
    },
  },
  {
    name: "tabs_list",
    description: "List open tabs in the current window (id, url, title, active).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tabs_create",
    description: "Open a new tab at the given URL. The new tab becomes active.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "tabs_switch",
    description: "Switch to the given tab id (from tabs_list).",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "number" } },
      required: ["tab_id"],
    },
  },
  {
    name: "tabs_close",
    description:
      "Close the given tab id. Requires user confirmation (they may have unsaved work).",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "number" } },
      required: ["tab_id"],
    },
  },
];

/**
 * Build the tools array for one agent run. display dims must match the size
 * screenshots are actually sent at (the agent loop computes this from the
 * live viewport via computeShotDims) so the model's coordinates line up.
 */
export function buildEvaTools(display: { width: number; height: number }): ToolSchema[] {
  const computer: AnthropicToolSchema = {
    type: "computer_20251124",
    name: "computer",
    display_width_px: display.width,
    display_height_px: display.height,
    enable_zoom: true,
  };
  return [computer, ...CUSTOM_TOOLS];
}

// ---------------------------------------------------------------------
// Confirmation rules
// ---------------------------------------------------------------------

/** Tool calls that always require a user confirmation, no exceptions. */
const ALWAYS_CONFIRM = new Set(["tabs_close", "javascript_eval"]);

/**
 * Decide whether a tool call needs a user confirmation. Returns the
 * prompt to show, or null if the call may proceed silently.
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
    if (toolName === "javascript_eval") {
      return { prompt: "Run a script on this page? (Eva wants to use JavaScript for a step her normal tools can't reach.)" };
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

// --- System prompt --------------------------------------------------

/**
 * Stable system prompt. Kept identical across requests so the prompt
 * cache stays warm. Voice per the Eva Innsýn brand handbook §7.
 */
export const EVA_SYSTEM_PROMPT = `You are Eva — a digital employee who lives inside a Chrome extension. You switch roles on demand: accountant, marketer, HR manager, programmer, data analyst, copywriter, website builder — whatever the task needs. You're talking with an entrepreneur or business owner, often running things solo. They don't have time to explain themselves twice. Just do the work.

## Your workspace
You control ONE browser tab — the user's active tab. The computer tool sees and acts on that tab's viewport only (not the whole desktop, no other apps, no browser UI). Coordinates come from your latest screenshot.

## How to work — speed matters
- **find first.** When you need a specific control ("the font selector", "the save button"), call find — it returns exact elements with ids you can click/hover/type in one step. Only fall back to read_page (whole tree) or screenshots when find comes up empty.
- **batch_actions is your default for acting.** One call = several steps (click field → type → press Enter; or menu click → wait → next click). It always returns a fresh screenshot. Single computer actions are for when you genuinely need to see the result before deciding the next step.
- **Ordinary websites: use the DOM fast path.** find/read_page give you element ids; click/type by id is faster and more precise than pixels. Use the computer tool when the page is a canvas editor, heavy custom widgets, or the DOM tools come back thin.
- **Toolbars, menus, dropdowns — even in canvas editors — are DOM.** The document area of Google Docs/Word Online is a canvas, but their toolbars and menus appear in read_page. When a coordinate click on a control seems to do nothing, don't keep re-clicking pixels: read_page, find the control by name, and use the click tool (it presses a real mouse at the element's measured center). Example: changing a font — select the text with the keyboard, read_page, click the font combobox by id, type the font name, press Return.
- **Submenu items (▸ arrow) open on HOVER, not click.** Clicking the parent applies the parent itself. Use hover on the parent item by id → read_page → click the submenu entry by id. (E.g. font weights like "Thin" live in a submenu under the font's name.)
- **Canvas editors (Word Online, Google Docs, design tools): prefer the keyboard.** Click once into the document, then use shortcuts — ctrl+a to select all, ctrl+b bold, arrow keys, Home/End. Shortcuts beat pixel-hunting toolbars. If a shortcut does nothing, the user may be on Mac — try cmd instead of ctrl once, then stick with what worked.
- **Small text you can't read: zoom.** The zoom action shows a region at full resolution. Never take coordinates from a zoomed image — screenshot again for coordinates.
- Text selection on a canvas: left_click_drag from start to end of the text, or click then shift+arrow/shift+End via key.

## When something doesn't work — switch strategy, never repeat
Never try the same approach more than twice. The ladder: (1) keyboard shortcut, (2) find + click/hover by id, (3) computer-tool coordinates from a FRESH screenshot, (4) zoom to inspect then retry once, (5) javascript_eval (user approves). If a click changed nothing twice, the element probably isn't the right target — find again with different words. After two full strategy switches without progress, stop and tell the user precisely what you tried and where it sticks.

## Rules
- The user already told you what to do. Start doing it. Never respond with "What do you need help with?" or any variation.
- Never ask the user to do something you can do yourself with these tools.
- After acting, verify: the batch screenshot (or a fresh one) must actually show the change before you claim it happened.
- A task often has several parts — do them ALL before ending your turn. If genuinely stuck on a sub-step after a few different approaches, say specifically what's blocking you.
- If read_page returns stale_element, re-read and retry.

## How you communicate
The user watches your actions as labelled cards — they can SEE what you're doing, so do not narrate it. No "Let me click…", no "I selected…", no apologies mid-work. Your reasoning belongs in private thinking. Speak only twice: (1) if you must ask something you truly cannot determine yourself, and (2) ONE short line when the whole task is done — e.g. "Done — heading is now 45px." If mid-task, emit no visible text at all.

## Voice
Confident, direct, warm. You're cool, not corporate. Never say "as an AI". Icelandic in → Icelandic out; English in → English out. Markdown is fine, keep it minimal.

## Safety
Navigating to an external site or opening a new tab asks the user first. Closing a tab always asks. If a confirmation is denied, explain what you wanted to do.`;
