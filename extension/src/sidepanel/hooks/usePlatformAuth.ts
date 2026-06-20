/**
 * Platform connection state for the side panel.
 *
 * Reads connection state from chrome.storage.local (reactive, like useSettings)
 * and drives sign in / sign out through the background service worker, which
 * owns the network calls and token storage.
 */

import { useCallback, useEffect, useState } from "react";
import {
  PLATFORM_AUTH_KEY,
  type PlatformResponse,
  type PlatformStatus,
} from "../../shared/platform";

function toStatus(stored: unknown): PlatformStatus {
  if (stored && typeof stored === "object") {
    const email = (stored as { email?: string }).email;
    return { connected: true, email };
  }
  return { connected: false };
}

export function usePlatformAuth() {
  const [status, setStatus] = useState<PlatformStatus>({ connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get(PLATFORM_AUTH_KEY).then((raw) => {
      if (!cancelled) setStatus(toStatus(raw[PLATFORM_AUTH_KEY]));
    });

    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local" || !(PLATFORM_AUTH_KEY in changes)) return;
      setStatus(toStatus(changes[PLATFORM_AUTH_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "platform/signIn",
        email,
        password,
      })) as PlatformResponse;
      if (!res?.ok) {
        setError(res?.error ?? "Sign in failed");
        return false;
      }
      setStatus(res.status);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await chrome.runtime.sendMessage({ type: "platform/signOut" });
      setStatus({ connected: false });
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, signIn, signOut };
}
