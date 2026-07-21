/**
 * Viðhengi í spjallið: myndir, PDF, Word og textaskrár.
 *
 * - Myndir fara sem image-blokkir (minnkað í Composer).
 * - PDF fer HEILT sem document-blokk, módelið les blaðsíðurnar sjálft.
 * - .docx er opnað hér (docx er zip): word/document.xml afþjappað með
 *   DecompressionStream og XML-ið strípað í hreinan texta.
 * - Textaskrár (.txt/.md/.csv) eru lesnar beint.
 */

import type { ChatAttachment } from "@/shared/chat";
export type { ChatAttachment };

export const MAX_PDF_BYTES = 6 * 1024 * 1024; // 6MB — vel innan API-marka
export const MAX_DOC_CHARS = 30_000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

/** Les PDF sem base64 (heilt skjal, módelið sér blaðsíðurnar). */
export async function pdfToAttachment(file: File): Promise<ChatAttachment | null> {
  if (file.size === 0 || file.size > MAX_PDF_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { kind: "pdf", name: file.name, base64: bytesToBase64(bytes) };
}

/** Les textaskrá (txt/md/csv) beint. */
export async function textFileToAttachment(file: File): Promise<ChatAttachment | null> {
  const text = (await file.text()).slice(0, MAX_DOC_CHARS).trim();
  if (!text) return null;
  return { kind: "doc", name: file.name, text };
}

// ── .docx: lágmarks ZIP-lesari + XML-stríp ───────────────────────────────────

function readU16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

/** Les central directory úr enda zip-skrárinnar (traustara en raðlestur). */
function zipEntries(bytes: Uint8Array): ZipEntry[] {
  // EOCD-signatúr 0x06054b50, leitað aftast (síðustu 64KB + 22).
  const tail = Math.max(0, bytes.length - 65_558);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= tail; i--) {
    if (readU32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = readU16(bytes, eocd + 10);
  let off = readU32(bytes, eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (readU32(bytes, off) !== 0x02014b50) break;
    const method = readU16(bytes, off + 10);
    const compSize = readU32(bytes, off + 20);
    const nameLen = readU16(bytes, off + 28);
    const extraLen = readU16(bytes, off + 30);
    const commentLen = readU16(bytes, off + 32);
    const localOffset = readU32(bytes, off + 42);
    const name = new TextDecoder().decode(
      bytes.subarray(off + 46, off + 46 + nameLen),
    );
    out.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[  ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Dregur textann úr .docx skjali. Skilar null ef skjalið er ólesanlegt. */
export async function docxToAttachment(file: File): Promise<ChatAttachment | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entry = zipEntries(bytes).find((e) => e.name === "word/document.xml");
    if (!entry) return null;
    // Local header: sleppa nafni + extra til að finna gögnin sjálf.
    const lo = entry.localOffset;
    if (readU32(bytes, lo) !== 0x04034b50) return null;
    const nameLen = readU16(bytes, lo + 26);
    const extraLen = readU16(bytes, lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const comp = bytes.subarray(start, start + entry.compSize);
    const xmlBytes = entry.method === 8 ? await inflateRaw(comp) : comp;
    const text = docxXmlToText(new TextDecoder().decode(xmlBytes)).slice(0, MAX_DOC_CHARS);
    if (!text) return null;
    return { kind: "doc", name: file.name, text };
  } catch {
    return null;
  }
}
