/**
 * Working indicator. Shows a blinking eye plus a live status line. When Eva
 * is thinking, `label` carries her latest summarized thought (S2), so the
 * user sees real progress instead of a silent pause; otherwise it falls back
 * to a calm "er að vinna…".
 */
export function ThinkingEye({ label }: { label?: string } = {}) {
  const trimmed = (label ?? "").trim();
  const isThought = trimmed.length > 0;
  return (
    <span className="eva-thinking-eye" role="status" aria-label="er að vinna">
      <svg
        viewBox="0 0 48 30"
        width="40"
        height="25"
        xmlns="http://www.w3.org/2000/svg"
        className="eva-eye-svg"
        aria-hidden
      >
        <ellipse
          cx="24"
          cy="15"
          rx="22"
          ry="13"
          fill="var(--eva-bg)"
          stroke="var(--eva-frame)"
          strokeWidth="1.5"
        />
        <circle cx="24" cy="15" r="9" fill="var(--eva-bg-dim)" />
        <circle
          cx="24"
          cy="15"
          r="6.5"
          fill="none"
          stroke="var(--eva-frame)"
          strokeWidth="2"
        />
        <circle className="eva-eye-pupil" cx="24" cy="15" r="3.5" fill="var(--eva-frame)" />
      </svg>
      <span
        className={
          isThought ? "eva-thinking-label eva-thinking-thought" : "eva-thinking-label"
        }
      >
        {isThought ? `💭 ${trimmed}` : "er að vinna…"}
      </span>
    </span>
  );
}
