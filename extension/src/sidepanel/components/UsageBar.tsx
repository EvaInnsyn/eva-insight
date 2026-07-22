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

  if (info.mode === "internal") {
    return (
      <div className="eva-usage">
        {info.plan && <div className="eva-usage-plan">{formatPlanName(info.plan)}</div>}
        <div className="eva-usage-label">Inneign</div>
        <div className="eva-usage-row">
          <div className="eva-usage-pct eva-usage-pct-ok" style={{ fontSize: 15, fontWeight: 700 }}>
            Ótakmarkað
          </div>
        </div>
        <div className="eva-usage-detail">Innanhúss-aðgangur — ekkert dregst af</div>
      </div>
    );
  }

  if (info.mode === "credit") {
    const planLabel = info.plan ? formatPlanName(info.plan) : null;
    const purchased = info.purchased_isk ?? 0;
    const pctLeft =
      info.percent_remaining ??
      (purchased > 0 ? Math.min(100, Math.round((info.balance_isk / purchased) * 100)) : 0);
    const stage = pctLeft <= 10 ? "high" : pctLeft <= 30 ? "mid" : "ok";
    return (
      <div className="eva-usage">
        {planLabel && <div className="eva-usage-plan">{planLabel}</div>}
        <div className="eva-usage-label">
          Inneign{purchased > 0 ? ` · ${purchased.toLocaleString("is-IS")} kr` : ""}
        </div>
        <div className="eva-usage-row">
          <div className="eva-usage-bar">
            <div
              className={`eva-usage-bar-fill eva-usage-bar-fill-${stage}`}
              style={{ width: `${pctLeft}%` }}
            />
          </div>
          <div className={`eva-usage-pct eva-usage-pct-${stage}`}>{pctLeft}%</div>
        </div>
        <div className="eva-usage-detail">
          {purchased === 0
            ? "Engin inneign ennþá — kauptu inneign á app.evai.is"
            : pctLeft <= 10
              ? "Inneignin er að klárast, bættu við á app.evai.is"
              : "Vinna Evu dregst af inneigninni þinni, hún fyrnist ekki"}
        </div>
      </div>
    );
  }

  // A user is blocked when EITHER cap is hit, so the bar tracks whichever
  // budget is closer to running out (matches the server's overCap logic).
  const outFrac = info.used.output_tokens / Math.max(1, info.cap.output_tokens);
  const inFrac = info.used.input_tokens / Math.max(1, info.cap.input_tokens);
  const frac = Math.max(outFrac, inFrac);
  const pct = Math.min(100, Math.round(frac * 100));
  // Traffic light: green → amber → red as the month's budget is spent.
  const stage = pct >= 80 ? "high" : pct >= 50 ? "mid" : "ok";
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
            className={`eva-usage-bar-fill eva-usage-bar-fill-${stage}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className={`eva-usage-pct eva-usage-pct-${stage}`}>{pct}%</div>
      </div>
      <div className="eva-usage-detail">
        {fmt(info.used.output_tokens)} / {fmt(info.cap.output_tokens)} output tokens
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
