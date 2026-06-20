/**
 * Eva Innsýn platform auth (background service worker).
 *
 * Signs in against the SAME Supabase project the platform uses and stores the
 * resulting tokens in chrome.storage.local. Talks to Supabase's Auth REST API
 * directly (no SDK) so it works cleanly inside the MV3 service worker. Access
 * tokens are short-lived; getAccessToken() refreshes transparently on demand.
 */

import {
  PLATFORM,
  PLATFORM_AUTH_KEY,
  type PlatformStatus,
} from "../shared/platform";

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch seconds when the access token expires. */
  expiresAt: number;
  email: string;
  userId: string;
}

async function read(): Promise<StoredAuth | null> {
  const raw = await chrome.storage.local.get(PLATFORM_AUTH_KEY);
  return (raw[PLATFORM_AUTH_KEY] as StoredAuth | undefined) ?? null;
}

async function write(auth: StoredAuth | null): Promise<void> {
  if (auth) await chrome.storage.local.set({ [PLATFORM_AUTH_KEY]: auth });
  else await chrome.storage.local.remove(PLATFORM_AUTH_KEY);
}

function tokenEndpoint(grant: "password" | "refresh_token"): string {
  return `${PLATFORM.supabaseUrl}/auth/v1/token?grant_type=${grant}`;
}

interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id?: string; email?: string };
}

function toStored(data: SupabaseTokenResponse): StoredAuth {
  const expiresAt =
    typeof data.expires_at === "number"
      ? data.expires_at
      : Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    email: data.user?.email ?? "",
    userId: data.user?.id ?? "",
  };
}

export async function signIn(
  email: string,
  password: string,
): Promise<PlatformStatus> {
  const res = await fetch(tokenEndpoint("password"), {
    method: "POST",
    headers: {
      apikey: PLATFORM.supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error_description?: string;
      msg?: string;
      error?: string;
    };
    throw new Error(
      body.error_description || body.msg || body.error || "Sign in failed",
    );
  }
  const stored = toStored((await res.json()) as SupabaseTokenResponse);
  await write(stored);
  return { connected: true, email: stored.email };
}

export async function signOut(): Promise<void> {
  const auth = await read();
  if (auth) {
    // Best-effort server-side revoke; ignore failures.
    await fetch(`${PLATFORM.supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: {
        apikey: PLATFORM.supabaseAnonKey,
        Authorization: `Bearer ${auth.accessToken}`,
      },
    }).catch(() => {});
  }
  await write(null);
}

export async function getStatus(): Promise<PlatformStatus> {
  const auth = await read();
  return auth ? { connected: true, email: auth.email } : { connected: false };
}

/**
 * A valid access token, refreshed if it expires within 60s. Returns null when
 * not signed in or the refresh fails (caller treats it as "not connected").
 */
export async function getAccessToken(): Promise<string | null> {
  const auth = await read();
  if (!auth) return null;

  const now = Math.floor(Date.now() / 1000);
  if (auth.expiresAt - now > 60) return auth.accessToken;

  try {
    const res = await fetch(tokenEndpoint("refresh_token"), {
      method: "POST",
      headers: {
        apikey: PLATFORM.supabaseAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
    });
    if (!res.ok) {
      await write(null);
      return null;
    }
    const stored = toStored((await res.json()) as SupabaseTokenResponse);
    await write(stored);
    return stored.accessToken;
  } catch {
    return null;
  }
}
