/**
 * Persisted conversation state.
 *
 * Lives in chrome.storage.local so the conversation SURVIVES browser
 * restarts (storage.session was wiped every time Chrome closed — clients
 * lost their thread with Eva daily).
 *
 * Screenshots make history huge (hundreds of KB of base64 per shot), so on
 * every save we strip base64 image payloads out of stored tool outputs and
 * cap the message count. The model never reads this store — the agent loop
 * takes fresh screenshots as it works — so nothing functional is lost.
 */

import type { ChatMessage } from "../shared/chat";

const KEY = "eva-insight/conversation";
const LEGACY_SESSION_KEY = "eva-insight/conversation";
const MAX_MESSAGES = 80;

/** Replace base64 image payloads inside a stored tool output string. */
function stripImagePayload(output: string | undefined): string | undefined {
  if (!output || output.length < 10_000 || !output.includes('"base64"')) {
    return output;
  }
  try {
    const parsed = JSON.parse(output) as { base64?: unknown; [k: string]: unknown };
    if (typeof parsed.base64 === "string") {
      parsed.base64 = "";
      parsed._stripped = "screenshot removed from saved history";
      return JSON.stringify(parsed);
    }
  } catch {
    // not JSON — keep as-is
  }
  return output;
}

function sanitize(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_MESSAGES).map((m) => {
    let out = m;
    if (m.toolCalls?.length) {
      out = {
        ...out,
        toolCalls: m.toolCalls.map((c) => ({
          ...c,
          output: stripImagePayload(c.output),
        })),
      };
    }
    // PDF-viðhengi eru MB að stærð — geyma nafnið en sleppa gögnunum.
    if (m.attachments?.some((a) => a.kind === "pdf" && a.base64.length > 0)) {
      out = {
        ...out,
        attachments: m.attachments.map((a) =>
          a.kind === "pdf" ? { ...a, base64: "" } : a,
        ),
      };
    }
    return out;
  });
}

export async function loadHistory(): Promise<ChatMessage[]> {
  const raw = await chrome.storage.local.get(KEY);
  let stored = raw[KEY];
  if (!Array.isArray(stored)) {
    // One-time migration from the old session-scoped store.
    try {
      const legacy = await chrome.storage.session.get(LEGACY_SESSION_KEY);
      stored = legacy[LEGACY_SESSION_KEY];
    } catch {
      stored = undefined;
    }
  }
  return Array.isArray(stored) ? (stored as ChatMessage[]) : [];
}

export async function saveHistory(messages: ChatMessage[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: sanitize(messages) });
  } catch {
    // Quota exceeded despite sanitizing — drop the oldest half and retry.
    const half = sanitize(messages.slice(Math.floor(messages.length / 2)));
    await chrome.storage.local.set({ [KEY]: half }).catch(() => {});
  }
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
