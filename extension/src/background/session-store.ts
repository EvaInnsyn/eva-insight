/**
 * Persisted conversation state.
 *
 * Phase 2 uses a single global conversation key in chrome.storage.session
 * so the chat survives service-worker termination but resets on browser
 * restart. Phase 5+ will key by tab and offer named threads.
 */

import type { ChatMessage } from "../shared/chat";

const KEY = "eva-insight/conversation";

export async function loadHistory(): Promise<ChatMessage[]> {
  const raw = await chrome.storage.session.get(KEY);
  const stored = raw[KEY];
  return Array.isArray(stored) ? (stored as ChatMessage[]) : [];
}

export async function saveHistory(messages: ChatMessage[]): Promise<void> {
  await chrome.storage.session.set({ [KEY]: messages });
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
