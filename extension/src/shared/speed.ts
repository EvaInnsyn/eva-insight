/**
 * Vinnuhraði — notandinn ræður hraða/gæðum/verði með því að velja módel.
 *
 * Haiku = HRAÐAST + ódýrast (engin hugsun → minnst töf per aðgerð).
 * Sonnet = jafnvægi (sjálfgefið).
 * Opus = SNJALLAST en hægast + dýrast (fyrir flókin margþrepa verk).
 *
 * Módel-strengirnir eru þeir sömu og pricing.ts á þjóninum þekkir, svo
 * inneignin er rétt reiknuð.
 */

export type SpeedId = "hradi" | "jafnvaegi" | "gaedi";

export const DEFAULT_SPEED: SpeedId = "jafnvaegi";

export interface SpeedConfig {
  model: string;
  thinking: "adaptive" | "off";
  label: string;
  hint: string;
  /** Afstætt verð á móti Haiku (1×) — sýnt notanda. */
  costHint: string;
}

export const SPEED_CONFIG: Record<SpeedId, SpeedConfig> = {
  hradi: {
    model: "claude-haiku-4-5-20251001",
    thinking: "off",
    label: "Hraði",
    hint: "Hraðast — best fyrir dagleg verk",
    costHint: "ódýrast",
  },
  jafnvaegi: {
    model: "claude-sonnet-5",
    thinking: "adaptive",
    label: "Jafnvægi",
    hint: "Gott jafnvægi hraða og gæða",
    costHint: "miðlungs",
  },
  gaedi: {
    model: "claude-opus-4-8",
    thinking: "adaptive",
    label: "Gæði",
    hint: "Snjallast fyrir flókin verk — hægara",
    costHint: "dýrast",
  },
};

export function speedConfig(id: SpeedId | undefined): SpeedConfig {
  return SPEED_CONFIG[id ?? DEFAULT_SPEED] ?? SPEED_CONFIG[DEFAULT_SPEED];
}

export const SPEED_ORDER: SpeedId[] = ["hradi", "jafnvaegi", "gaedi"];
