import { useState } from "react";
import type { ChatToolCall } from "@/shared/chat";

interface Props {
  call: ChatToolCall;
  /** Samliggjandi eins skref renna saman í eitt kort með teljara. */
  count?: number;
}

export function ToolCall({ call, count }: Props) {
  const [open, setOpen] = useState(false);
  const isRunning = !call.finishedAt;
  const isError = call.isError === true;

  const label = labelFor(call.name, call.input);
  const summary = summaryFor(call);

  let statusClass = "eva-tool-status-done";
  if (isRunning) statusClass = "eva-tool-status-running";
  else if (isError) statusClass = "eva-tool-status-error";

  return (
    <div className="eva-tool">
      <button
        type="button"
        className="eva-tool-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`eva-tool-status ${statusClass}`} />
        <span className="eva-tool-icon" aria-hidden>{iconFor(call.name)}</span>
        <span className="eva-tool-name">{label}</span>
        {count && count > 1 ? (
          <span className="eva-tool-count">×{count}</span>
        ) : null}
        {summary ? <span className="eva-tool-summary">{summary}</span> : null}
        <span className="eva-tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="eva-tool-body">
          {hasInput(call.input) ? (
            <section className="eva-tool-section">
              <div className="eva-tool-section-label">Input</div>
              <pre className="eva-tool-code">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </section>
          ) : null}
          {call.output != null ? (
            <section className="eva-tool-section">
              <div className="eva-tool-section-label">
                {isError ? "Error" : "Output"}
              </div>
              <pre className="eva-tool-code">{prettyOutput(call.output)}</pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const COMPUTER_ACTION_LABELS: Record<string, string> = {
  screenshot: "Skoðar skjáinn",
  zoom: "Rýnir nánar",
  left_click: "Smellir",
  right_click: "Hægrismellir",
  middle_click: "Smellir",
  double_click: "Tvísmellir",
  triple_click: "Velur línu",
  left_click_drag: "Dregur",
  left_mouse_down: "Heldur músartakka",
  left_mouse_up: "Sleppir músartakka",
  mouse_move: "Færir bendil",
  type: "Skrifar",
  key: "Ýtir á",
  hold_key: "Heldur takka",
  scroll: "Skrunar",
  wait: "Bíður",
  cursor_position: "Athugar bendil",
  hover: "Heldur bendli yfir",
  scroll_to: "Skrunar að",
};

export function labelFor(name: string, input?: unknown): string {
  if (name === "computer") {
    const action = (input as { action?: string } | null)?.action ?? "";
    return COMPUTER_ACTION_LABELS[action] ?? "Vinnur á síðunni";
  }
  if (name === "batch_actions") {
    const n = (input as { actions?: unknown[] } | null)?.actions?.length ?? 0;
    return n > 0 ? `${n} skref í einu` : "Mörg skref í einu";
  }
  switch (name) {
    case "find": return "Leitar";
    case "remember": return "Uppfærir minnið";
    case "save_to_folder": return "Vistar í möppu";
    case "javascript_eval": return "Keyrir skriftu";
    case "get_page_text": return "Les textann";
    case "upload_image": return "Hleður upp skrá";
    case "read_console": return "Skoðar villuskrá";
    case "read_network": return "Skoðar netumferð";
    case "hover": return "Heldur bendli yfir";
    case "read_page": return "Les síðuna";
    case "get_active_tab": return "Athugar flipann";
    case "click": return "Smellir";
    case "click_at_coordinate": return "Smellir";
    case "double_click_at_coordinate": return "Tvísmellir";
    case "type": return "Skrifar";
    case "type_at_cursor": return "Skrifar";
    case "key_press": return "Ýtir á";
    case "scroll": return "Skrunar";
    case "scroll_to": return "Skrunar að";
    case "navigate": return "Opnar síðu";
    case "screenshot": return "Skoðar skjáinn";
    case "wait": return "Bíður";
    case "form_input": return "Stillir reit";
    case "tabs_list": return "Skoðar flipa";
    case "tabs_create": return "Opnar nýjan flipa";
    case "tabs_switch": return "Skiptir um flipa";
    case "tabs_close": return "Lokar flipa";
    default: return name;
  }
}

function iconFor(name: string): string {
  switch (name) {
    case "computer": return "🖱";
    case "batch_actions": return "⚡";
    case "remember": return "🧠";
    case "save_to_folder": return "📁";
    case "find": return "🔎";
    case "javascript_eval": return "🧪";
    case "get_page_text": return "📖";
    case "upload_image": return "📤";
    case "read_console": return "🪵";
    case "read_network": return "📡";
    case "hover": return "👇";
    case "read_page": return "📄";
    case "get_active_tab":
    case "tabs_list":
    case "tabs_switch": return "🗂";
    case "click":
    case "click_at_coordinate":
    case "double_click_at_coordinate": return "👆";
    case "type":
    case "type_at_cursor":
    case "form_input": return "⌨️";
    case "key_press": return "⏎";
    case "scroll":
    case "scroll_to": return "↕️";
    case "navigate":
    case "tabs_create": return "🌐";
    case "screenshot": return "👁";
    case "wait": return "⏳";
    case "tabs_close": return "✕";
    default: return "•";
  }
}

function summaryFor(call: ChatToolCall): string | null {
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return null;
  if (call.name === "computer") {
    const c = input.coordinate as [number, number] | undefined;
    if (typeof input.text === "string" && input.text) {
      return input.text.length > 28 ? `"${input.text.slice(0, 27)}…"` : `"${input.text}"`;
    }
    if (Array.isArray(c)) return `${Math.round(c[0])}, ${Math.round(c[1])}`;
    return null;
  }
  switch (call.name) {
    case "find":
      return typeof input.query === "string" ? `"${input.query}"` : null;
    case "hover":
    case "click":
    case "scroll_to":
      return typeof input.element_id === "string" ? input.element_id : null;
    case "click_at_coordinate":
    case "double_click_at_coordinate":
      return typeof input.x === "number" && typeof input.y === "number"
        ? `${Math.round(input.x)}, ${Math.round(input.y)}`
        : null;
    case "type":
    case "type_at_cursor":
      if (typeof input.text !== "string") return null;
      return input.text.length > 32
        ? `"${input.text.slice(0, 31)}…"`
        : `"${input.text}"`;
    case "key_press":
      return typeof input.key === "string" ? input.key : null;
    case "scroll":
      return typeof input.direction === "string" ? input.direction : null;
    case "navigate":
    case "tabs_create":
      return typeof input.url === "string" ? trimUrl(input.url) : null;
    case "form_input":
      return typeof input.value === "string" ? input.value : null;
    case "wait":
      return typeof input.ms === "number" ? `${input.ms}ms` : null;
    default:
      return null;
  }
}

function trimUrl(url: string): string {
  if (url.length <= 40) return url;
  return url.slice(0, 39) + "…";
}

function hasInput(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input !== "object") return true;
  return Object.keys(input as Record<string, unknown>).length > 0;
}

function prettyOutput(output: string): string {
  try {
    const parsed = JSON.parse(output);
    let pretty = JSON.stringify(parsed, null, 2);
    if (pretty.length > 1200) pretty = pretty.slice(0, 1199) + "\n… (truncated)";
    return pretty;
  } catch {
    return output.length > 1200 ? output.slice(0, 1199) + "… (truncated)" : output;
  }
}
