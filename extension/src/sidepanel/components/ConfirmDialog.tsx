import { useEffect, useState } from "react";

export interface ConfirmRequest {
  requestId: string;
  toolName: string;
  prompt: string;
  allowAlways?: { kind: "domain"; origin: string };
}

interface Props {
  request: ConfirmRequest;
  onDecide: (allow: boolean, rememberOrigin?: string) => void;
}

export function ConfirmDialog({ request, onDecide }: Props) {
  const [remember, setRemember] = useState(false);

  // Reset the remember toggle when a new request lands.
  useEffect(() => {
    setRemember(false);
  }, [request.requestId]);

  // Esc to deny, Enter to allow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        decide(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        decide(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId, remember]);

  const decide = (allow: boolean) => {
    onDecide(
      allow,
      allow && remember && request.allowAlways?.kind === "domain"
        ? request.allowAlways.origin
        : undefined,
    );
  };

  return (
    <div className="eva-confirm-backdrop" role="dialog" aria-modal="true">
      <div className="eva-confirm">
        <div className="eva-confirm-eyebrow">Eva needs to confirm</div>
        <div className="eva-confirm-body">{request.prompt}</div>
        {request.allowAlways?.kind === "domain" ? (
          <label className="eva-confirm-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>
              Always allow Eva on{" "}
              <code>{request.allowAlways.origin}</code>
            </span>
          </label>
        ) : null}
        <div className="eva-confirm-actions">
          <button
            type="button"
            className="eva-btn-ghost"
            onClick={() => decide(false)}
          >
            Deny
          </button>
          <button
            type="button"
            className="eva-btn-primary"
            onClick={() => decide(true)}
            autoFocus
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
