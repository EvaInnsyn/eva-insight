import { useState } from "react";
import type { ChatToolCall } from "@/shared/chat";

interface Props {
  call: ChatToolCall;
}

export function ToolCall({ call }: Props) {
  const [open, setOpen] = useState(false);
  const isRunning = !call.finishedAt;
  const isError = call.isError === true;

  const label = labelFor(call.name);
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

function labelFor(name: string): string {
  switch (name) {
    case "read_page": return "Reading page";
    case "get_active_tab": return "Checking tab";
    case "click": return "Clicking";
    case "click_at_coordinate": return "Clicking";
    case "double_click_at_coordinate": return "Double-clicking";
    case "type": return "Typing";
    case "type_at_cursor": return "Typing";
    case "key_press": return "Pressing key";
    case "scroll": return "Scrolling";
    case "scroll_to": return "Scrolling";
    case "navigate": return "Opening page";
    case "screenshot": return "Looking at screen";
    case "wait": return "Waiting";
    case "form_input": return "Setting field";
    case "tabs_list": return "Listing tabs";
    case "tabs_create": return "New tab";
    case "tabs_switch": return "Switching tab";
    case "tabs_close": return "Closing tab";
    default: return name;
  }
}

function iconFor(name: string): string {
  switch (name) {
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
  switch (call.name) {
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
