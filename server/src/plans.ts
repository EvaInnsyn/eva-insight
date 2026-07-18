/**
 * Eva credit packages (2026-07-08: subscription → prepaid credit).
 *
 * priceIsk is BOTH what the package costs AND the credit it grants — you buy
 * Eva's work upfront and the balance burns down per request (costIsk in
 * pricing.ts) without ever resetting. Legacy monthly token caps remain only
 * for users not yet switched to credit mode.
 *
 *   INNSÝN  —  5.000 kr — til að prófa hversu öflug Eva er
 *   YFIRSÝN — 15.000 kr — fullt af verkefnum
 *   UMSJÁ   — 35.000 kr — enn meira
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
    priceIsk: 5_000,
    apiCapUsd: 20,
    monthlyCapInputTokens: 5_000_000,
    monthlyCapOutputTokens: 1_200_000,
  },
  yfirsyn: {
    id: "yfirsyn",
    displayName: "YFIRSÝN",
    priceIsk: 15_000,
    apiCapUsd: 100,
    monthlyCapInputTokens: 25_000_000,
    monthlyCapOutputTokens: 6_000_000,
  },
  umsja: {
    id: "umsja",
    displayName: "UMSJÁ",
    priceIsk: 35_000,
    apiCapUsd: 150,
    monthlyCapInputTokens: 40_000_000,
    monthlyCapOutputTokens: 9_000_000,
  },
};

export const DEFAULT_PLAN: PlanId = "innsyn";
