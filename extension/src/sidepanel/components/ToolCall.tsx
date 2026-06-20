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
    case "read_page": return "Read page";
    case "get_active_tab": return "Get active tab";
    case "click": return "Click";
    case "type": return "Type";
    case "scroll": return "Scroll";
    case "scroll_to": return "Scroll to";
    case "navigate": return "Navigate";
    default: return name;
  }
}

function summaryFor(call: ChatToolCall): string | null {
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return null;
  switch (call.name) {
    case "click":
    case "scroll_to":
      return typeof input.element_id === "string" ? input.element_id : null;
    case "type":
      if (typeof input.text !== "string") return null;
      return input.text.length > 32
        ? `"${input.text.slice(0, 31)}…"`
        : `"${input.text}"`;
    case "scroll":
      return typeof input.direction === "string" ? input.direction : null;
    case "navigate":
      return typeof input.url === "string" ? trimUrl(input.url) : null;
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
