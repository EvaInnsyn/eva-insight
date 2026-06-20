/**
 * Settings stored in chrome.storage.local. Phase 2 keeps it simple:
 * proxy URL and shared secret. Phase 6 replaces the secret with a
 * device-pair token.
 */

export interface EvaSettings {
  proxyUrl: string;
  sharedSecret: string;
  /** Origins (https://example.com) pre-approved for navigate/tabs_create. */
  allowedDomains: string[];
}

const KEY = "eva-insight/settings";

const DEFAULTS: EvaSettings = {
  proxyUrl: "http://localhost:8787",
  sharedSecret: "",
  allowedDomains: [],
};

export async function readSettings(): Promise<EvaSettings> {
  const raw = await chrome.storage.local.get(KEY);
  const stored = (raw[KEY] ?? {}) as Partial<EvaSettings>;
  return { ...DEFAULTS, ...stored };
}

export async function writeSettings(next: EvaSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: next });
}

export function isConfigured(s: EvaSettings): boolean {
  return s.proxyUrl.trim().length > 0 && s.sharedSecret.trim().length > 0;
}
