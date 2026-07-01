import type { UsageInfo } from "../hooks/useUsage";

interface Props {
  info: UsageInfo | null;
  error: string | null;
}

export function UsageBar({ info, error }: Props) {
  if (error) {
    return (
      <div className="eva-usage">
        <div className="eva-usage-label">Usage</div>
        <div className="eva-usage-error">{error}</div>
      </div>
    );
  }
  if (!info) return null;
  if (info.mode === "dev_unlimited") {
    return (
      <div className="eva-usage">
        <div className="eva-usage-label">Usage</div>
        <div className="eva-usage-dev">Dev mode · unlimited</div>
      </div>
    );
  }

  const used = info.used.output_tokens;
  const cap = info.cap.output_tokens;
  const pct = Math.min(100, Math.round((used / Math.max(1, cap)) * 100));
  const high = pct >= 80;
  const resetsDate = formatResetDate(info.period.resets_at);
  const planLabel = info.plan ? formatPlanName(info.plan) : null;

  return (
    <div className="eva-usage">
      {planLabel && (
        <div className="eva-usage-plan">{planLabel}</div>
      )}
      <div className="eva-usage-label">
        Usage · resets {resetsDate}
      </div>
      <div className="eva-usage-row">
        <div className="eva-usage-bar">
          <div
            className={`eva-usage-bar-fill ${high ? "eva-usage-bar-fill-warn" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="eva-usage-pct">{pct}%</div>
      </div>
      <div className="eva-usage-detail">
        {fmt(used)} / {fmt(cap)} output tokens
      </div>
    </div>
  );
}

const PLAN_LABELS: Record<string, string> = {
  innsyn: 'INNSÝN',
  'innsýn': 'INNSÝN',
  yfirsyn: 'YFIRSÝN',
  'yfirsýn': 'YFIRSÝN',
  umsja: 'UMSJÁ',
  'umsjá': 'UMSJÁ',
};

function formatPlanName(plan: string): string {
  return PLAN_LABELS[plan.toLowerCase()] ?? plan.toUpperCase();
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatResetDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "end of month";
  }
}
