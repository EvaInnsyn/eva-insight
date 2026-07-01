export function ThinkingEye() {
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
      <span className="eva-thinking-label">er að vinna…</span>
    </span>
  );
}
