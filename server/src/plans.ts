/**
 * Eva subscription plan definitions.
 *
 * Token caps are calculated at Sonnet 4.6 rates ($3 input / $15 output per 1M)
 * with an 80/20 input/output cost split to match observed extension usage.
 *
 *   INNSÝN  — 8.800 ISK/mo  — ~$45 API budget
 *   YFIRSÝN — 26.000 ISK/mo — ~$100 API budget
 *   UMSJÁ   — 58.000 ISK/mo — ~$150 API budget
 */

export type PlanId = "innsyn" | "yfirsyn" | "umsja";

export interface Plan {
  id: PlanId;
  displayName: string;
  priceIsk: number;
  apiCapUsd: number;
  monthlyCapInputTokens: number;
  monthlyCapOutputTokens: number;
}

export const PLANS: Record<PlanId, Plan> = {
  innsyn: {
    id: "innsyn",
    displayName: "INNSÝN",
    priceIsk: 8_800,
    apiCapUsd: 45,
    monthlyCapInputTokens: 12_000_000,
    monthlyCapOutputTokens: 600_000,
  },
  yfirsyn: {
    id: "yfirsyn",
    displayName: "YFIRSÝN",
    priceIsk: 26_000,
    apiCapUsd: 100,
    monthlyCapInputTokens: 25_000_000,
    monthlyCapOutputTokens: 1_500_000,
  },
  umsja: {
    id: "umsja",
    displayName: "UMSJÁ",
    priceIsk: 58_000,
    apiCapUsd: 150,
    monthlyCapInputTokens: 40_000_000,
    monthlyCapOutputTokens: 2_000_000,
  },
};

export const DEFAULT_PLAN: PlanId = "innsyn";
