/**
 * Push a completed browser session to the Eva Innsýn platform.
 *
 * Maps Eva Insight's captured tool actions into the platform's ingest shape and
 * POSTs them to /api/extension/session with the user's Supabase access token.
 * A no-op when the user hasn't connected their account or the turn had no
 * actions, so non-connected users are unaffected.
 */

import { PLATFORM, type SessionAction } from "../shared/platform";
import { getAccessToken } from "./platform-auth";

export interface SessionPayload {
  title: string;
  actions: SessionAction[];
  startedAt?: string;
  endedAt?: string;
  /** Verkefnamappan (projects.id) sem lotan vistast í. */
  projectId?: string;
  /**
   * Short overview for Lotur: what was needed and what got done. Built locally
   * from text we already have (no AI call) — the platform stores it directly
   * and skips its paid AI summary.
   */
  summary?: string;
}

export type PushResult =
  | { ok: true; sessionId: string; actionsStored: number }
  | {
      ok: false;
      reason: "not_connected" | "no_actions" | "error";
      message?: string;
    };

export async function pushSession(
  payload: SessionPayload,
): Promise<PushResult> {
  if (payload.actions.length === 0) return { ok: false, reason: "no_actions" };

  const token = await getAccessToken();
  if (!token) return { ok: false, reason: "not_connected" };

  try {
    const res = await fetch(`${PLATFORM.apiUrl}${PLATFORM.sessionIngestPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        project_id: payload.projectId,
        title: payload.title.slice(0, 200) || "Eva Innsýn session",
        // Platform caps actions at 500 and validates each shape.
        actions: payload.actions.slice(0, 500).map((a) => ({
          type: a.type.slice(0, 60),
          description: a.description ? a.description.slice(0, 2000) : undefined,
        })),
        started_at: payload.startedAt,
        ended_at: payload.endedAt,
        summary: payload.summary ? payload.summary.slice(0, 2000) : undefined,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: { sessionId?: string; actionsStored?: number };
      error?: string;
    };

    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: body.error || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      sessionId: body.data?.sessionId ?? "",
      actionsStored: body.data?.actionsStored ?? payload.actions.length,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a short human description of a tool action for the session log. */
export function describeAction(
  name: string,
  input: unknown,
): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (name) {
    case "navigate":
    case "tabs_create":
      return str(i.url);
    case "click":
    case "scroll_to":
      return str(i.element_id);
    case "type":
      return clip(`"${str(i.text) ?? ""}" → ${str(i.element_id) ?? ""}`);
    case "form_input":
      return clip(`"${str(i.value) ?? ""}" → ${str(i.element_id) ?? ""}`);
    case "scroll":
      return str(i.direction);
    case "javascript_eval":
      return clip(str(i.script) ?? "");
    case "tabs_switch":
    case "tabs_close":
      return typeof i.tab_id === "number" ? `tab ${i.tab_id}` : undefined;
    case "click_at_coordinate":
    case "double_click_at_coordinate":
      return typeof i.x === "number" && typeof i.y === "number"
        ? `(${Math.round(i.x)}, ${Math.round(i.y)})`
        : undefined;
    case "type_at_cursor":
      return clip(`"${str(i.text) ?? ""}"`);
    case "key_press":
      return str(i.key);
    case "wait":
      return typeof i.ms === "number" ? `${i.ms}ms` : undefined;
    default:
      return undefined;
  }
}

function clip(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
