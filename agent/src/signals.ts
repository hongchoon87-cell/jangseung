import { assetBySymbol, BASE, type AssetInfo } from "./config.ts";
import { TWAP_SAFETY_BPS } from "./gate.ts";
import { baseDepth } from "./market.ts";
import { effectiveLimits, thresholdsFor } from "./settings.ts";
import type { AssetMarket, Candidate, CandidateKind, MarketSnapshot, Policy, Portfolio, PositionState, Settings } from "./types.ts";

/** Trades smaller than this are not worth their gas. 1 USDT, in base token units. */
const MIN_TRADE = 1_000_000n;

/**
 * Share of the pool's one-sale capacity a position may reach when it is built. The other
 * half is room for the price to sit under the TWAP, or the pool to thin out, by the time
 * the position has to be sold.
 */
const EXIT_CAPACITY_SHARE = 0.5;
/** A sale is sized this far inside the computed capacity, so rounding cannot push it over. */
const SALE_CAPACITY_MARGIN = 0.95;

/**
 * Worth, in base token units, of the most that one sale can put through the pool without
 * the fill falling under the vault's slippage limit against the TWAP.
 *
 * The backtest found why this matters: the vault refuses any sale that fills more than
 * its limit below the TWAP, the stop-loss included. A position worth more than about 0.6%
 * of the pool's depth therefore cannot be closed in one transaction at the default 1%
 * limit, and one built up to the vault's 30% cap in a shallow pool was stuck for days.
 *
 * Selling value v into a pool with base depth D fills at (1 - fee) / (1 + v(1 - fee)/D)
 * of the spot price; the largest v keeps that above TWAP x (1 - limit).
 * @param spotOverTwap pool price relative to the TWAP; below 1 leaves less room.
 */
export function sellCapacity(market: AssetMarket, policy: Policy, asset: AssetInfo, spotOverTwap = market.dexSpot / market.dexTwap): bigint {
  const fee = asset.fee / 1_000_000;
  const limit = (policy.maxSlippageBps - TWAP_SAFETY_BPS) / 10_000;
  const room = ((1 - fee) * spotOverTwap) / (1 - limit) - 1;
  const depth = baseDepth(market, asset);
  if (!(room > 0) || !(depth > 0)) return 0n;
  return BigInt(Math.floor((room * depth) / (1 - fee)));
}

/** How much of a position to offer in one sale: all of it when the pool can take it, otherwise what fits. */
export function sellAmount(position: PositionState, market: AssetMarket, policy: Policy, asset: AssetInfo): bigint {
  const capacity = Number(sellCapacity(market, policy, asset)) * SALE_CAPACITY_MARGIN;
  const worthAtSpot = (Number(position.balance) / 10 ** asset.decimals) * market.dexSpot * 10 ** BASE.decimals;
  if (!(worthAtSpot > 0)) return 0n;
  if (capacity >= worthAtSpot) return position.balance;
  if (capacity < Number(MIN_TRADE)) return 0n;
  return (position.balance * BigInt(Math.floor((capacity / worthAtSpot) * 1_000_000))) / 1_000_000n;
}

function candidateId(symbol: string, kind: CandidateKind, at: number): string {
  return `${at.toString(36)}-${symbol}-${kind}`;
}

/** Unrealised gain of a position against its cost, in bps. */
export function unrealizedBps(position: PositionState): number {
  if (position.cost === 0n) return 0;
  return (Number(position.value) / Number(position.cost) - 1) * 10_000;
}

/**
 * The vault measures its limits against NAV at the block the trade lands in, and NAV moves
 * a little with every block because it is priced at a TWAP. A buy sized exactly at a limit
 * can therefore revert. Staying 1% inside each limit leaves room for that drift.
 */
const LIMIT_HEADROOM_BPS = 100n;

/**
 * Largest buy the vault's size limits and the owner's preference allow right now. Given
 * the market, it also stops the position where it could no longer be sold in one go.
 */
export function buySize(portfolio: Portfolio, position: PositionState, settings: Settings, market?: AssetMarket): bigint {
  const { policy, nav } = portfolio;
  const exposure = portfolio.positions.reduce((sum, p) => sum + p.value, 0n);
  const inside = (bpsOfNav: number) => (nav * BigInt(bpsOfNav) * (10_000n - LIMIT_HEADROOM_BPS)) / 100_000_000n;

  const wanted = (nav * BigInt(effectiveLimits(settings, policy).positionSizeBps)) / 10_000n;
  const rooms = [
    inside(policy.maxTradeBps),
    inside(policy.maxPositionBps) - position.value,
    inside(policy.maxExposureBps) - exposure,
    portfolio.idleBase,
  ];

  const asset = assetBySymbol(position.symbol);
  if (market && asset) {
    // Measured as if the price sat exactly at the TWAP. The exit comes later, so where the
    // price stands against the TWAP at this moment says nothing about the room then; a
    // gap buy in particular happens right after the pool was sold down under its TWAP.
    const capacity = sellCapacity(market, policy, asset, 1);
    rooms.push(BigInt(Math.floor(Number(capacity) * EXIT_CAPACITY_SHARE)) - position.value);
  }

  let size = wanted;
  for (const room of rooms) {
    if (room < size) size = room;
  }
  return size > 0n ? size : 0n;
}

function exitCandidate(
  market: AssetMarket,
  position: PositionState,
  settings: Settings,
  portfolio: Portfolio,
  feeBps: number,
): { kind: CandidateKind; trigger: string } | undefined {
  const t = thresholdsFor(settings.riskAppetite);
  const pnlBps = unrealizedBps(position);

  const softStop = -t.softStopShare * portfolio.policy.stopLossBps;
  if (pnlBps <= softStop) {
    return {
      kind: "soft-stop",
      trigger: `Position is ${pnlBps.toFixed(0)} bps against cost, past the soft stop at ${softStop.toFixed(0)} bps.`,
    };
  }
  if (pnlBps >= t.takeProfitBps) {
    return {
      kind: "take-profit",
      trigger: `Position is up ${pnlBps.toFixed(0)} bps, at or above the ${t.takeProfitBps} bps target.`,
    };
  }
  if (
    settings.strategies.includes("basis") &&
    market.basisBps !== undefined &&
    market.basisBps >= feeBps + t.minNetEdgeBps
  ) {
    return {
      kind: "basis-exit",
      trigger: `DEX trades ${market.basisBps.toFixed(0)} bps above the exchange, more than the fee plus the required edge.`,
    };
  }
  if (settings.strategies.includes("trend") && market.trend && market.trend.trendBps <= t.trendExitBps) {
    return {
      kind: "trend-exit",
      trigger: `Fast average is ${market.trend.trendBps.toFixed(0)} bps under the slow one, below the ${t.trendExitBps} bps exit line.`,
    };
  }
  return undefined;
}

function entryCandidate(
  market: AssetMarket,
  settings: Settings,
  feeBps: number,
): { kind: CandidateKind; trigger: string } | undefined {
  const t = thresholdsFor(settings.riskAppetite);

  // A spread trade pays the pool fee twice: once to buy, once to sell after the gap closes.
  const neededDiscount = 2 * feeBps + t.minNetEdgeBps;
  if (settings.strategies.includes("basis") && market.basisBps !== undefined && market.basisBps <= -neededDiscount) {
    return {
      kind: "basis-entry",
      trigger: `DEX trades ${(-market.basisBps).toFixed(0)} bps below the exchange; ${neededDiscount} bps covers two fees and the required edge.`,
    };
  }

  const trend = market.trend;
  if (
    settings.strategies.includes("trend") &&
    trend &&
    trend.trendBps >= t.trendEntryBps &&
    trend.ret1hBps > 0 &&
    trend.rsi14 < 72 &&
    (market.basisBps ?? 0) <= 20
  ) {
    return {
      kind: "trend-entry",
      trigger: `Fast average is ${trend.trendBps.toFixed(0)} bps over the slow one, 1h return ${trend.ret1hBps.toFixed(0)} bps, RSI ${trend.rsi14.toFixed(0)}.`,
    };
  }
  return undefined;
}

/**
 * Stage 1 of the pipeline: cheap, deterministic rules that propose trades. Nothing here
 * is final. Every candidate still has to pass the gate, the judgment step and the vault.
 * Exits come first in the returned list so risk is reduced before any is added.
 */
export function generateCandidates(market: MarketSnapshot, portfolio: Portfolio, settings: Settings): Candidate[] {
  if (settings.paused) return [];

  const exits: Candidate[] = [];
  const entries: Candidate[] = [];
  const at = market.takenAt;

  for (const assetMarket of market.assets) {
    const info = assetBySymbol(assetMarket.symbol);
    const position = portfolio.positions.find((p) => p.symbol === assetMarket.symbol);
    if (!info || !position) continue;
    const feeBps = info.fee / 100;

    if (position.balance > 0n) {
      const exit = exitCandidate(assetMarket, position, settings, portfolio, feeBps);
      if (exit) {
        // When the pool cannot take the whole position inside the vault's slippage limit,
        // sell what fits now and come back for the rest on a later tick.
        const amountIn = sellAmount(position, assetMarket, portfolio.policy, info);
        if (amountIn > 0n) {
          const partial = amountIn < position.balance;
          exits.push({
            id: candidateId(info.symbol, exit.kind, at),
            kind: exit.kind,
            side: "sell",
            symbol: info.symbol,
            amountIn,
            trigger: partial
              ? `${exit.trigger} Selling ${((Number(amountIn) / Number(position.balance)) * 100).toFixed(0)}% now: more would fill outside the vault's slippage limit.`
              : exit.trigger,
          });
        }
        continue;
      }
    }

    const mayBuy =
      !portfolio.halted &&
      position.enabled &&
      settings.targetAssets.includes(info.symbol) &&
      portfolio.blockTimestamp >= position.lockedUntil;
    if (!mayBuy) continue;

    const entry = entryCandidate(assetMarket, settings, feeBps);
    if (!entry) continue;
    const size = buySize(portfolio, position, settings, assetMarket);
    if (size < MIN_TRADE) continue;

    entries.push({
      id: candidateId(info.symbol, entry.kind, at),
      kind: entry.kind,
      side: "buy",
      symbol: info.symbol,
      amountIn: size,
      trigger: entry.trigger,
    });
  }

  return [...exits, ...entries];
}
