import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/shared/chat";
import { Message } from "./Message";

export function ChatList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="eva-empty">
        <img src="/eye-large.png" alt="" className="eva-empty-eye" />
        <div className="eva-empty-headline">Eva, your digital employee.</div>
        <div className="eva-empty-sub">
          Can switch from marketer to accountant to developer to HR manager instantly.
        </div>
      </div>
    );
  }

  return (
    <div className="eva-list">
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
