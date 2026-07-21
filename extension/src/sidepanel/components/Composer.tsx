import { useRef, useState, type KeyboardEvent, type ClipboardEvent, type DragEvent } from "react";
import type { ChatImage } from "@/shared/chat";

interface Props {
  onSend: (text: string, images: ChatImage[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  disabledReason?: string;
}

const MAX_IMAGES = 4;
const MAX_EDGE = 1280; // Anthropic reads best under ~1568px; keep well within.

/** Downscale + JPEG-compress a file into a lightweight base64 (no data prefix). */
async function fileToChatImage(file: File): Promise<ChatImage | null> {
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
  return { mime: "image/jpeg", base64 };
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  disabledReason,
}: Props) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return;
    const picked = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, room);
    const converted = (await Promise.all(picked.map(fileToChatImage))).filter(
      (x): x is ChatImage => x !== null,
    );
    if (converted.length > 0) setImages((prev) => [...prev, ...converted]);
  };

  const submit = () => {
    if (disabled || streaming) return;
    const text = value.trim();
    if (!text && images.length === 0) return;
    onSend(text, images);
    setValue("");
    setImages([]);
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

  const canSend = !disabled && !streaming && (value.trim().length > 0 || images.length > 0);

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

      {images.length > 0 && (
        <div className="eva-composer-thumbs">
          {images.map((img, i) => (
            <span key={i} className="eva-composer-thumb">
              <img src={`data:${img.mime};base64,${img.base64}`} alt="" />
              <button
                type="button"
                aria-label="Fjarlægja mynd"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="eva-composer-row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
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
          disabled={disabled || streaming || images.length >= MAX_IMAGES}
          aria-label="Bæta við mynd"
          title="Bæta við mynd"
        >
          <ImageIcon />
        </button>
        <textarea
          ref={textareaRef}
          className="eva-input"
          placeholder={
            disabled
              ? "Configure settings to start chatting"
              : streaming
                ? "Streaming…"
                : "Skrifaðu eða settu inn mynd…"
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

function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
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
