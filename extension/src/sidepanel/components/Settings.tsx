import { useState, useEffect } from "react";
import { useUsage } from "../hooks/useUsage";
import { usePlatformAuth } from "../hooks/usePlatformAuth";
import { UsageBar } from "./UsageBar";
import { useSettings, type Settings as SettingsT } from "../hooks/useSettings";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Password field with a show/hide eye — Eva's own mark doing honest work. */
function PasswordInput({
  value,
  placeholder,
  autoComplete,
  onChange,
}: {
  value: string;
  placeholder: string;
  autoComplete: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="eva-password-wrap">
      <input
        type={show ? "text" : "password"}
        className="eva-text eva-password-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="eva-password-toggle"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Fela lykilorð" : "Sýna lykilorð"}
        title={show ? "Fela lykilorð" : "Sýna lykilorð"}
      >
        {show ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
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
  const [memory, setMemory] = useState<string | null>(null); // null = not loaded
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryMsg, setMemoryMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !platform.status.connected) return;
    setMemory(null);
    chrome.runtime
      .sendMessage({ type: "memory/get" })
      .then((res: { ok?: boolean; content?: string }) => {
        setMemory(res?.ok ? (res.content ?? "") : "");
      })
      .catch(() => setMemory(""));
  }, [open, platform.status.connected]);

  const saveMemoryDraft = async (content: string) => {
    setMemoryBusy(true);
    setMemoryMsg(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "memory/set",
        content,
      })) as { ok?: boolean; error?: string };
      setMemoryMsg(res?.ok ? "Vistað ✓" : (res?.error ?? "Villa við vistun"));
      if (res?.ok) setMemory(content);
    } catch (err) {
      setMemoryMsg(err instanceof Error ? err.message : "Villa við vistun");
    } finally {
      setMemoryBusy(false);
    }
  };

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
              <PasswordInput
                value={pfPassword}
                placeholder="Lykilorð"
                autoComplete="current-password"
                onChange={setPfPassword}
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
              <span style={{ color: "#8a8378", fontSize: 11 }}>
                Notaðu sama aðgang og á eva-innsyn.vercel.app
              </span>
            </div>
          )}
        </div>

        {/* ── Eva's memory ── */}
        {platform.status.connected && (
          <div className="eva-field">
            <span className="eva-field-label">Minni Evu</span>
            <span style={{ color: "#8a8378", fontSize: 11 }}>
              Eva man þetta á milli samtala, um fyrirtækið þitt, síðurnar
              þínar og hvernig þú vilt hafa hlutina. Hún uppfærir það sjálf;
              þú mátt breyta eða hreinsa.
            </span>
            {memory === null ? (
              <span style={{ color: "#8a8378", fontSize: 12 }}>Sæki…</span>
            ) : (
              <>
                <textarea
                  className="eva-text"
                  value={memory}
                  rows={5}
                  style={{ resize: "vertical", fontSize: 12, lineHeight: 1.4 }}
                  onChange={(e) => setMemory(e.target.value)}
                  placeholder="Ekkert vistað enn, Eva bætir við þegar hún kynnist þér."
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="eva-btn-primary"
                    disabled={memoryBusy}
                    onClick={() => saveMemoryDraft(memory)}
                    style={{ fontSize: 12 }}
                  >
                    {memoryBusy ? "Vista…" : "Vista"}
                  </button>
                  <button
                    type="button"
                    className="eva-link"
                    disabled={memoryBusy}
                    onClick={() => saveMemoryDraft("")}
                    style={{ fontSize: 12 }}
                  >
                    Hreinsa
                  </button>
                  {memoryMsg && (
                    <span style={{ fontSize: 11, color: "#8a8378" }}>{memoryMsg}</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

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
          style={{ fontSize: 11, color: "#8a8378", alignSelf: "flex-start" }}
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
