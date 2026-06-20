import { useEffect, useState } from "react";
import { useSettings, type Settings as SettingsT } from "../hooks/useSettings";
import { useUsage } from "../hooks/useUsage";
import { usePlatformAuth } from "../hooks/usePlatformAuth";
import { UsageBar } from "./UsageBar";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function Settings({ open, onClose }: Props) {
  const { settings, save } = useSettings();
  const { info: usage, error: usageError } = useUsage();
  const platform = usePlatformAuth();
  const [draft, setDraft] = useState<SettingsT>(settings);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pfEmail, setPfEmail] = useState("");
  const [pfPassword, setPfPassword] = useState("");

  // Sync the form when stored settings change underneath us.
  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  if (!open) return null;

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await save({
      proxyUrl: draft.proxyUrl.trim(),
      sharedSecret: draft.sharedSecret.trim(),
      allowedDomains: draft.allowedDomains.filter((d) => d.trim().length > 0),
    });
    setSavedAt(Date.now());
  };

  const removeDomain = (origin: string) => {
    setDraft({
      ...draft,
      allowedDomains: draft.allowedDomains.filter((d) => d !== origin),
    });
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
      <form onSubmit={onSubmit} className="eva-settings-body">
        <label className="eva-field">
          <span className="eva-field-label">Proxy URL</span>
          <input
            type="url"
            className="eva-text"
            value={draft.proxyUrl}
            placeholder="http://localhost:8787"
            onChange={(e) =>
              setDraft({ ...draft, proxyUrl: e.target.value })
            }
            required
          />
        </label>
        <label className="eva-field">
          <span className="eva-field-label">Pairing token</span>
          <input
            type="password"
            className="eva-text"
            value={draft.sharedSecret}
            placeholder="tok_… (from your admin) or dev shared secret"
            onChange={(e) =>
              setDraft({ ...draft, sharedSecret: e.target.value })
            }
            required
            autoComplete="off"
          />
        </label>
        <UsageBar info={usage} error={usageError} />
        <div className="eva-field">
          <span className="eva-field-label">Eva Innsýn platform</span>
          {platform.status.connected ? (
            <div className="eva-allowed">
              <span className="eva-allowed-chip">
                {platform.status.email || "Connected"}
              </span>
              <button
                type="button"
                className="eva-link"
                onClick={() => platform.signOut()}
                disabled={platform.busy}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                type="email"
                className="eva-text"
                value={pfEmail}
                placeholder="you@eva-innsyn.is"
                onChange={(e) => setPfEmail(e.target.value)}
                autoComplete="off"
              />
              <input
                type="password"
                className="eva-text"
                value={pfPassword}
                placeholder="Eva password"
                onChange={(e) => setPfPassword(e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                className="eva-btn-primary"
                disabled={platform.busy || !pfEmail || !pfPassword}
                onClick={async () => {
                  const ok = await platform.signIn(pfEmail, pfPassword);
                  if (ok) setPfPassword("");
                }}
              >
                {platform.busy ? "Connecting…" : "Connect"}
              </button>
              {platform.error ? (
                <span style={{ color: "#BE3519", fontSize: 12 }}>
                  {platform.error}
                </span>
              ) : null}
            </div>
          )}
          <span style={{ color: "#888780", fontSize: 12 }}>
            Connect your Eva account to auto-save sessions to the dashboard.
          </span>
        </div>
        {draft.allowedDomains.length > 0 ? (
          <div className="eva-field">
            <span className="eva-field-label">Always-allow on</span>
            <div className="eva-allowed">
              {draft.allowedDomains.map((d) => (
                <span key={d} className="eva-allowed-chip">
                  {d}
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    onClick={() => removeDomain(d)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="eva-settings-actions">
          {savedAt ? (
            <span className="eva-settings-saved">Saved</span>
          ) : (
            <span />
          )}
          <button type="submit" className="eva-btn-primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
