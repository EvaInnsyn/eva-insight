/**
 * Runs on app.evai.is — reads the Supabase session from localStorage and
 * forwards it to the background so the extension auto-connects without the
 * user having to sign in a second time.
 *
 * Content scripts share localStorage with the page (same origin), so this
 * works even though we're in an isolated JS world.
 */

const SUPABASE_KEY = "sb-joqeipjawrlnscdvsgna-auth-token";

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id?: string; email?: string };
}

function tryRelay() {
  const raw = localStorage.getItem(SUPABASE_KEY);
  if (!raw) return;

  let session: SupabaseSession;
  try {
    session = JSON.parse(raw) as SupabaseSession;
  } catch {
    return;
  }
  if (!session.access_token || !session.refresh_token) return;

  const expiresAt =
    typeof session.expires_at === "number"
      ? session.expires_at
      : Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);

  chrome.runtime
    .sendMessage({
      type: "platform/syncSession",
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt,
      email: session.user?.email ?? "",
      userId: session.user?.id ?? "",
    })
    .catch(() => {
      // Extension may not be ready — that's fine, next page load will retry.
    });
}

// Attempt on page load (handles already-signed-in users).
tryRelay();

// Small delay in case Supabase hydrates localStorage after DOMContentLoaded.
setTimeout(tryRelay, 800);

// React to sign-in events on OTHER tabs (storage event fires cross-tab).
window.addEventListener("storage", (e) => {
  if (e.key === SUPABASE_KEY) tryRelay();
});
