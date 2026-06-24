export function ThinkingEye() {
  return (
    <span className="eva-thinking-eye" aria-label="thinking" role="img">
      <svg
        viewBox="0 0 48 30"
        width="48"
        height="30"
        xmlns="http://www.w3.org/2000/svg"
        className="eva-eye-svg"
      >
        {/* Outer eye shape */}
        <ellipse
          cx="24"
          cy="15"
          rx="22"
          ry="13"
          fill="var(--eva-bg)"
          stroke="var(--eva-frame)"
          strokeWidth="1.5"
        />
        {/* Iris */}
        <circle cx="24" cy="15" r="9" fill="var(--eva-bg-dim)" />
        {/* Iris ring */}
        <circle
          cx="24"
          cy="15"
          r="6.5"
          fill="none"
          stroke="var(--eva-frame)"
          strokeWidth="2"
        />
        {/* Orbiting pupil — animated via CSS */}
        <circle className="eva-eye-pupil" cx="24" cy="15" r="3.5" fill="var(--eva-frame)" />
      </svg>
    </span>
  );
}
