import { useEffect, useState } from "react";

export interface ActiveTabInfo {
  title: string;
  domain: string;
  favIconUrl?: string;
  protected: boolean;
}

const PROTECTED = /^(chrome|chrome-extension|edge|about|file|view-source):/i;

async function queryTab(): Promise<ActiveTabInfo | null> {
  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      // DevTools may be the "current window" — fall back to last focused window.
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
    if (!tab?.url) return null;
    const isProtected = PROTECTED.test(tab.url);
    let domain = "";
    try { domain = new URL(tab.url).hostname; } catch { /* ignore */ }
    return {
      title: tab.title ?? domain,
      domain,
      favIconUrl: tab.favIconUrl,
      protected: isProtected,
    };
  } catch {
    return null;
  }
}

export function useActiveTab(): ActiveTabInfo | null {
  const [tab, setTab] = useState<ActiveTabInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => queryTab().then((t) => { if (!cancelled) setTab(t); });

    refresh();

    const onActivated = () => refresh();
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo) => {
      if (change.status === "complete" || change.title !== undefined) refresh();
    };
    const onFocusChanged = () => refresh();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    };
  }, []);

  return tab;
}
