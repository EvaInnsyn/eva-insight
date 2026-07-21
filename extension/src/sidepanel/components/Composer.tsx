import { useRef, useState, type KeyboardEvent, type ClipboardEvent, type DragEvent } from "react";
import type { ChatAttachment } from "@/shared/chat";
import {
  pdfToAttachment,
  docxToAttachment,
  textFileToAttachment,
  MAX_PDF_BYTES,
} from "../lib/attachments";

interface Props {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  disabledReason?: string;
}

const MAX_ATTACHMENTS = 4;
const MAX_EDGE = 1280; // Anthropic reads best under ~1568px; keep well within.

const ACCEPT = "image/*,.pdf,.docx,.txt,.md,.csv";

/** Downscale + JPEG-compress a file into a lightweight base64 (no data prefix). */
async function fileToChatImage(file: File): Promise<ChatAttachment | null> {
  if (!file.type.startsWith("image/")) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return null;
  }
  // White matte so transparent PNGs don't turn black under JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const base64 = dataUrl.split(",")[1] ?? "";
  if (!base64) return null;
  return { kind: "image", mime: "image/jpeg", base64 };
}

/** Flokkar skrá í rétt viðhengi eftir tegund. */
async function fileToAttachment(file: File): Promise<ChatAttachment | null> {
  if (file.type.startsWith("image/")) return fileToChatImage(file);
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return pdfToAttachment(file);
  }
  if (name.endsWith(".docx")) return docxToAttachment(file);
  if (
    file.type.startsWith("text/") ||
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".csv")
  ) {
    return textFileToAttachment(file);
  }
  return null;
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  disabledReason,
}: Props) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return;
    setAttachNote(null);
    const picked = Array.from(files).slice(0, room);
    const converted: ChatAttachment[] = [];
    const failed: string[] = [];
    for (const f of picked) {
      const a = await fileToAttachment(f);
      if (a) converted.push(a);
      else failed.push(f.name);
    }
    if (converted.length > 0) setAttachments((prev) => [...prev, ...converted]);
    if (failed.length > 0) {
      setAttachNote(
        `Gat ekki lesið: ${failed.join(", ")}. Studdar tegundir: myndir, PDF (að ${Math.round(MAX_PDF_BYTES / 1_000_000)}MB), Word (.docx) og textaskrár.`,
      );
    }
  };

  const submit = () => {
    if (disabled || streaming) return;
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    onSend(text, attachments);
    setValue("");
    setAttachments([]);
    setAttachNote(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  };

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
  };

  const canSend = !disabled && !streaming && (value.trim().length > 0 || attachments.length > 0);

  return (
    <div
      className={`eva-composer${dragOver ? " eva-composer-dragover" : ""}`}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {disabled && disabledReason ? (
        <div className="eva-composer-disabled-note">{disabledReason}</div>
      ) : null}

      {attachments.length > 0 && (
        <div className="eva-composer-thumbs">
          {attachments.map((a, i) => (
            <span
              key={i}
              className={a.kind === "image" ? "eva-composer-thumb" : "eva-composer-file"}
            >
              {a.kind === "image" ? (
                <img src={`data:${a.mime};base64,${a.base64}`} alt="" />
              ) : (
                <span className="eva-composer-file-name">📄 {a.name}</span>
              )}
              <button
                type="button"
                aria-label="Fjarlægja viðhengi"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {attachNote && <div className="eva-composer-disabled-note">{attachNote}</div>}

      <div className="eva-composer-row">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="eva-btn eva-btn-attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || streaming || attachments.length >= MAX_ATTACHMENTS}
          aria-label="Bæta við mynd eða skjali"
          title="Bæta við mynd eða skjali (PDF, Word, texti)"
        >
          <PlusIcon />
        </button>
        <textarea
          ref={textareaRef}
          className="eva-input"
          placeholder={
            disabled
              ? "Configure settings to start chatting"
              : streaming
                ? "Streaming…"
                : "Skrifaðu, eða settu inn mynd eða skjal…"
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onInput={onInput}
          disabled={disabled}
          rows={1}
        />
        {streaming ? (
          <button
            type="button"
            className="eva-btn eva-btn-stop"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="eva-btn eva-btn-send"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12l14-7-7 14-2-5-5-2z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
