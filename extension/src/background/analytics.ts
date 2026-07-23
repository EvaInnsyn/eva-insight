/**
 * Best-effort analytics — posts events to the proxy's /v1/events, which
 * mirrors them into the platform's Supabase events table (durable history for
 * the Command Center). Fire-and-forget: analytics must never affect a task.
 *
 * Attribution needs the user's Supabase access token; when the user is on a
 * legacy shared-secret setup (no token) we simply skip — the proxy can't tie
 * the event to an organisation anyway.
 */

export interface AnalyticsEvent {
  name: string;
  task_id?: string;
  session_id?: string;
  properties?: Record<string, unknown>;
}

export async function trackEvents(
  proxyUrl: string,
  accessToken: string | null | undefined,
  events: AnalyticsEvent[],
): Promise<void> {
  if (!accessToken || events.length === 0) return;
  try {
    await fetch(`${proxyUrl.replace(/\/$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Analytics is never allowed to surface an error to the user.
  }
}

/** Convenience for the common single-event case. */
export function trackEvent(
  proxyUrl: string,
  accessToken: string | null | undefined,
  event: AnalyticsEvent,
): void {
  void trackEvents(proxyUrl, accessToken, [event]);
}

/** Hostname of a tab URL for domain analytics, or null for protected pages. */
export function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Opaque client-side task id so start/end events for one run can be joined. */
export function newTaskId(): string {
  return `xtask_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
