/**
 * Eva subscription plans (2026-08-12: ný verðskrá — áskrift + innifalin
 * mánaðarinneign í stað stakra inneignarkaupa).
 *
 *   INNSÝN  —  4.800 kr/mán — 1.000 kr innifalin inneign á mánuði
 *   YFIRSÝN — 18.800 kr/mán — 3.000 kr innifalin inneign á mánuði
 *   UMSJÁ   — horfin sem áskrift; er hér aðeins sem LEGACY-merki svo eldri
 *             notendaraðir birtist rétt. Ekki hægt að kaupa.
 *
 * Keypt inneign („Kaupa inneign" pakkar 10/15/25 þús kr) kemur gegnum
 * /v1/credit og ber 12 mánaða fyrningu — sjá credit_lots í db.ts.
 * priceIsk er áskriftarverðið (m/VSK); includedMonthlyIsk er inneignin sem
 * hver mánaðargreiðsla veitir (rúllar mest einn mánuð, sjá renewIncludedLot).
 * Legacy monthly token caps remain only for users not yet on credit mode.
 */

export type PlanId = "innsyn" | "yfirsyn" | "umsja";

/** Þrepin sem hægt er að kaupa — umsjá er bara legacy-merki. */
export const PURCHASABLE_PLANS: PlanId[] = ["innsyn", "yfirsyn"];

export interface Plan {
  id: PlanId;
  displayName: string;
  priceIsk: number;
  includedMonthlyIsk: number;
  apiCapUsd: number;
  monthlyCapInputTokens: number;
  monthlyCapOutputTokens: number;
}

export const PLANS: Record<PlanId, Plan> = {
  innsyn: {
    id: "innsyn",
    displayName: "INNSÝN",
    priceIsk: 4_800,
    includedMonthlyIsk: 1_000,
    apiCapUsd: 20,
    monthlyCapInputTokens: 5_000_000,
    monthlyCapOutputTokens: 1_200_000,
  },
  yfirsyn: {
    id: "yfirsyn",
    displayName: "YFIRSÝN",
    priceIsk: 18_800,
    includedMonthlyIsk: 3_000,
    apiCapUsd: 100,
    monthlyCapInputTokens: 25_000_000,
    monthlyCapOutputTokens: 6_000_000,
  },
  // LEGACY: eldri notendur keyptu umsjá-pakka fyrir 2026-08-12 — merkið
  // birtist áfram hjá þeim en ekkert nýtt selst á þessu þrepi.
  umsja: {
    id: "umsja",
    displayName: "UMSJÁ (eldra)",
    priceIsk: 0,
    includedMonthlyIsk: 0,
    apiCapUsd: 150,
    monthlyCapInputTokens: 40_000_000,
    monthlyCapOutputTokens: 9_000_000,
  },
};

export const DEFAULT_PLAN: PlanId = "innsyn";
