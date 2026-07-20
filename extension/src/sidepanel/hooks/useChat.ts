/**
 * Owns the side panel's chat state. Connects to the background worker
 * via a long-lived Port, hydrates persisted history, dispatches sends,
 * and applies streamed deltas to the in-progress assistant message.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  CHAT_PORT_NAME,
  type BackgroundToSidePanel,
  type SidePanelToBackground,
} from "@/shared/messages";
import {
  newId,
  toProxyMessages,
  type ChatMessage,
  type ChatToolCall,
} from "@/shared/chat";

export interface ConfirmRequest {
  requestId: string;
  toolName: string;
  prompt: string;
  allowAlways?: { kind: "domain"; origin: string };
}

interface State {
  messages: ChatMessage[];
  streaming: boolean;
  hydrated: boolean;
  pendingConfirm: ConfirmRequest | null;
}

type Action =
  | { type: "hydrate"; messages: ChatMessage[] }
  | { type: "addUser"; userMessage: ChatMessage; placeholder: ChatMessage }
  | { type: "delta"; id: string; text: string }
  | {
      type: "toolStart";
      id: string;
      call: ChatToolCall;
    }
  | {
      type: "toolEnd";
      id: string;
      toolUseId: string;
      output: string;
      isError: boolean;
      finishedAt: string;
    }
  | { type: "done"; id: string }
  | { type: "error"; id: string; message: string }
  | { type: "clear" }
  | { type: "confirmRequest"; request: ConfirmRequest }
  | { type: "confirmClear" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "hydrate":
      return {
        messages: action.messages,
        streaming: false,
        hydrated: true,
        pendingConfirm: null,
      };
    case "addUser":
      return {
        ...state,
        messages: [...state.messages, action.userMessage, action.placeholder],
        streaming: true,
      };
    case "delta": {
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, text: m.text + action.text } : m,
        ),
      };
    }
    case "toolStart": {
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, toolCalls: [...(m.toolCalls ?? []), action.call] }
            : m,
        ),
      };
    }
    case "toolEnd": {
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? {
                ...m,
                toolCalls: (m.toolCalls ?? []).map((c) =>
                  c.id === action.toolUseId
                    ? {
                        ...c,
                        output: action.output,
                        isError: action.isError,
                        finishedAt: action.finishedAt,
                      }
                    : c,
                ),
              }
            : m,
        ),
      };
    }
    case "done": {
      return {
        ...state,
        streaming: false,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, streaming: false } : m,
        ),
      };
    }
    case "error": {
      return {
        ...state,
        streaming: false,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, streaming: false, error: action.message }
            : m,
        ),
      };
    }
    case "clear":
      return {
        messages: [],
        streaming: false,
        hydrated: true,
        pendingConfirm: null,
      };
    case "confirmRequest":
      return { ...state, pendingConfirm: action.request };
    case "confirmClear":
      return { ...state, pendingConfirm: null };
  }
}

export function useChat() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    streaming: false,
    hydrated: false,
    pendingConfirm: null,
  });

  const portRef = useRef<chrome.runtime.Port | null>(null);

  // Establish + maintain the port connection.
  useEffect(() => {
    let port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
    portRef.current = port;

    const onMessage = (raw: BackgroundToSidePanel) => {
      switch (raw.type) {
        case "chat/history":
          dispatch({ type: "hydrate", messages: raw.messages });
          break;
        case "chat/delta":
          dispatch({ type: "delta", id: raw.assistantMessageId, text: raw.text });
          break;
        case "chat/toolStart":
          dispatch({
            type: "toolStart",
            id: raw.assistantMessageId,
            call: {
              id: raw.toolUseId,
              name: raw.name,
              input: raw.input,
              startedAt: raw.startedAt,
            },
          });
          break;
        case "chat/toolEnd":
          dispatch({
            type: "toolEnd",
            id: raw.assistantMessageId,
            toolUseId: raw.toolUseId,
            output: raw.output,
            isError: raw.isError,
            finishedAt: raw.finishedAt,
          });
          break;
        case "chat/done":
          dispatch({ type: "done", id: raw.assistantMessageId });
          break;
        case "chat/error":
          dispatch({
            type: "error",
            id: raw.assistantMessageId,
            message: raw.message,
          });
          break;
        case "chat/confirmRequest":
          dispatch({
            type: "confirmRequest",
            request: {
              requestId: raw.requestId,
              toolName: raw.toolName,
              prompt: raw.prompt,
              allowAlways: raw.allowAlways,
            },
          });
          break;
      }
    };

    port.onMessage.addListener(onMessage);
    const onDisconnect = () => {
      // Service worker likely went idle. Reconnect lazily on next send.
      portRef.current = null;
    };
    port.onDisconnect.addListener(onDisconnect);

    post(port, { type: "chat/load" });

    return () => {
      try {
        port.disconnect();
      } catch {
        // ignore — already disconnected
      }
      portRef.current = null;
    };
  }, []);

  // Persist conversation to the background whenever it changes (debounced
  // by React's batching). Skips while hydrating to avoid clobbering with
  // an empty array.
  useEffect(() => {
    if (!state.hydrated) return;
    chrome.runtime
      .sendMessage({ type: "chat/persist", messages: state.messages })
      .catch(() => {
        // SW may be reloading — next change will re-persist.
      });
  }, [state.messages, state.hydrated]);

  const ensurePort = useCallback((): chrome.runtime.Port => {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
    portRef.current = port;
    // Re-attach listener so deltas after a reconnect still apply.
    port.onMessage.addListener((raw: BackgroundToSidePanel) => {
      switch (raw.type) {
        case "chat/delta":
          dispatch({
            type: "delta",
            id: raw.assistantMessageId,
            text: raw.text,
          });
          break;
        case "chat/toolStart":
          dispatch({
            type: "toolStart",
            id: raw.assistantMessageId,
            call: {
              id: raw.toolUseId,
              name: raw.name,
              input: raw.input,
              startedAt: raw.startedAt,
            },
          });
          break;
        case "chat/toolEnd":
          dispatch({
            type: "toolEnd",
            id: raw.assistantMessageId,
            toolUseId: raw.toolUseId,
            output: raw.output,
            isError: raw.isError,
            finishedAt: raw.finishedAt,
          });
          break;
        case "chat/done":
          dispatch({ type: "done", id: raw.assistantMessageId });
          break;
        case "chat/error":
          dispatch({
            type: "error",
            id: raw.assistantMessageId,
            message: raw.message,
          });
          break;
        case "chat/confirmRequest":
          dispatch({
            type: "confirmRequest",
            request: {
              requestId: raw.requestId,
              toolName: raw.toolName,
              prompt: raw.prompt,
              allowAlways: raw.allowAlways,
            },
          });
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    return port;
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || state.streaming) return;

      const now = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: newId("u"),
        role: "user",
        text: trimmed,
        createdAt: now,
      };
      const placeholder: ChatMessage = {
        id: newId("a"),
        role: "assistant",
        text: "",
        createdAt: now,
        streaming: true,
      };

      dispatch({ type: "addUser", userMessage, placeholder });

      const port = ensurePort();
      const proxyMessages = toProxyMessages([
        ...state.messages,
        userMessage,
      ]);
      post(port, {
        type: "chat/send",
        messages: proxyMessages,
        assistantMessageId: placeholder.id,
        folder: folderRef.current ?? undefined,
      });
    },
    [ensurePort, state.messages, state.streaming],
  );

  // Verkefnamappa samtalsins, valin í veljaranum fyrir fyrsta skeytið.
  const [folder, setFolderState] = useState<
    { id: string; name: string } | { skip: true } | null
  >(null);
  const folderRef = useRef<{ id: string; name: string } | { skip: true } | null>(null);
  const setFolder = useCallback(
    (f: { id: string; name: string } | { skip: true } | null) => {
      folderRef.current = f;
      setFolderState(f);
    },
    [],
  );

  const abort = useCallback(() => {
    const port = portRef.current;
    if (!port) return;
    post(port, { type: "chat/abort" });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: "clear" });
    folderRef.current = null;
    setFolderState(null);
    chrome.runtime
      .sendMessage({ type: "chat/persist", messages: [] })
      .catch(() => {});
  }, []);

  const decideConfirm = useCallback(
    (requestId: string, allow: boolean, rememberOrigin?: string) => {
      const port = portRef.current;
      if (port) {
        post(port, {
          type: "chat/confirmResponse",
          requestId,
          allow,
          rememberOrigin,
        });
      }
      dispatch({ type: "confirmClear" });
    },
    [],
  );

  return {
    messages: state.messages,
    streaming: state.streaming,
    hydrated: state.hydrated,
    pendingConfirm: state.pendingConfirm,
    send,
    abort,
    clear,
    decideConfirm,
    folder,
    setFolder,
  };
}

function post(port: chrome.runtime.Port, msg: SidePanelToBackground): void {
  try {
    port.postMessage(msg);
  } catch (err) {
    console.warn("[eva-insight] post failed", err);
  }
}
