import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/shared/chat";
import { Message } from "./Message";

const SCROLL_THRESHOLD = 80;

export function ChatList({ messages }: { messages: ChatMessage[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distanceFromBottom > SCROLL_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll only when the user is already near the bottom.
  useEffect(() => {
    if (!userScrolledUp.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
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
    <div className="eva-list" ref={listRef}>
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
