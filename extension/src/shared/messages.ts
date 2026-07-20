/**
 * Typed port-message envelopes between background ↔ side panel.
 */

import type { ChatMessage, ChatStopInfo, ProxyMessage } from "./chat";

/** Side panel → background: start streaming a chat turn. */
export interface SidePanelToBackgroundSend {
  type: "chat/send";
  /** Full conversation history to send to Claude (in proxy shape). */
  messages: ProxyMessage[];
  /** Client-assigned ID of the assistant placeholder to fill. */
  assistantMessageId: string;
  /** Verkefnamappan sem verkið vistast í (valin í veljara spjaldsins). */
  folder?: { id: string; name: string } | { skip: true };
}

/** Side panel → background: cancel the in-flight stream. */
export interface SidePanelToBackgroundAbort {
  type: "chat/abort";
}

/** Side panel → background: replace persisted conversation (e.g. on Clear). */
export interface SidePanelToBackgroundSetHistory {
  type: "chat/setHistory";
  messages: ChatMessage[];
}

/** Side panel → background: request current persisted conversation. */
export interface SidePanelToBackgroundLoad {
  type: "chat/load";
}

/** Side panel → background: user decided whether to allow a confirm request. */
export interface SidePanelToBackgroundConfirmResponse {
  type: "chat/confirmResponse";
  requestId: string;
  allow: boolean;
  /** Optional: persist as a domain allowance going forward. */
  rememberOrigin?: string;
}

export type SidePanelToBackground =
  | SidePanelToBackgroundSend
  | SidePanelToBackgroundAbort
  | SidePanelToBackgroundSetHistory
  | SidePanelToBackgroundLoad
  | SidePanelToBackgroundConfirmResponse;

/** Background → side panel: hydrate persisted conversation. */
export interface BackgroundToSidePanelHistory {
  type: "chat/history";
  messages: ChatMessage[];
}

/** Background → side panel: incremental assistant token. */
export interface BackgroundToSidePanelDelta {
  type: "chat/delta";
  assistantMessageId: string;
  text: string;
}

/** Background → side panel: a tool call was issued by the model. */
export interface BackgroundToSidePanelToolStart {
  type: "chat/toolStart";
  assistantMessageId: string;
  toolUseId: string;
  name: string;
  input: unknown;
  startedAt: string;
}

/** Background → side panel: a tool call returned a result. */
export interface BackgroundToSidePanelToolEnd {
  type: "chat/toolEnd";
  assistantMessageId: string;
  toolUseId: string;
  output: string;
  isError: boolean;
  finishedAt: string;
}

/** Background → side panel: stream completed normally. */
export interface BackgroundToSidePanelDone {
  type: "chat/done";
  assistantMessageId: string;
  info: ChatStopInfo;
}

/** Background → side panel: stream errored. */
export interface BackgroundToSidePanelError {
  type: "chat/error";
  assistantMessageId: string;
  errorType: string;
  message: string;
}

/** Background → side panel: needs confirmation before a tool runs. */
export interface BackgroundToSidePanelConfirmRequest {
  type: "chat/confirmRequest";
  requestId: string;
  toolName: string;
  prompt: string;
  /** If present, side panel can offer "always allow for <origin>". */
  allowAlways?: { kind: "domain"; origin: string };
}

export type BackgroundToSidePanel =
  | BackgroundToSidePanelHistory
  | BackgroundToSidePanelDelta
  | BackgroundToSidePanelToolStart
  | BackgroundToSidePanelToolEnd
  | BackgroundToSidePanelDone
  | BackgroundToSidePanelError
  | BackgroundToSidePanelConfirmRequest;

export const CHAT_PORT_NAME = "eva-insight/chat";
