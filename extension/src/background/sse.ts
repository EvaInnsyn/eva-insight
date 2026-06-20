/**
 * Minimal SSE parser for fetch() bodies.
 *
 * Server-Sent Events are framed by blank lines. Each frame may contain
 * `event:`, `data:`, `id:`, and `retry:` fields. We yield `{ event, data }`
 * pairs once the blank-line terminator arrives.
 *
 * The proxy guarantees one JSON-encoded `data:` per event, so we don't
 * need to handle multi-line data joining for our case — but we do it
 * correctly anyway in case Anthropic ever splits events.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = indexOfBoundary(buffer)) !== -1) {
        const frame = buffer.slice(0, boundary);
        // Skip the boundary itself (either "\n\n" or "\r\n\r\n").
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }

    // Flush trailing frame if the stream ended cleanly without a terminator.
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      const ev = parseFrame(trailing);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function indexOfBoundary(s: string): number {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine;
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
