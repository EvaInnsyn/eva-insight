import { useState } from "react";
import { useUsage } from "../hooks/useUsage";
import { usePlatformAuth } from "../hooks/usePlatformAuth";
import { UsageBar } from "./UsageBar";
import { useSettings, type Settings as SettingsT } from "../hooks/useSettings";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function Settings({ open, onClose }: Props) {
  const { settings, save } = useSettings();
  const { info: usage, error: usageError } = useUsage();
  const platform = usePlatformAuth();
  const [pfEmail, setPfEmail] = useState("");
  const [pfPassword, setPfPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [draft, setDraft] = useState<SettingsT>(settings);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (!open) return null;

  const onAdvancedSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await save({
      proxyUrl: draft.proxyUrl.trim(),
      sharedSecret: draft.sharedSecret.trim(),
      allowedDomains: draft.allowedDomains.filter((d) => d.trim().length > 0),
    });
    setSavedAt(Date.now());
  };

  return (
    <div className="eva-settings">
      <div className="eva-settings-header">
        <span>Settings</span>
        <button
          type="button"
          className="eva-iconbtn"
          onClick={onClose}
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>

      <div className="eva-settings-body">
        {/* ── Eva account ── */}
        <div className="eva-field">
          <span className="eva-field-label">Eva account</span>
          {platform.status.connected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="eva-allowed">
                <span className="eva-allowed-chip">
                  ✓ {platform.status.email || "Connected"}
                </span>
              </div>
              <UsageBar info={usage} error={usageError} />
              <button
                type="button"
                className="eva-link"
                onClick={() => platform.signOut()}
                disabled={platform.busy}
                style={{ alignSelf: "flex-start", fontSize: 12 }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                type="email"
                className="eva-text"
                value={pfEmail}
                placeholder="Netfang"
                onChange={(e) => setPfEmail(e.target.value)}
                autoComplete="email"
              />
              <input
                type="password"
                className="eva-text"
                value={pfPassword}
                placeholder="Lykilorð"
                onChange={(e) => setPfPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="eva-btn-primary"
                disabled={platform.busy || !pfEmail || !pfPassword}
                onClick={async () => {
                  const ok = await platform.signIn(pfEmail, pfPassword);
                  if (ok) {
                    setPfEmail("");
                    setPfPassword("");
                  }
                }}
              >
                {platform.busy ? "Skrái inn…" : "Skrá inn"}
              </button>
              {platform.error ? (
                <span style={{ color: "#BE3519", fontSize: 12 }}>
                  {platform.error}
                </span>
              ) : null}
              <span style={{ color: "#888780", fontSize: 11 }}>
                Notaðu sama aðgang og á eva-innsyn.vercel.app
              </span>
            </div>
          )}
        </div>

        {/* ── Always-allowed domains ── */}
        {draft.allowedDomains.length > 0 && (
          <div className="eva-field">
            <span className="eva-field-label">Always-allow on</span>
            <div className="eva-allowed">
              {draft.allowedDomains.map((d) => (
                <span key={d} className="eva-allowed-chip">
                  {d}
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        allowedDomains: draft.allowedDomains.filter(
                          (x) => x !== d
                        ),
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Advanced (developer) ── */}
        <button
          type="button"
          className="eva-link"
          style={{ fontSize: 11, color: "#888780", alignSelf: "flex-start" }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </button>

        {showAdvanced && (
          <form onSubmit={onAdvancedSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="eva-field">
              <span className="eva-field-label">Proxy URL</span>
              <input
                type="url"
                className="eva-text"
                value={draft.proxyUrl}
                placeholder="https://eva-insightserver-production.up.railway.app"
                onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })}
              />
            </label>
            <label className="eva-field">
              <span className="eva-field-label">Pairing token</span>
              <input
                type="password"
                className="eva-text"
                value={draft.sharedSecret}
                placeholder="tok_…"
                onChange={(e) => setDraft({ ...draft, sharedSecret: e.target.value })}
                autoComplete="off"
              />
            </label>
            <div className="eva-settings-actions">
              {savedAt ? <span className="eva-settings-saved">Saved</span> : <span />}
              <button type="submit" className="eva-btn-primary">Save</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
