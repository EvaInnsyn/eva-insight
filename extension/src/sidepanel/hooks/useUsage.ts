/**
 * Polls /v1/me on the proxy so the side panel can show "X / Y tokens
 * used this month". Refreshes every 30s and on demand (via the returned
 * `refresh` function).
 */

import { useCallback, useEffect, useState } from "react";
import { useSettings } from "./useSettings";

export type UsageInfo =
  | {
      mode: "metered";
      name: string;
      cap: { input_tokens: number; output_tokens: number };
      used: { input_tokens: number; output_tokens: number };
      period: { key: string; resets_at: string };
    }
  | {
      mode: "dev_unlimited";
      message: string;
    };

interface State {
  info: UsageInfo | null;
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 30_000;

export function useUsage() {
  const { settings, isConfigured } = useSettings();
  const [state, setState] = useState<State>({
    info: null,
    loading: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!isConfigured) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const url = new URL("/v1/me", settings.proxyUrl).toString();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${settings.sharedSecret}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const info = (await res.json()) as UsageInfo;
      setState({ info, loading: false, error: null });
    } catch (err) {
      setState({
        info: null,
        loading: false,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }, [isConfigured, settings.proxyUrl, settings.sharedSecret]);

  useEffect(() => {
    refresh();
    if (!isConfigured) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, isConfigured]);

  return { ...state, refresh };
}
