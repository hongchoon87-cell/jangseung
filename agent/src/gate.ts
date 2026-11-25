import type { PublicClient } from "viem";

import { quoterAbi } from "./chain.ts";
import { ADDRESSES, assetBySymbol, BASE, config, type AssetInfo } from "./config.ts";
import { effectiveLimits, thresholdsFor } from "./settings.ts";
import type { AssetMarket, Candidate, GateCheck, GateVerdict, MarketSnapshot, Portfolio, Settings } from "./types.ts";

/** Gas used by a vault trade, from the fork tests (cold storage, rounded up). */
const GAS_UNITS = { buy: 400_000n, sell: 300_000n } as const;
/** The quote must clear the vault's TWAP floor by this margin, or the trade could revert. */
export const TWAP_SAFETY_BPS = 10;
const MAX_CEX_AGE_MS = 20_000;
const MAX_CHAIN_AGE_S = 60;
const MAX_TREND_AGE_MS = 10 * 60 * 1000;
const MAX_CEX_SPREAD_BPS = 60;
/** Exchanges further apart than this do not agree on a price worth trading against. */
const MAX_CEX_DISPERSION_BPS = 80;
/**
 * A gap wider than this between the DEX and the exchanges is not treated as a bargain.
 * Arbitrage normally closes gaps long before they get here, so one this size more likely
 * means a broken pool, a bridge problem or a bad quote.
 */
const MAX_PLAUSIBLE_GAP_BPS = 400;
const ORACLE_FRESH_S = 3_600;
const MAX_ORACLE_GAP_BPS = 200;

export interface Quote {
  amountOut: bigint;
  /** Base token per asset actually obtained, fee and impact included. */
  effectivePrice: number;
}

/** Where execution prices come from: HSKSwap's QuoterV2 when live, a replayed pool in the backtest. */
export type Quoter = (asset: AssetInfo, side: "buy" | "sell", amountIn: bigint) => Promise<Quote>;

export interface GateContext {
  quoter: Quoter;
  snapshot: MarketSnapshot;
  portfolio: Portfolio;
  settings: Settings;
  now?: number;
}

/** Turns raw swap amounts into the price actually paid or received, base token per asset. */
export function effectivePrice(asset: AssetInfo, side: "buy" | "sell", amountIn: bigint, amountOut: bigint): number {
  const baseUnits = side === "buy" ? amountIn : amountOut;
  const assetUnits = side === "buy" ? amountOut : amountIn;
  return Number(baseUnits) / 10 ** BASE.decimals / (Number(assetUnits) / 10 ** asset.decimals);
}

/** Asks HSKSwap's QuoterV2 what `amountIn` would fetch right now. */
export async function quote(
  client: PublicClient,
  asset: AssetInfo,
  side: "buy" | "sell",
  amountIn: bigint,
): Promise<Quote> {
  const [tokenIn, tokenOut] = side === "buy" ? [BASE.address, asset.address] : [asset.address, BASE.address];
  const { result } = await client.simulateContract({
    address: ADDRESSES.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee: asset.fee, sqrtPriceLimitX96: 0n }],
  });
  const amountOut = result[0];
  return { amountOut, effectivePrice: effectivePrice(asset, side, amountIn, amountOut) };
}

export function chainQuoter(client: PublicClient): Quoter {
  return (asset, side, amountIn) => quote(client, asset, side, amountIn);
}

/** Gas cost of one swap as bps of the trade's value. */
function gasCostBps(side: "buy" | "sell", snapshot: MarketSnapshot, tradeValueUsdt: number): number {
  const hsk = snapshot.assets.find((a) => a.symbol === "WHSK");
  const hskPrice = hsk?.cex?.mid ?? hsk?.dexTwap;
  if (!hskPrice || tradeValueUsdt <= 0) return 0;
  const gasHsk = Number(GAS_UNITS[side] * snapshot.gasPriceWei) / 1e18;
  return ((gasHsk * hskPrice) / tradeValueUsdt) * 10_000;
}

function pureChecks(candidate: Candidate, market: AssetMarket, ctx: GateContext): GateCheck[] {
  const { portfolio, settings, snapshot } = ctx;
  const now = ctx.now ?? Date.now();
  const checks: GateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const position = portfolio.positions.find((p) => p.symbol === candidate.symbol);
  const isRiskExit = candidate.kind === "soft-stop";

  add("agent-active", !settings.paused, settings.paused ? "The owner has paused the agent." : "Agent is running.");

  if (candidate.side === "buy") {
    const { policy, nav } = portfolio;
    const limits = effectiveLimits(settings, policy);

    add("breaker", !portfolio.halted, portfolio.halted ? "Drawdown breaker is tripped; buys are blocked." : "Breaker is clear.");

    const allowed = Boolean(position?.enabled) && settings.targetAssets.includes(candidate.symbol);
    const locked = position ? portfolio.blockTimestamp < position.lockedUntil : false;
    add(
      "asset-allowed",
      allowed && !locked,
      !allowed
        ? `${candidate.symbol} is not an enabled target asset.`
        : locked
          ? `${candidate.symbol} is locked after a stop-loss until ${new Date(position!.lockedUntil * 1000).toISOString()}.`
          : `${candidate.symbol} may be bought.`,
    );

    const sinceLastBuy = portfolio.blockTimestamp - portfolio.lastBuyAt;
    const frequencyOk =
      portfolio.buysToday < limits.maxTradesPerDay &&
      (portfolio.lastBuyAt === 0 || sinceLastBuy >= limits.minSecondsBetweenTrades);
    add(
      "frequency",
      frequencyOk,
      `${portfolio.buysToday} of ${limits.maxTradesPerDay} buys used today; ` +
        (portfolio.lastBuyAt === 0
          ? "no earlier buy."
          : `${sinceLastBuy}s since the last buy, ${limits.minSecondsBetweenTrades}s required.`),
    );

    const exposure = portfolio.positions.reduce((sum, p) => sum + p.value, 0n);
    const tradeCap = (nav * BigInt(policy.maxTradeBps)) / 10_000n;
    const positionCap = (nav * BigInt(policy.maxPositionBps)) / 10_000n;
    const exposureCap = (nav * BigInt(policy.maxExposureBps)) / 10_000n;
    const sizeOk =
      candidate.amountIn <= tradeCap &&
      (position?.value ?? 0n) + candidate.amountIn <= positionCap &&
      exposure + candidate.amountIn <= exposureCap &&
      candidate.amountIn <= portfolio.idleBase;
    add(
      "size-limits",
      sizeOk,
      `Buy of ${(Number(candidate.amountIn) / 1e6).toFixed(2)} USDT against trade cap ${(Number(tradeCap) / 1e6).toFixed(2)}, ` +
        `position cap ${(Number(positionCap) / 1e6).toFixed(2)}, exposure cap ${(Number(exposureCap) / 1e6).toFixed(2)}, ` +
        `idle ${(Number(portfolio.idleBase) / 1e6).toFixed(2)}.`,
    );
  }

  const chainAge = Math.round(now / 1000) - snapshot.blockTimestamp;
  const chainFresh = config.allowStaleChain || chainAge <= MAX_CHAIN_AGE_S;
  add(
    "chain-fresh",
    chainFresh,
    config.allowStaleChain
      ? `Chain data is ${chainAge}s old; accepted because ALLOW_STALE_CHAIN is set (fork demo).`
      : `Chain data is ${chainAge}s old; limit ${MAX_CHAIN_AGE_S}s.`,
  );

  // A risk exit must not wait for the exchange: it only needs the pool and the vault.
  if (!isRiskExit) {
    const cex = market.cex;
    const cexAge = cex ? now - cex.fetchedAt : Infinity;
    add(
      "reference-fresh",
      Boolean(cex) && cexAge <= MAX_CEX_AGE_MS,
      cex
        ? `Exchange quotes are ${(cexAge / 1000).toFixed(1)}s old; limit ${MAX_CEX_AGE_MS / 1000}s.`
        : "No reference price: fewer than two exchanges gave a usable quote.",
    );

    if (cex) {
      const oracle = market.oracle;
      const oracleFresh = oracle !== undefined && oracle.ageSeconds <= ORACLE_FRESH_S;
      const oracleGap = oracleFresh ? Math.abs((cex.mid / oracle.price - 1) * 10_000) : 0;
      add(
        "reference-sane",
        cex.spreadBps <= MAX_CEX_SPREAD_BPS && cex.dispersionBps <= MAX_CEX_DISPERSION_BPS && oracleGap <= MAX_ORACLE_GAP_BPS,
        `Reference from ${cex.sources.join(", ")}: spread ${cex.spreadBps.toFixed(0)} bps (limit ${MAX_CEX_SPREAD_BPS}), ` +
          `venues ${cex.dispersionBps.toFixed(0)} bps apart (limit ${MAX_CEX_DISPERSION_BPS}). ` +
          (oracle === undefined
            ? "No oracle for this asset."
            : oracleFresh
              ? `Oracle differs by ${oracleGap.toFixed(0)} bps (limit ${MAX_ORACLE_GAP_BPS}).`
              : `Oracle ignored: last updated ${(oracle.ageSeconds / 3600).toFixed(1)}h ago.`),
      );
    }

    if (candidate.kind === "basis-entry" && market.basisBps !== undefined) {
      add(
        "gap-plausible",
        Math.abs(market.basisBps) <= MAX_PLAUSIBLE_GAP_BPS,
        `DEX is ${Math.abs(market.basisBps).toFixed(0)} bps away from the exchanges; beyond ${MAX_PLAUSIBLE_GAP_BPS} the gap is treated as a fault, not an opportunity.`,
      );
    }

    if (candidate.kind === "trend-entry" || candidate.kind === "trend-exit") {
      const trendAge = market.trend ? now - market.trend.asOf : Infinity;
      add(
        "trend-fresh",
        trendAge <= MAX_TREND_AGE_MS,
        market.trend ? `Newest finished candle closed ${(trendAge / 60_000).toFixed(1)} min ago.` : "No candles.",
      );
    }
  }

  return checks;
}

/**
 * Stage 2 of the pipeline. Rejects candidates that only look like opportunities: stale or
 * inconsistent reference prices, a pool too thin for the size, or a gain smaller than its
 * costs. It also mirrors the vault's limits so a doomed transaction is never sent.
 */
export async function verify(candidate: Candidate, ctx: GateContext): Promise<GateVerdict> {
  const asset = assetBySymbol(candidate.symbol);
  const market = ctx.snapshot.assets.find((a) => a.symbol === candidate.symbol);
  if (!asset || !market) {
    return { ok: false, checks: [{ name: "market-data", ok: false, detail: `No market data for ${candidate.symbol}.` }] };
  }

  const checks = pureChecks(candidate, market, ctx);
  if (checks.some((c) => !c.ok)) return { ok: false, checks };

  let quoted;
  try {
    quoted = await ctx.quoter(asset, candidate.side, candidate.amountIn);
  } catch (error) {
    checks.push({ name: "quote", ok: false, detail: `Quoter call failed: ${(error as Error).message.split("\n")[0]}` });
    return { ok: false, checks };
  }

  const verdict = evaluateQuote(candidate, market, ctx, quoted, asset.fee / 100);
  return { ...verdict, checks: [...checks, ...verdict.checks], ok: verdict.checks.every((c) => c.ok) };
}

/** The price and edge checks, separated from the RPC call so they can be tested directly. */
export function evaluateQuote(
  candidate: Candidate,
  market: AssetMarket,
  ctx: Pick<GateContext, "snapshot" | "portfolio" | "settings">,
  quoted: Quote,
  feeBps: number,
): GateVerdict {
  const checks: GateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const buying = candidate.side === "buy";
  const t = thresholdsFor(ctx.settings.riskAppetite);
  const price = quoted.effectivePrice;

  // Positive numbers are costs to the vault on either side.
  const slippageVsTwapBps = (buying ? price / market.dexTwap - 1 : 1 - price / market.dexTwap) * 10_000;
  const impactBps = (buying ? price / market.dexSpot - 1 : 1 - price / market.dexSpot) * 10_000 - feeBps;
  const tradeValue = Number(buying ? candidate.amountIn : quoted.amountOut) / 10 ** BASE.decimals;
  const gasBps = gasCostBps(candidate.side, ctx.snapshot, tradeValue);

  const twapLimit = ctx.portfolio.policy.maxSlippageBps - TWAP_SAFETY_BPS;
  add(
    "twap-floor",
    slippageVsTwapBps <= twapLimit,
    `Quote is ${slippageVsTwapBps.toFixed(0)} bps worse than the TWAP (fee ${feeBps}, impact ${impactBps.toFixed(1)}); ` +
      `the vault rejects beyond ${ctx.portfolio.policy.maxSlippageBps}, the agent stops at ${twapLimit}.`,
  );

  let netEdgeBps: number | undefined;
  const mid = market.cex?.mid;

  if (candidate.kind === "basis-entry" && mid) {
    // Gap to the exchange after buying, less what selling back will cost.
    const gapAfterBuy = (1 - price / mid) * 10_000;
    netEdgeBps = gapAfterBuy - feeBps - Math.max(impactBps, 0) - 2 * gasBps;
    add(
      "net-edge",
      netEdgeBps >= t.minNetEdgeBps,
      `After buying, the asset sits ${gapAfterBuy.toFixed(0)} bps under the exchange; selling back costs about ` +
        `${(feeBps + Math.max(impactBps, 0) + 2 * gasBps).toFixed(0)} bps. Net ${netEdgeBps.toFixed(0)} bps, need ${t.minNetEdgeBps}.`,
    );
  } else if (candidate.kind === "basis-exit" && mid) {
    netEdgeBps = (price / mid - 1) * 10_000 - gasBps;
    add(
      "net-edge",
      netEdgeBps >= t.minNetEdgeBps,
      `Selling realises ${netEdgeBps.toFixed(0)} bps over the exchange price after fee, impact and gas; need ${t.minNetEdgeBps}.`,
    );
  } else if (candidate.kind === "trend-entry") {
    const roundTrip = 2 * (feeBps + Math.max(impactBps, 0) + gasBps);
    const premium = market.cex ? (price / market.cex.ask - 1) * 10_000 : 0;
    add(
      "cost-cap",
      roundTrip <= t.maxRoundTripCostBps,
      `Round trip costs about ${roundTrip.toFixed(0)} bps (two fees, impact, gas); cap ${t.maxRoundTripCostBps}.`,
    );
    add(
      "no-premium",
      premium <= feeBps + 20,
      `Buy price is ${premium.toFixed(0)} bps over the exchange ask; at most ${feeBps + 20} allowed.`,
    );
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    quotedOut: quoted.amountOut,
    effectivePrice: price,
    slippageVsTwapBps,
    impactBps,
    gasBps,
    netEdgeBps,
  };
}
