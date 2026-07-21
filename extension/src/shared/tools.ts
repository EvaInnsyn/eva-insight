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
      "Execute several steps in ONE call — much faster and cheaper than one step per turn. Two step shapes, freely mixed in order: (1) computer actions, incl. element targeting: {action:'left_click', element_id:'e85'} clicks the element's live center; {action:'type', element_id:'e12', text:'...'}; {action:'mouse_move', element_id:'e7'} hovers (opens submenus); coordinates still work: {action:'left_click', coordinate:[x,y]}; plus {action:'key', text:'Return'}, {action:'wait', duration:1}. (2) DOM tools: {tool:'find', input:{query:'save button'}}, {tool:'read_page', input:{filter:'interactive'}}, {tool:'get_page_text'}, {tool:'click'/'type'/'hover'/'form_input'/'scroll_to', input:{element_id:...}}, {tool:'read_console'}. Tool steps' outputs come back in step_results — so hover → read_page → (next turn) click, or type → key Enter → get_page_text, land in ONE round. Power moves: find once then batch everything by element ids; put a read step LAST to see what changed. Use this tool extensively — whenever you can predict two or more steps ahead, batch them. Coordinates you write in THIS batch refer to the screenshot taken BEFORE this call. Runs in order, stops on first error, ALWAYS returns a fresh screenshot. Cannot be nested; navigate/tabs/javascript_eval can't batch (they need confirmation). Max 20 steps.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description:
            "Ordered steps. Computer-action shape (action, coordinate, element_id, text, scroll_direction, scroll_amount, duration) or tool shape ({tool, input}).",
          items: { type: "object" },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "find",
    description:
      "Find elements on the page using natural language. Can search for elements by their purpose (e.g., 'search bar', 'login button') or by text content (e.g., 'organic mango product'). Returns up to 10 matching elements with references (usable as ref in computer clicks and with click/hover/type) plus measured on-screen centers. START HERE for any interaction with a control: faster, cheaper and more precise than reading the whole page or estimating pixels from a screenshot. Only visible elements match.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you're looking for, in a few words. Include the widget kind when known (button, field, dropdown, menu item).",
        },
        deep: {
          type: "boolean",
          description: "Force AI matching (understands meaning, e.g. finds the decline button whatever it's labelled). Slightly slower. Auto-engages when word search misses.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Get an accessibility tree representation of the page: indented text lines, one element per line — role \"name\" [ref] value=\"…\". Output is limited to 50000 characters by default; if it exceeds the limit it is truncated at a line boundary with a note giving the full size — pass a larger max_chars, or use depth/ref_id/filter to focus on part of the page. Pass filter: 'interactive' for a flat list of just the actionable controls (usually all you need). Refs work as ref in computer clicks and with click/hover/type. Refs reset when the page navigates. Canvas editors' document areas won't appear — their toolbars/menus will.",
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["interactive"],
          description: "'interactive' returns only actionable elements as a flat list — cheaper and easier than the full tree.",
        },
        depth: {
          type: "number",
          description: "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large.",
        },
        max_chars: { type: "number", description: "Maximum characters for output (default: 50000)." },
        ref_id: { type: "string", description: "Ref of a parent element — returns that element and all its children. Use to focus on part of the page (e.g. the menu that just opened)." },
      },
      required: [],
    },
  },
  {
    name: "get_page_text",
    description:
      "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting (clipped at 60K chars). Much better than read_page when you need CONTENT rather than controls.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "upload_image",
    description:
      "Upload a file into a file-upload field on the page: fetches the given URL (image, PDF, …) and delivers it into the <input type='file'> element — no file picker involved. Find the file input's id first (find or read_page; they are often hidden near an 'Upload' button). Max 6MB.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string", description: "Id of the input[type=file] element." },
        url: { type: "string", description: "http(s) URL of the file to upload." },
        filename: { type: "string", description: "Optional filename override, e.g. 'logo.png'." },
      },
      required: ["element_id", "url"],
    },
  },
  {
    name: "read_console",
    description:
      "Read browser console messages (log, warn, error) recorded while Eva acts on the page. Useful for debugging JavaScript errors or understanding what the page did after your actions. IMPORTANT: provide a pattern when looking for something specific — without one you may get many irrelevant messages.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex to filter messages (e.g., 'error|warning', 'MyApp'). Only matching messages return.",
        },
        onlyErrors: {
          type: "boolean",
          description: "If true, only return error and exception messages.",
        },
        clear: {
          type: "boolean",
          description: "If true, clear captured messages after reading to avoid duplicates next time.",
        },
        limit: { type: "number", description: "Max entries (default 40)." },
      },
      required: [],
    },
  },
  {
    name: "read_network",
    description:
      "Recent network requests (method, URL, status) from the page, recorded while Eva acts. Use to check whether a form/API call actually fired and what status it returned.",
    input_schema: {
      type: "object",
      properties: {
        clear: {
          type: "boolean",
          description: "If true, clear captured requests after reading to avoid duplicates next time.",
        },
        filter: { type: "string", description: "Substring of URL, or status prefix like '4' / '500'." },
        limit: { type: "number", description: "Max entries (default 40)." },
      },
      required: [],
    },
  },
  {
    name: "get_active_tab",
    description:
      "Get the URL and title of YOUR task tab (the tab you act on) without reading its content.",
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
      "Set values in form elements using an element ref from find/read_page: select dropdowns, checkboxes, radios. For text fields use `type`.",
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string", description: "Element ref from find/read_page." },
        value: {
          description: "For checkboxes use true/false (or 'toggle'), for selects use option value or visible text.",
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
      "Navigate YOUR task tab to a URL, or pass \"back\" / \"forward\" to move through history. The URL can be provided with or without protocol (defaults to https://). Waits for the page to load.",
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
    name: "save_to_folder",
    description:
      "Save a file (image, PDF, document) from a WEB URL straight into one of the user's project folders (verkefnamöppur) on the Eva platform, via API, no browsing needed. Use when the user asks to put/save/upload something into a mappa, e.g. a logo from their website into 'tilraun'. Resolve the file's URL first (from the current page via read_page/find, or a known URL). NOT for uploading into arbitrary websites (that is upload_image). Cannot access files on the user's computer.",
    input_schema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Folder name (e.g. 'tilraun') or folder id. Matched against the user's folders.",
        },
        url: {
          type: "string",
          description: "http(s) URL of the file to save.",
        },
        filename: {
          type: "string",
          description: "Optional name for the saved file.",
        },
      },
      required: ["folder", "url"],
    },
  },
  {
    name: "remember",
    description:
      "Save Eva's lasting memory about this user and their business — injected into every future conversation. FULL REPLACEMENT: compose the complete updated note (your current memory arrives in [auto context]; keep what holds, add the new, drop the stale). For durable facts only: business name & industry, their sites/platforms, brand voice, preferences, recurring workflows. NEVER passwords, payment details, or one-off task details. Compact structured note, max ~5500 chars. The user can view and edit it in Settings.",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The complete updated memory note (replaces the previous one).",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "tabs_list",
    description: "List open tabs in the current window (id, url, title, active).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tabs_create",
    description:
      "Open a new tab at the given URL. The new tab becomes your task tab. Pass background:true to open it WITHOUT disturbing the user's view — you keep working in it invisibly (screenshots and all tools still work).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        background: {
          type: "boolean",
          description: "Open without focusing — work there invisibly while the user's view stays put.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "tabs_switch",
    description:
      "Make the given tab id (from tabs_list) your task tab and bring it forward. Pass background:true to move your binding WITHOUT focusing the tab (the user's view stays put).",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "number" },
        background: {
          type: "boolean",
          description: "Move the binding only — don't bring the tab forward.",
        },
      },
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
export function buildEvaTools(_display: { width: number; height: number }): ToolSchema[] {
  // Custom schema mirroring the reference Chrome build (NOT computer_20251124):
  // same action set, ref-targeting, key sequences with repeat, click modifiers.
  const computer: CustomToolSchema = {
    name: "computer",
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.\n* On ordinary web pages, prefer ref-targeting: pass ref from find/read_page instead of coordinates — it clicks the element's live center, no pixel guessing.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click", "right_click", "type", "screenshot", "wait", "scroll",
            "key", "left_click_drag", "double_click", "triple_click", "zoom",
            "scroll_to", "hover",
          ],
          description:
            "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key or shortcut.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.",
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          description:
            "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll` (unless ref is given). For `left_click_drag`, this is the end position.",
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          description: "(x, y): The starting coordinates for `left_click_drag`.",
        },
        ref: {
          type: "string",
          description:
            'Element reference ID from read_page or find tools (e.g., "e12"). Required for `scroll_to`. Can be used as alternative to `coordinate` for click and hover actions — clicks the element\'s measured center.',
        },
        text: {
          type: "string",
          description:
            'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key`: provide space-separated keys to press in sequence (e.g., "Backspace Backspace Delete") and shortcuts with "+" (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a").',
        },
        modifiers: {
          type: "string",
          description:
            'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"). Can be combined with "+" (e.g., "ctrl+shift"). Optional.',
        },
        repeat: {
          type: "number",
          description:
            "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times.",
        },
        duration: {
          type: "number",
          description: "The number of seconds to wait. Required for `wait`. Maximum 10 seconds.",
        },
        scroll_direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "The direction to scroll. Required for `scroll`.",
        },
        scroll_amount: {
          type: "number",
          description: "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3.",
        },
        region: {
          type: "array",
          items: { type: "number" },
          description:
            "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom`.",
        },
      },
      required: ["action"],
    },
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
You control ONE browser tab — YOUR task tab, locked in when the task starts. It stays yours even if the user switches to another tab or window while you work: your screenshots, clicks and typing keep landing on YOUR tab (captured in the background if needed), never on what the user is currently viewing. So never panic if a screenshot shows the "wrong" page is focused elsewhere — you are still on your tab. Move deliberately with tabs_switch/tabs_create (they re-bind you). The computer tool sees that tab's viewport only (not the desktop, no other apps, no browser UI). Coordinates come from your latest screenshot. Canvas editors (Docs, Word Online) render best when your tab is visible — if canvas screenshots look frozen, tabs_switch to your own tab id to bring it forward.

## How to work — speed matters
- find also searches EMBEDDED FRAMES (Wix canvas, Word Online editor): frame_matches come back with click_coordinate — click those with the computer tool at that coordinate (ids don't cross frames).\n- **find first.** When you need a specific control ("the font selector", "the save button"), call find — it returns exact elements with refs you can act on in one step: pass ref straight to the computer tool ({action:'left_click', ref:'e85'}) or to click/hover/type. Prefer ref-clicks over coordinates on ordinary pages. Only fall back to read_page (whole tree) or screenshots when find comes up empty.
- read_page returns indented text lines: role "name" [ref] — the ref in brackets is what you click with. Keyboard navigation: {action:'key', text:'Down Down Enter'} presses a sequence; add repeat: N to repeat it (arrow through lists fast).
- **batch_actions is your default for acting.** One call = several steps (click field → type → press Enter; or menu click → wait → next click). Steps can also be DOM tools: {tool:'find'...}, {tool:'read_page'...}, {tool:'get_page_text'} — their outputs return in step_results, so act → read lands in one round (e.g. click a menu, then {tool:'read_page', input:{filter:'interactive'}} to see its items; or submit a search, then {tool:'get_page_text'}). It always returns a fresh screenshot. Single computer actions ALSO return a fresh screenshot of the result automatically — never spend a turn just asking for a screenshot after acting.
- **Ordinary websites: use the DOM fast path.** find/read_page give you element ids; click/type by id is faster and more precise than pixels. Use the computer tool when the page is a canvas editor, heavy custom widgets, or the DOM tools come back thin.
- **Toolbars, menus, dropdowns — even in canvas editors — are DOM.** The document area of Google Docs/Word Online is a canvas, but their toolbars and menus appear in read_page. When a coordinate click on a control seems to do nothing, don't keep re-clicking pixels: read_page, find the control by name, and use the click tool (it presses a real mouse at the element's measured center). Example: changing a font — select the text with the keyboard, read_page, click the font combobox by id, type the font name, press Return.
- **Submenu items (▸ arrow) open on HOVER, not click.** Clicking the parent applies the parent itself. One batch: [{tool:'hover', input:{element_id:'eN'}}, {tool:'read_page', input:{filter:'interactive'}}] — the submenu's items arrive in step_results; click the entry by id next. (E.g. font weights like "Thin" live in a submenu under the font's name.)
- **Canvas editors (Word Online, Google Docs, design tools): prefer the keyboard.** Click once into the document, then use shortcuts — ctrl+a to select all, ctrl+b bold, arrow keys, Home/End. Shortcuts beat pixel-hunting toolbars. If a shortcut does nothing, the user may be on Mac — try cmd instead of ctrl once, then stick with what worked.
- **Small text you can't read: zoom.** The zoom action shows a region at full resolution. Never take coordinates from a zoomed image — screenshot again for coordinates.
- Text selection on a canvas: left_click_drag from start to end of the text, or click then shift+arrow/shift+End via key.

## When something doesn't work — switch strategy, never repeat
Never try the same approach more than twice. The ladder: (1) keyboard shortcut, (2) find + click/hover by id, (3) computer-tool coordinates from a FRESH screenshot, (4) zoom to inspect then retry once, (5) javascript_eval (user approves). If a click changed nothing twice, the element probably isn't the right target — find again with different words. After two full strategy switches without progress, stop and tell the user precisely what you tried and where it sticks.

## More powers
- Native popups (alert/confirm) are handled automatically — they get accepted and what they said appears in read_console. You never need to worry about them freezing the page.
- The killer combo: find the elements once → ONE batch_actions with element ids: [{action:'left_click', element_id:'e85'}, {action:'type', element_id:'e85', text:'Lexend'}, {action:'key', text:'Return'}]. Precise AND fast.
- get_page_text reads a whole article/page as clean text — use it for summarizing or extracting, not read_page.
- upload_image puts a file (by URL) straight into an upload field — find the input[type=file] id first; look near the Upload button.
- read_console / read_network reveal what the page did after your actions — check them when something silently fails.
- Your first user message includes [auto context] with your tab's title and URL — you already know where you are; don't call get_active_tab or take an orientation screenshot to find out.
- **Research side-quests without disturbing the user:** tabs_create {background:true} opens a tab the user never sees focused — your binding follows it; gather what you need (get_page_text, find), then tabs_switch back with {background:true} and finish the original task. tabs_list marks your bound tab with your_task_tab. If a background page renders empty (some sites lazy-load only when visible), tabs_switch to it normally to bring it forward.

## Project folder
[auto context] may name the task's project folder, chosen by the user before the run, plus recent work from it. Never ask which folder the work belongs in, the panel already handled that. If the folder's recent work clearly relates to the current request, offer ONCE in one short sentence to continue where it left off, then act on the user's answer.

## The user can send you images
The user can attach images to their message (paste, drag, or pick a file) — you SEE them directly. Work with what's in them: describe, analyse, pull text/colors, write a caption or post from them, compare them to the page you're on. To save an image that lives on a WEB PAGE into a project folder, use save_to_folder with the image's URL (a pasted image the user attached isn't on the web, so tell them to use ⬆ Hlaða upp on the folder page for those).

## The Eva platform (app.evai.is) is YOURS, use the direct lane
The user's own Eva platform (app.evai.is, Verkefnin mín, möppur, Lotur) is your home system. NEVER browse/click around it like a foreign website. To put a file into a project folder, use save_to_folder with the file's URL, one call, done. If the user is ON a platform page and asks something the tools cover, act via the tool immediately. Files on the user's COMPUTER are out of reach for you, say so in one sentence and point them to the ⬆ Hlaða upp button on the folder page, never wander looking for a way.

## Stay on task, on the page
Never navigate away from the page the user is working on unless the task itself requires it. If the current page already contains what you need (per [auto context] or the screenshot), work right there.

## Memory
[auto context] may carry "Eva's saved memory" — durable facts about this user and their business. Use them silently; don't recite them back. When you learn a LASTING fact (their business, their sites, preferences, how they like things done), call remember ONCE near the end of the task with the full updated note — merge new into old, drop stale lines. Never store secrets, passwords or payment details. Don't announce that you're saving; just do it.

## Rules
- The user already told you what to do. Start doing it. Never respond with "What do you need help with?" or any variation.
- Never ask the user to do something you can do yourself with these tools.
- Every acting step already returns a screenshot — THAT is your verification. Evaluate it: outcome correct → move on; wrong → different approach. NEVER take an extra screenshot just to re-confirm something the last screenshot already showed.\n- **End decisively.** The moment the goal is visibly achieved in the latest screenshot, STOP acting and give your one-line result. No victory-lap screenshots, no double-checking twice, no tidying nobody asked for.\n- Dropdowns, comboboxes and scrollbars are hard to manipulate with the mouse — reach for keyboard shortcuts and arrow keys on them first.
- A task often has several parts — do them ALL before ending your turn. If genuinely stuck on a sub-step after a few different approaches, say specifically what's blocking you.
- If read_page returns stale_element, re-read and retry.

## How you communicate
The user watches your actions as labelled cards — they can SEE what you're doing, so do not narrate it. No "Let me click…", no "I selected…", no apologies mid-work. Your reasoning belongs in private thinking. Speak only twice: (1) if you must ask something you truly cannot determine yourself, and (2) ONE short line when the whole task is done — e.g. "Done — heading is now 45px." If mid-task, emit no visible text at all.

## Voice
Confident, direct, warm. You're cool, not corporate. Never say "as an AI". Icelandic in → Icelandic out; English in → English out. Markdown is fine, keep it minimal.

## Safety
Navigating to an external site or opening a new tab asks the user first. Closing a tab always asks. If a confirmation is denied, explain what you wanted to do.`;
