/**
 * Reads and writes Eva Insight settings from chrome.storage.local.
 * Reactive — listens for storage changes so multiple side-panel instances
 * stay in sync.
 */

import { useCallback, useEffect, useState } from "react";

export interface Settings {
  proxyUrl: string;
  sharedSecret: string;
  allowedDomains: string[];
}

const KEY = "eva-insight/settings";

const DEFAULTS: Settings = {
  proxyUrl: "http://localhost:8787",
  sharedSecret: "",
  allowedDomains: [],
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get(KEY).then((raw) => {
      if (cancelled) return;
      const stored = (raw[KEY] ?? {}) as Partial<Settings>;
      setSettings({ ...DEFAULTS, ...stored });
      setLoaded(true);
    });

    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local" || !(KEY in changes)) return;
      const next = (changes[KEY].newValue ?? {}) as Partial<Settings>;
      setSettings({ ...DEFAULTS, ...next });
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const save = useCallback(async (next: Settings) => {
    await chrome.storage.local.set({ [KEY]: next });
  }, []);

  const isConfigured =
    settings.proxyUrl.trim().length > 0 &&
    settings.sharedSecret.trim().length > 0;

  return { settings, loaded, save, isConfigured };
}
