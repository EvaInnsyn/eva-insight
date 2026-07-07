import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/shared/chat";
import { Message } from "./Message";

const SCROLL_THRESHOLD = 80;

/** New time chip after this much quiet (WhatsApp-style dividers). */
const DIVIDER_GAP_MS = 30 * 60 * 1000;

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "14:32" today · "Í gær 14:32" · "3. júl. 14:32" otherwise. */
function dividerLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString("is-IS", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Í gær ${time}`;
  const date = d.toLocaleDateString("is-IS", {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date} ${time}`;
}

/** Show a chip before the first message, after a quiet gap, or on a new day. */
function needsDivider(prev: ChatMessage | undefined, cur: ChatMessage): boolean {
  const t = Date.parse(cur.createdAt);
  if (Number.isNaN(t)) return false;
  if (!prev) return true;
  const p = Date.parse(prev.createdAt);
  if (Number.isNaN(p)) return true;
  return t - p > DIVIDER_GAP_MS || !sameDay(new Date(p), new Date(t));
}

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
      {messages.map((m, i) => (
        <div key={m.id}>
          {needsDivider(messages[i - 1], m) ? (
            <div className="eva-time-divider">
              <span>{dividerLabel(m.createdAt)}</span>
            </div>
          ) : null}
          <Message message={m} />
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
