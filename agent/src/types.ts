import type { Address, Hex } from "viem";

import type { AssetSymbol } from "./config.ts";

/** On-chain policy, as read from the vault. */
export interface Policy {
  maxTradeBps: number;
  maxPositionBps: number;
  maxExposureBps: number;
  maxSlippageBps: number;
  stopLossBps: number;
  maxDrawdownBps: number;
  maxTradesPerDay: number;
  cooldown: number;
  twapWindow: number;
  reentryLockout: number;
}

export interface PositionState {
  symbol: AssetSymbol;
  address: Address;
  /** Whether the vault allows buying this asset. */
  enabled: boolean;
  balance: bigint;
  /** Worth in base token units at the vault's TWAP. */
  value: bigint;
  /** Base token units spent to build the balance. */
  cost: bigint;
  lockedUntil: number;
  stopLossReached: boolean;
}

/** Everything the agent needs to know about the vault at one block. */
export interface Portfolio {
  vault: Address;
  blockNumber: bigint;
  blockTimestamp: number;
  owner: Address;
  agent: Address;
  nav: bigint;
  idleBase: bigint;
  pricePerShare: bigint;
  highWaterMark: bigint;
  drawdownBps: number;
  halted: boolean;
  buysToday: number;
  lastBuyAt: number;
  policy: Policy;
  positions: PositionState[];
}

export interface CexQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** Highest venue mid over lowest venue mid, in bps. */
  dispersionBps: number;
  /** Exchanges whose quotes went into the consensus. */
  sources: string[];
  fetchedAt: number;
}

export interface Trend {
  /** Fast EMA over slow EMA, in bps. Positive means rising. */
  trendBps: number;
  ret1hBps: number;
  /** One-hour realised volatility in bps, from 5-minute closes. */
  vol1hBps: number;
  rsi14: number;
  /** Close time of the newest candle used. */
  asOf: number;
}

export interface OracleReading {
  price: number;
  updatedAt: number;
  ageSeconds: number;
}

export interface AssetMarket {
  symbol: AssetSymbol;
  /** Base token per asset at the pool's current price. */
  dexSpot: number;
  /** Base token per asset averaged over the vault's TWAP window. */
  dexTwap: number;
  poolLiquidity: bigint;
  cex?: CexQuote;
  trend?: Trend;
  oracle?: OracleReading;
  /** DEX spot over exchange mid, in bps. Negative means the DEX is cheaper. */
  basisBps?: number;
}

export interface MarketSnapshot {
  takenAt: number;
  blockNumber: bigint;
  blockTimestamp: number;
  gasPriceWei: bigint;
  assets: AssetMarket[];
  /** Problems met while collecting, e.g. an exchange request that failed. */
  warnings: string[];
}

export type CandidateKind =
  | "basis-entry"
  | "trend-entry"
  | "basis-exit"
  | "take-profit"
  | "trend-exit"
  | "soft-stop"
  /** The vault's own stop-loss, fired through its permissionless function. */
  | "hard-stop"
  /** Recording a breached drawdown limit on-chain. */
  | "breaker";

export interface Candidate {
  id: string;
  kind: CandidateKind;
  side: "buy" | "sell";
  symbol: AssetSymbol;
  /** Base token units to spend (buy) or asset units to sell. */
  amountIn: bigint;
  /** Why the rule fired, in one line. */
  trigger: string;
}

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GateVerdict {
  ok: boolean;
  checks: GateCheck[];
  /** Quoted output for `amountIn`, in the output token's units. */
  quotedOut?: bigint;
  /** Realised price of the quote, base token per asset. */
  effectivePrice?: number;
  /** Quote versus the vault's TWAP, in bps. Positive is worse for the vault. */
  slippageVsTwapBps?: number;
  /** Price impact beyond the pool fee, in bps. */
  impactBps?: number;
  /** Gas for the swap as bps of the trade. */
  gasBps?: number;
  /** Expected gain after all costs, in bps of the trade, for spread-based candidates. */
  netEdgeBps?: number;
}

export interface Judgment {
  source: "llm" | "rule" | "rule-fallback";
  action: "approve" | "reduce" | "veto";
  /** Share of the gated size to trade, from 0 to 1. */
  sizeFraction: number;
  confidence: number;
  rationale: string;
  riskFlags: string[];
  model?: string;
  latencyMs?: number;
  /** Why the LLM was not used, when source is rule-fallback. */
  fallbackReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Execution {
  status: "sent" | "dry-run" | "failed" | "skipped";
  txHash?: Hex;
  blockNumber?: bigint;
  gasUsed?: bigint;
  baseAmount?: bigint;
  assetAmount?: bigint;
  realizedPnl?: bigint;
  error?: string;
}

/** One pass through the pipeline for one candidate. Its hash is the on-chain memo. */
export interface DecisionRecord {
  id: string;
  at: number;
  candidate: Candidate;
  market: Pick<AssetMarket, "symbol" | "dexSpot" | "dexTwap" | "basisBps"> & {
    cexMid?: number;
    trendBps?: number;
  };
  gate: GateVerdict;
  judgment?: Judgment;
  memo?: Hex;
  execution?: Execution;
}

export type RiskAppetite = "conservative" | "balanced" | "aggressive";

/** Preferences the owner can change by chat. Always applied inside the on-chain policy. */
export interface Settings {
  paused: boolean;
  riskAppetite: RiskAppetite;
  /** Size of one buy as bps of NAV. */
  positionSizeBps: number;
  maxTradesPerDay: number;
  minMinutesBetweenTrades: number;
  targetAssets: AssetSymbol[];
  strategies: Array<"basis" | "trend">;
}
