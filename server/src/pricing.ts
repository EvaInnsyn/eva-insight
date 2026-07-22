/**
 * Cost of Eva's work, in ISK — the currency of the credit system.
 *
 * costIsk = raw Anthropic cost (per-model $/1M tokens) × USD→ISK × multiplier.
 * The multiplier normally comes from the user's verðþrep (tiers.ts:
 * fjölskylda 1/0.9, vinir 1/0.8, almennt 1/0.7); EVA_CREDIT_MARKUP remains
 * only as the fallback when no tier is passed. EVA_USD_ISK (default 140)
 * stays a Railway env knob so Vigdís can track the exchange rate.
 */

/** $ per 1M tokens [input, output]. Unknown/legacy (null) rows use Sonnet. */
export const MODEL_PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [3, 15],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
};
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

/** What a request costs the user's credit, in ISK. */
export function costIsk(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  multiplier: number = creditMarkup(),
): number {
  return costUsd(model, inputTokens, outputTokens) * usdIskRate() * multiplier;
}
