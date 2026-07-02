import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ChatMessage, ChatToolCall } from "@/shared/chat";
import { ToolCall } from "./ToolCall";
import { ThinkingEye } from "./ThinkingEye";

export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const cls = ["eva-msg", isUser ? "eva-msg-user" : "eva-msg-assistant"]
    .filter(Boolean)
    .join(" ");

  const calls = message.toolCalls ?? [];
  const hasText = message.text.length > 0;
  const hasCalls = calls.length > 0;

  return (
    <div className={cls}>
      <div className="eva-msg-bubble">
        {hasCalls ? (
          <ActivityGroup calls={calls} streaming={message.streaming === true} />
        ) : null}
        {hasText ? (
          <div className="eva-msg-text">
            <ReactMarkdown>{message.text}</ReactMarkdown>
            {message.streaming ? (
              <span className="eva-cursor" aria-hidden />
            ) : null}
          </div>
        ) : message.streaming && !hasCalls ? (
          <ThinkingEye />
        ) : null}
        {message.error ? <ErrorBlock raw={message.error} /> : null}
      </div>
    </div>
  );
}

/**
 * Eva's actions, presented like Claude's extension: while she's working the
 * steps stream in live; once she's done they fold into one clean headline
 * ("✓ 6 aðgerðir") you can expand to inspect. Keeps the transcript calm
 * instead of a wall of tool cards + narration.
 */
function ActivityGroup({
  calls,
  streaming,
}: {
  calls: ChatToolCall[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const done = calls.filter((c) => c.finishedAt).length;
  const anyError = calls.some((c) => c.isError);

  // While streaming, always show the live steps so the user sees progress.
  if (streaming) {
    return (
      <div className="eva-tools">
        {calls.map((c) => (
          <ToolCall key={c.id} call={c} />
        ))}
        <ThinkingEye />
      </div>
    );
  }

  // Finished: one headline, expandable.
  return (
    <div className="eva-activity">
      <button
        type="button"
        className="eva-activity-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={anyError ? "eva-activity-badge err" : "eva-activity-badge"}>
          {anyError ? "!" : "✓"}
        </span>
        <span className="eva-activity-label">
          {done} {done === 1 ? "aðgerð" : "aðgerðir"}
        </span>
        <span className="eva-tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="eva-tools">
          {calls.map((c) => (
            <ToolCall key={c.id} call={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Parse the raw error string we got from the background (which is usually
 * an Anthropic JSON envelope) and render a clean human message + an
 * actionable link when we recognize the failure.
 */
function ErrorBlock({ raw }: { raw: string }) {
  const parsed = parseError(raw);

  return (
    <div className="eva-msg-error">
      <div className="eva-msg-error-title">{parsed.title}</div>
      <div className="eva-msg-error-body">{parsed.message}</div>
      {parsed.actionUrl ? (
        <a
          href={parsed.actionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="eva-msg-error-action"
        >
          {parsed.actionLabel ?? "Open"}
        </a>
      ) : null}
    </div>
  );
}

interface ParsedError {
  title: string;
  message: string;
  actionUrl?: string;
  actionLabel?: string;
}

function parseError(raw: string): ParsedError {
  // The string usually looks like:  `400 {"type":"error","error":{...}}`
  // Strip the leading status code if present, then JSON.parse the rest.
  const status = raw.match(/^(\d{3})\s+/)?.[1];
  const body = status ? raw.slice(status.length + 1).trim() : raw;
  let inner: { type?: string; message?: string } | null = null;
  try {
    const outer = JSON.parse(body);
    inner =
      typeof outer?.error === "object" && outer.error !== null
        ? (outer.error as { type?: string; message?: string })
        : (outer as { type?: string; message?: string });
  } catch {
    // Not JSON — fall through to a generic envelope.
  }

  const innerMessage = inner?.message ?? raw;
  const innerType = inner?.type ?? "";

  // Special-case the Anthropic billing message — happens often enough to
  // justify a friendly button.
  if (/credit balance is too low/i.test(innerMessage)) {
    return {
      title: "Out of Anthropic credits",
      message:
        "Eva can't talk to Claude until you top up the Anthropic account funding the proxy.",
      actionUrl: "https://console.anthropic.com/settings/billing",
      actionLabel: "Open billing →",
    };
  }
  if (/rate limit/i.test(innerMessage) || innerType === "rate_limit_error") {
    return {
      title: "Rate limited",
      message: "Wait a moment and try again — the Anthropic API is asking us to slow down.",
    };
  }
  if (innerType === "authentication_error") {
    return {
      title: "Authentication failed",
      message:
        "Eva couldn't authenticate with the proxy. Check that the shared secret in Settings matches the server's EVA_INSIGHT_SHARED_SECRET.",
    };
  }
  if (innerType === "not_configured") {
    return {
      title: "Settings not configured",
      message: innerMessage,
    };
  }
  if (innerType === "ContentScriptUnavailableError") {
    return {
      title: "Page isn't ready",
      message:
        "Eva can't read this page yet. Try reloading the tab so the extension's content script can inject.",
    };
  }

  // Generic: just show the inner message, no JSON, no status code.
  return {
    title: titleCase(innerType) || "Something went wrong",
    message: innerMessage,
  };
}

function titleCase(s: string): string {
  if (!s) return "";
  return s
    .replace(/_/g, " ")
    .replace(/error$/i, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
