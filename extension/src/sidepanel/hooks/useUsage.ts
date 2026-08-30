/**
 * Polls /v1/me on the proxy so the side panel can show "X / Y tokens
 * used this month". Refreshes every 30s and on demand (via the returned
 * `refresh` function).
 *
 * Kallið fer GEGNUM background ("usage/fetch"), sem heldur á platform-
 * aðgangslyklinum og fellur á sharedSecret. Platform-notendur hafa oft
 * ekkert sharedSecret, svo beint fetch héðan sýndi þeim aldrei mælinn.
 */

import { useCallback, useEffect, useState } from "react";
import { useSettings } from "./useSettings";
import { usePlatformAuth } from "./usePlatformAuth";

export type UsageInfo =
  | {
      mode: "credit";
      plan?: string;
      name: string;
      balance_isk: number;
      /** Full purchased amount in ISK — what the dashboard displays. */
      purchased_isk?: number;
      /** 0–100, share of the purchased credit still unused. */
      percent_remaining?: number;
    }
  | {
      mode: "metered";
      plan?: string;
      name: string;
      cap: { input_tokens: number; output_tokens: number };
      used: { input_tokens: number; output_tokens: number };
      period: { key: string; resets_at: string };
    }
  | {
      mode: "dev_unlimited";
      message: string;
    }
  | {
      /** Innanhúss-aðgangur — ekkert dregst af, notkun fer beint á console. */
      mode: "internal";
      plan?: string;
      name: string;
    };

interface State {
  info: UsageInfo | null;
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 30_000;

export function useUsage() {
  const { isConfigured } = useSettings();
  const { status: platform } = usePlatformAuth();
  // Sama hlið og spjallið sjálft (fe926bf): platform-innskráning EÐA
  // handvirk stilling með sharedSecret.
  const canFetch = isConfigured || platform.connected;
  const [state, setState] = useState<State>({
    info: null,
    loading: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "usage/fetch",
      })) as { ok: true; info: UsageInfo } | { ok: false; error: string } | undefined;
      if (!res?.ok) {
        throw new Error(res && "error" in res ? res.error : "unknown error");
      }
      setState({ info: res.info, loading: false, error: null });
    } catch (err) {
      setState({
        info: null,
        loading: false,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }, [canFetch]);

  useEffect(() => {
    refresh();
    if (!canFetch) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, canFetch]);

  return { ...state, refresh };
}
