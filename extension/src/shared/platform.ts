/**
 * Eva Innsýn platform connection — shared config & message types.
 *
 * These are the platform's PUBLIC values. The Supabase anon key is designed to
 * ship in client code; Row Level Security governs all data access. The
 * extension signs the user in (email/password) to obtain a short-lived access
 * token, then sends captured browser sessions to the platform ingest endpoint
 * so they appear in the dashboard (Lotur) with an AI summary.
 */

export const PLATFORM = {
  /** Eva Innsýn platform base URL (Vercel production). */
  apiUrl: "https://eva-innsyn.vercel.app",
  /** Path that ingests one browser session + its actions. */
  sessionIngestPath: "/api/extension/session",
  /** Returns proxy URL + token for authenticated users. */
  configPath: "/api/extension/config",
  /** Möppulisti fyrir veljara viðbótarinnar. */
  foldersPath: "/api/extension/folders",
  /** Minni Evu úr einni möppu (síðustu lotur). */
  folderMemoryPath: (id: string) => `/api/extension/folders/${id}/memory`,
  /** Vista skrá (af vefslóð) beint í verkefnamöppu. */
  folderUploadPath: (id: string) => `/api/extension/folders/${id}/upload`,
  /** Supabase project URL (same project the platform uses). */
  supabaseUrl: "https://joqeipjawrlnscdvsgna.supabase.co",
  /** Supabase anon key — public by design; RLS enforces all access. */
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpvcWVpcGphd3JsbnNjZHZzZ25hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0MzU1NDksImV4cCI6MjA5NDAxMTU0OX0.5sjLYZEgt-I0sUww88eTsZYjjBkp6K5tin4cX90TLTs",
} as const;

/** Storage key for the platform auth tokens (chrome.storage.local). */
export const PLATFORM_AUTH_KEY = "eva-insight/platform-auth";

/** Connection state surfaced to the UI (never includes tokens). */
export interface PlatformStatus {
  connected: boolean;
  email?: string;
}

/** One recorded action in a session (mirrors the platform's sessionActionSchema). */
export interface SessionAction {
  type: string;
  description?: string;
}

// --- Side panel ↔ background messages (via chrome.runtime.sendMessage) ------

export type PlatformRequest =
  | { type: "platform/signIn"; email: string; password: string }
  | { type: "platform/signOut" }
  | { type: "platform/status" };

export type PlatformResponse =
  | { ok: true; status: PlatformStatus }
  | { ok: false; error: string };
