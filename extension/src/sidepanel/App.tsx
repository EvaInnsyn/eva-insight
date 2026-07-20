/**
 * Side panel root — Phase 2 chat shell, branded per Eva Innsýn handbook.
 *
 * Composes the header, chat history, composer, and inline settings.
 * State lives in two hooks: useChat (conversation + streaming) and
 * useSettings (proxy URL + shared secret).
 */

import { useEffect, useRef, useState } from "react";
import { useChat } from "./hooks/useChat";
import { useSettings } from "./hooks/useSettings";
import { useActiveTab } from "./hooks/useActiveTab";
import { ChatList } from "./components/ChatList";
import { Composer } from "./components/Composer";
import { FolderPicker } from "./components/FolderPicker";
import { usePlatformAuth } from "./hooks/usePlatformAuth";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Settings } from "./components/Settings";

// Vite resolves `/eye-32.png` from extension/public/ at build time.
const EYE_LOGO = "/eye-32.png";

export function App() {
  const {
    messages,
    streaming,
    pendingConfirm,
    send,
    abort,
    clear,
    decideConfirm,
    folder,
    setFolder,
  } = useChat();
  const { isConfigured, loaded: settingsLoaded } = useSettings();
  const platform = usePlatformAuth();
  const activeTab = useActiveTab();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // First-run: auto-open settings exactly once if we boot up unconfigured.
  const firstRunChecked = useRef(false);
  useEffect(() => {
    if (firstRunChecked.current) return;
    if (!settingsLoaded) return;
    firstRunChecked.current = true;
    if (!isConfigured) setSettingsOpen(true);
  }, [settingsLoaded, isConfigured]);

  return (
    <div className="eva-shell">
      <header className="eva-header">
        <div className="eva-logo">
          <img src={EYE_LOGO} alt="" className="eva-logo-img" />
          <span className="eva-logo-name">Eva Innsýn</span>
        </div>
        <div className="eva-header-actions">
          {messages.length > 0 ? (
            <button
              type="button"
              className="eva-iconbtn eva-iconbtn-text"
              onClick={() => {
                if (streaming) return;
                if (confirm("Clear this conversation?")) clear();
              }}
              title="Clear conversation"
              disabled={streaming}
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            className="eva-iconbtn"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="Toggle settings"
            title="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {activeTab ? (
        <div className={`eva-tab-strip ${activeTab.protected ? "eva-tab-strip-protected" : ""}`}>
          {activeTab.favIconUrl && !activeTab.protected ? (
            <img src={activeTab.favIconUrl} alt="" className="eva-tab-favicon" />
          ) : (
            <PageIcon />
          )}
          <span className="eva-tab-title">
            {activeTab.protected ? "System page — Eva can't read this" : (activeTab.title || activeTab.domain)}
          </span>
        </div>
      ) : null}

      {!isConfigured && !settingsOpen ? (
        <div className="eva-banner">
          <span>Set the proxy URL and shared secret to start chatting.</span>
          <button
            type="button"
            className="eva-link"
            onClick={() => setSettingsOpen(true)}
          >
            Open settings
          </button>
        </div>
      ) : null}

      <main className="eva-main">
        <ChatList messages={messages} />
      </main>

      <FolderPicker
        value={folder}
        onChange={setFolder}
        visible={platform.status.connected}
      />

      <Composer
        onSend={send}
        onStop={abort}
        streaming={streaming}
        disabled={!isConfigured}
        disabledReason={
          !isConfigured ? "Set proxy URL + secret to enable chat" : undefined
        }
      />

      {pendingConfirm ? (
        <ConfirmDialog
          request={pendingConfirm}
          onDecide={(allow, rememberOrigin) =>
            decideConfirm(pendingConfirm.requestId, allow, rememberOrigin)
          }
        />
      ) : null}
    </div>
  );
}

function PageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <circle cx="7.5" cy="6" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="6" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
