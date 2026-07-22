/**
 * Verðþrep — how much of a purchase becomes usable work (2026-07-21).
 *
 * The customer's dashboard always shows the FULL purchased amount; the tier
 * decides how fast it burns. usageShare is the slice of each purchased króna
 * that pays for raw Eva work at cost — the rest is Eva Innsýn's margin:
 *
 *   fjölskylda — 90% nýting (Eva heldur 10% af kaupunum)
 *   vinir      — 80% nýting (Eva heldur 20%)
 *   almennt    — 70% nýting (Eva heldur 30%)
 *
 * Spending applies 1/usageShare as a multiplier on raw cost, so a 5.000 kr
 * purchase yields 4.500 / 4.000 / 3.500 kr of at-cost work respectively.
 */

export type TierId = "fjolskylda" | "vinir" | "almennt";

export interface Tier {
  id: TierId;
  label: string;
  usageShare: number;
}

export const TIERS: Record<TierId, Tier> = {
  fjolskylda: { id: "fjolskylda", label: "Fjölskylda", usageShare: 0.9 },
  vinir: { id: "vinir", label: "Vinir", usageShare: 0.8 },
  almennt: { id: "almennt", label: "Almennt", usageShare: 0.7 },
};

export const DEFAULT_TIER: TierId = "almennt";

export function isTierId(v: unknown): v is TierId {
  return typeof v === "string" && v in TIERS;
}

/** Multiplier applied to raw ISK cost when burning credit. */
export function spendMultiplier(tier: string | null | undefined): number {
  const t = isTierId(tier) ? TIERS[tier] : TIERS[DEFAULT_TIER];
  return 1 / t.usageShare;
}
