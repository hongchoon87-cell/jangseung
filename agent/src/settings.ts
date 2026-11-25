import { ASSETS, type AssetSymbol } from "./config.ts";
import type { Policy, RiskAppetite, Settings } from "./types.ts";

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  riskAppetite: "balanced",
  positionSizeBps: 500,
  maxTradesPerDay: 4,
  minMinutesBetweenTrades: 15,
  targetAssets: ["WHSK"],
  strategies: ["basis", "trend"],
};

/** Thresholds that follow from the risk appetite. All values are in bps. */
export interface Thresholds {
  /** Gain required after every cost before a spread trade is worth taking. */
  minNetEdgeBps: number;
  /** Fast-over-slow EMA gap needed to enter on trend. */
  trendEntryBps: number;
  /** Gap below which a held position is closed on trend. */
  trendExitBps: number;
  takeProfitBps: number;
  /** The agent sells at this share of the on-chain stop-loss, before the hard stop fires. */
  softStopShare: number;
  /** Highest round-trip cost a trend entry may carry. */
  maxRoundTripCostBps: number;
}

const THRESHOLDS: Record<RiskAppetite, Thresholds> = {
  conservative: {
    minNetEdgeBps: 40,
    trendEntryBps: 60,
    trendExitBps: -10,
    takeProfitBps: 120,
    softStopShare: 0.5,
    maxRoundTripCostBps: 75,
  },
  balanced: {
    minNetEdgeBps: 25,
    trendEntryBps: 40,
    trendExitBps: -20,
    takeProfitBps: 180,
    softStopShare: 0.7,
    maxRoundTripCostBps: 85,
  },
  aggressive: {
    minNetEdgeBps: 10,
    trendEntryBps: 25,
    trendExitBps: -35,
    takeProfitBps: 300,
    softStopShare: 0.85,
    maxRoundTripCostBps: 100,
  },
};

export function thresholdsFor(appetite: RiskAppetite): Thresholds {
  return THRESHOLDS[appetite];
}

const SYMBOLS = new Set<string>(ASSETS.map((a) => a.symbol));
const APPETITES = new Set<string>(["conservative", "balanced", "aggressive"]);
const STRATEGIES = new Set<string>(["basis", "trend"]);

export interface SettingsChange {
  settings: Settings;
  /** Human-readable notes about values that were adjusted or refused. */
  notes: string[];
}

/**
 * Applies a partial update and forces the result inside the on-chain policy. Preferences
 * can only make the agent more careful than the vault allows, never less.
 */
export function applySettings(current: Settings, patch: Partial<Settings>, policy: Policy): SettingsChange {
  const next: Settings = { ...current };
  const notes: string[] = [];

  if (typeof patch.paused === "boolean") next.paused = patch.paused;

  if (patch.riskAppetite !== undefined) {
    if (APPETITES.has(patch.riskAppetite)) next.riskAppetite = patch.riskAppetite;
    else notes.push(`Unknown risk appetite "${String(patch.riskAppetite)}" ignored.`);
  }

  if (patch.positionSizeBps !== undefined) {
    const wanted = Math.round(Number(patch.positionSizeBps));
    if (!Number.isFinite(wanted) || wanted < 1) {
      notes.push("Position size must be a positive number; unchanged.");
    } else if (wanted > policy.maxTradeBps) {
      next.positionSizeBps = policy.maxTradeBps;
      notes.push(
        `Position size capped at ${policy.maxTradeBps / 100}% of NAV, the vault's on-chain limit. ` +
          "Raising it needs a policy change signed by the owner.",
      );
    } else {
      next.positionSizeBps = wanted;
    }
  }

  if (patch.maxTradesPerDay !== undefined) {
    const wanted = Math.round(Number(patch.maxTradesPerDay));
    if (!Number.isFinite(wanted) || wanted < 0) {
      notes.push("Trades per day must be zero or more; unchanged.");
    } else if (wanted > policy.maxTradesPerDay) {
      next.maxTradesPerDay = policy.maxTradesPerDay;
      notes.push(`Trades per day capped at ${policy.maxTradesPerDay}, the vault's on-chain limit.`);
    } else {
      next.maxTradesPerDay = wanted;
    }
  }

  if (patch.minMinutesBetweenTrades !== undefined) {
    const wanted = Number(patch.minMinutesBetweenTrades);
    const floor = policy.cooldown / 60;
    if (!Number.isFinite(wanted) || wanted < 0) {
      notes.push("Minutes between trades must be zero or more; unchanged.");
    } else if (wanted < floor) {
      next.minMinutesBetweenTrades = floor;
      notes.push(`Minutes between trades raised to ${floor}, the vault's on-chain cooldown.`);
    } else {
      next.minMinutesBetweenTrades = wanted;
    }
  }

  if (patch.targetAssets !== undefined) {
    const valid = [...new Set(patch.targetAssets)].filter((s) => SYMBOLS.has(s)) as AssetSymbol[];
    const rejected = patch.targetAssets.filter((s) => !SYMBOLS.has(s));
    if (rejected.length > 0) notes.push(`Unknown assets ignored: ${rejected.join(", ")}.`);
    next.targetAssets = valid;
  }

  if (patch.strategies !== undefined) {
    next.strategies = [...new Set(patch.strategies)].filter((s) => STRATEGIES.has(s));
  }

  return { settings: next, notes };
}

/** Limits in force right now: the stricter of the owner's preference and the vault's policy. */
export function effectiveLimits(settings: Settings, policy: Policy) {
  return {
    positionSizeBps: Math.min(settings.positionSizeBps, policy.maxTradeBps),
    maxTradesPerDay: Math.min(settings.maxTradesPerDay, policy.maxTradesPerDay),
    minSecondsBetweenTrades: Math.max(settings.minMinutesBetweenTrades * 60, policy.cooldown),
  };
}
