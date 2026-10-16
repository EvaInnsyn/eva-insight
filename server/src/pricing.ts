/**
 * Cost of Eva's work, in ISK — the currency of the credit system.
 *
 * costIsk = raw Anthropic cost (per-model $/1M tokens) × USD→ISK × multiplier.
 * The multiplier normally comes from the user's verðþrep (tiers.ts:
 * fjölskylda 1/0.9, vinir 1/0.8, almennt 1/0.5 frá 12. ágúst 2026 — almennt
 * var 1/0.7 fram að nýju verðskránni og þessi athugasemd sagði það áfram
 * fram í 15. ágúst); EVA_CREDIT_MARKUP remains only as the fallback when no
 * tier is passed. EVA_USD_ISK (default 140) stays a Railway env knob so
 * Vigdís can track the exchange rate.
 *
 * TIERS.ts er sannleikurinn um framlegðina, ekki þessi athugasemd. Ef þau
 * stangast á, trúðu tiers.ts.
 */

/** $ per 1M tokens [input, output]. Unknown/legacy (null) rows use Sonnet. */
export const MODEL_PRICES: Record<string, [number, number]> = {
  // $2/$10 (opinber verðskrá claude.com/pricing, staðfest 16.10.2026). Stóð
  // $3/$15 frá 18.7 — verð Sonnet 4.6 — sem ofmat raunkostnaðinn um 50 % og
  // brenndi inneign 1,5× hraðar en álagið (verðþrepið) segir til um.
  "claude-sonnet-5": [2, 10],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
  // OpenAI — valkvætt módel í Evu-spjallinu frá 27. ágúst 2026.
  // ATH: verðin eru af OpenAI-verðskrá og verða að vera uppfærð þar sem
  // þau breytast, alveg eins og Anthropic-verðin hér að ofan. Rangt verð
  // hér þýðir ranga krónutölu á reikningi viðskiptavinar.
  "gpt-5": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
};

/** Er þetta OpenAI-módel? Ræður hvor leiðin er farin í /v1/chat. */
export function isOpenAiModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith("gpt-");
}
export const DEFAULT_PRICE: [number, number] = [3, 15];

export function priceOf(model: string | null | undefined): [number, number] {
  return (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
}

export function costUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const [inP, outP] = priceOf(model);
  return (inputTokens / 1_000_000) * inP + (outputTokens / 1_000_000) * outP;
}

export function usdIskRate(): number {
  const v = Number(process.env.EVA_USD_ISK);
  return Number.isFinite(v) && v > 0 ? v : 140;
}

export function creditMarkup(): number {
  const v = Number(process.env.EVA_CREDIT_MARKUP);
  return Number.isFinite(v) && v > 0 ? v : 2;
}

/**
 * Cache-tokens (áskriftarkerfi 2b-3, 17.10.2026). Opinber verðskrá Anthropic:
 * skrif í cache kosta 1,25× inntaksverð (5 mín. líftími, sem spjallið notar),
 * lestur 0,1× — nema Opus 5.5 (0,05×) og Fable 5.1 (0,025×). Fram að 2b-3
 * verðlagði proxyinn cache-tokens alls ekki (vanmat) en platformurinn á
 * FULLU inntaksverði (ofmat lestrar ×10). Sama regla á báðum stöðum frá nú.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER: Record<string, number> = {
  "claude-opus-5-5": 0.05,
  "claude-fable-5-1": 0.025,
};
export function cacheReadMultiplier(model: string | null | undefined): number {
  return model && model in CACHE_READ_MULTIPLIER ? CACHE_READ_MULTIPLIER[model] : 0.1;
}

/**
 * Raunkostnaður kalls í $ með cache-tokens. `inputTokens` er FERSKT inntak
 * (Anthropic telur cache-tokens sér, ekki í input_tokens).
 */
export function costUsdWithCache(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const [inP] = priceOf(model);
  return (
    costUsd(model, inputTokens, outputTokens) +
    (cacheWriteTokens / 1_000_000) * inP * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / 1_000_000) * inP * cacheReadMultiplier(model)
  );
}

/** Raunkostnaður kalls í kr (×1), með cache-tokens. */
export function rawCostIsk(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  return costUsdWithCache(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) * usdIskRate();
}

/** What a request costs the user's credit, in ISK. */
export function costIsk(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  multiplier: number = creditMarkup(),
): number {
  return costUsd(model, inputTokens, outputTokens) * usdIskRate() * multiplier;
}
