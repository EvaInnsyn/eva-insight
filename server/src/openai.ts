/**
 * ChatGPT-leiðin í /v1/chat — valkvætt módel í Evu-spjallinu.
 *
 * Ósk Vigdísar 27. ágúst 2026: notandinn velur sjálfur hvort hann talar við
 * Claude eða ChatGPT. Ástæðan er ÍSLENSKAN — ChatGPT var þegar tekinn inn í
 * yfirlestrarlagið á platforminum af sömu ástæðu.
 *
 * ÞRENNT SEM MÁTTI EKKI BREYTAST og gerði það ekki:
 *
 * 1. **Anthropic-leiðin er ósnert.** Chrome-viðbótin notar sama enda og
 *    sendir aldrei `gpt-`-módel, svo hún fer aldrei hingað inn.
 * 2. **Straumurinn lítur EINS út fyrir vafranum.** Við þýðum svar OpenAI
 *    yfir í sömu SSE-atburði og Anthropic sendir (`content_block_delta` með
 *    `delta.text`), svo `lib/eva/chat.ts` þurfti enga breytingu.
 * 3. **Mælingin er óbreytt.** Hún tekur bara `model` + tokens, og
 *    `MODEL_PRICES` kann nú gpt-verðin. Sama gjaldfærsla, sama álag, sami
 *    sameiginlegi pottur.
 *
 * OpenAI kann hvorki `thinking`, `tools` á Anthropic-sniði né
 * `output_config`; þau eru einfaldlega ekki send áfram.
 */

/** Myndablokk eins og Anthropic sendir hana — spjaldið sendir skjáskot svona. */
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
interface AnthropicTextBlock {
  type: "text";
  text: string;
}
type AnthropicBlock = AnthropicImageBlock | AnthropicTextBlock | { type: string };

interface OpenAiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAiContentPart[];
}

/** Anthropic-system (strengur EÐA blokkir) → einn system-strengur. */
export function systemToText(
  system: string | { type?: string; text?: string }[] | undefined,
): string | null {
  if (!system) return null;
  if (typeof system === "string") return system.trim() || null;
  const joined = system
    .map((b) => (b && typeof b.text === "string" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return joined.trim() || null;
}

/**
 * Anthropic-skilaboð → OpenAI-skilaboð.
 *
 * Myndir eru á ólíku sniði hjá birgjunum: Anthropic tekur base64 í
 * `source`, OpenAI tekur `data:`-slóð. Skjáskot sem notandinn límir inn
 * fer því í gegnum þessa þýðingu, annars sæi ChatGPT hana aldrei.
 */
/**
 * Skjá-kafli spjaldsins í kerfisskeytinu. GPT-módel eiga það til að hunsa
 * efni í miðju system-skeyti og fullyrða að þau „sjái ekki skjáinn" þótt
 * textinn standi þar (Vigdís, 10. sept). Kaflinn er því klipptur úr system
 * og skeytt framan á SÍÐASTA notandaskeytið — þar taka GPT-módel eftir
 * honum. Gerist í hverri umbreytingu fyrir sig svo spjallsagan mengast
 * aldrei, og Anthropic-leiðin er ósnert. Þolir bæði nýja sniðið (skýringin
 * inni í kaflanum) og það eldra (skýringar-málsgrein á eftir `=== END ===`).
 */
const SCREEN_SECTION_RE =
  /\n*=== WHAT IS ON THE USER'S SCREEN RIGHT NOW ===\n[\s\S]*?\n=== END ===(?:\n\nThis is the text of the page[\s\S]*?(?=\n\n|$))?/;

export function toOpenAiMessages(
  messages: { role: string; content: unknown }[],
  system: string | null,
): OpenAiMessage[] {
  let sys = system;
  let screen: string | null = null;
  if (sys) {
    const m = sys.match(SCREEN_SECTION_RE);
    if (m) {
      screen = m[0].trim();
      sys = sys.replace(SCREEN_SECTION_RE, "\n\n").replace(/\n{3,}/g, "\n\n").trim() || null;
    }
  }

  const out: OpenAiMessage[] = [];
  if (sys) out.push({ role: "system", content: sys });

  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      out.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const parts: OpenAiContentPart[] = [];
    for (const raw of m.content as AnthropicBlock[]) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type === "text" && typeof (raw as AnthropicTextBlock).text === "string") {
        parts.push({ type: "text", text: (raw as AnthropicTextBlock).text });
      } else if (raw.type === "image") {
        const src = (raw as AnthropicImageBlock).source;
        if (src?.type === "base64" && src.data) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
        }
      }
      // Aðrar blokkir (thinking, tool_use) eiga ekkert erindi til OpenAI.
    }
    if (parts.length > 0) out.push({ role, content: parts });
  }

  if (screen) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== "user") continue;
      const c = out[i].content;
      if (typeof c === "string") {
        out[i] = { role: "user", content: `${screen}\n\n${c}` };
      } else if (Array.isArray(c)) {
        out[i] = { role: "user", content: [{ type: "text", text: screen }, ...c] };
      }
      break;
    }
  }
  return out;
}

export interface OpenAiStreamHandlers {
  /** Textabútur — sendur áfram sem `content_block_delta`. */
  onText: (text: string) => Promise<void>;
  /** Kallað þegar notkunin liggur fyrir (síðasti bútur straumsins). */
  onUsage: (inputTokens: number, outputTokens: number) => void;
  /** Satt þegar viðskiptavinurinn hefur gefist upp — þá hættum við. */
  aborted: () => boolean;
}

/**
 * Keyrir ChatGPT-straum og réttir textabútana áfram.
 * Kastar við HTTP-villu svo kallarinn geti sent `error`-atburð eins og
 * Anthropic-leiðin gerir.
 */
export async function streamOpenAi(opts: {
  apiKey: string;
  model: string;
  messages: OpenAiMessage[];
  maxTokens: number;
  signal: AbortSignal;
  handlers: OpenAiStreamHandlers;
}): Promise<void> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      // Án þessa fylgir ENGIN notkun með straumnum og við gætum ekki
      // gjaldfært — sem þýðir að Eva ynni verkið og enginn borgaði.
      stream_options: { include_usage: true },
      max_completion_tokens: opts.maxTokens,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    const err = new Error(
      `openai ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (opts.handlers.aborted()) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frá OpenAI: „data: {...}" línur, aðskildar með auðri línu.
    let sep: number;
    while ((sep = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, sep).trim();
      buf = buf.slice(sep + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      let chunk: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const text = chunk.choices?.[0]?.delta?.content;
      if (text) await opts.handlers.onText(text);

      // Notkunin kemur í SÍÐASTA bútnum þegar include_usage er sett.
      if (chunk.usage) {
        opts.handlers.onUsage(
          chunk.usage.prompt_tokens ?? 0,
          chunk.usage.completion_tokens ?? 0,
        );
      }
    }
  }
}
