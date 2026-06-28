import { useRef, useState, type KeyboardEvent } from "react";

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  disabledReason?: string;
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  disabledReason,
}: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (disabled) return;
    if (streaming) return;
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    // Reset textarea height after submit.
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Auto-grow textarea up to ~6 rows.
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
  };

  return (
    <div className="eva-composer">
      {disabled && disabledReason ? (
        <div className="eva-composer-disabled-note">{disabledReason}</div>
      ) : null}
      <div className="eva-composer-row">
        <textarea
          ref={textareaRef}
          className="eva-input"
          placeholder={
            disabled
              ? "Configure settings to start chatting"
              : streaming
                ? "Streaming…"
                : "Message Eva…"
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={onInput}
          disabled={disabled}
          rows={1}
        />
        {streaming ? (
          <button
            type="button"
            className="eva-btn eva-btn-stop"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="eva-btn eva-btn-send"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12l14-7-7 14-2-5-5-2z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
