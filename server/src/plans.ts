/**
 * Eva subscription plan definitions.
 *
 * Token caps are sized so hitting EITHER cap alone costs <= the plan's API budget.
 * Sonnet 4.6 rates: $3/M input, $15/M output (output includes thinking tokens).
 *
 *   INNSÝN  — $20/user API budget  →  1.2M output ($18)  /  5M input ($15)
 *   YFIRSÝN — $100/user API budget →  6M output ($90)    / 25M input ($75)
 *   UMSJÁ   — $150/user API budget →  9M output ($135)   / 40M input ($120)
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
    apiCapUsd: 20,
    monthlyCapInputTokens: 5_000_000,
    monthlyCapOutputTokens: 1_200_000,
  },
  yfirsyn: {
    id: "yfirsyn",
    displayName: "YFIRSÝN",
    priceIsk: 26_000,
    apiCapUsd: 100,
    monthlyCapInputTokens: 25_000_000,
    monthlyCapOutputTokens: 6_000_000,
  },
  umsja: {
    id: "umsja",
    displayName: "UMSJÁ",
    priceIsk: 58_000,
    apiCapUsd: 150,
    monthlyCapInputTokens: 40_000_000,
    monthlyCapOutputTokens: 9_000_000,
  },
};

export const DEFAULT_PLAN: PlanId = "innsyn";
