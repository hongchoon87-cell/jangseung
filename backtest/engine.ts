// Replays a period of history through the live agent's pipeline. The chain, the exchanges
// and the vault are replaced by recorded history and a TypeScript copy of the contract;
// the rules, the gate, the judgment step and the order they run in are the live code.
import { assetBySymbol, type AssetInfo } from "../agent/src/config.ts";
import { guardAgainstDrift, type SafetyCall } from "../agent/src/executor.ts";
import { effectivePrice, verify, type Quoter } from "../agent/src/gate.ts";
import { bps } from "../agent/src/indicators.ts";
import { priceFromSqrtX96, priceFromTick } from "../agent/src/market.ts";
import { runTick, type Ports } from "../agent/src/pipeline.ts";
import { ruleJudgment, type JudgeInput } from "../agent/src/strategist.ts";
import type {
  AssetMarket,
  Candidate,
  CandidateKind,
  DecisionRecord,
  Execution,
  GateVerdict,
  Judgment,
  MarketSnapshot,
  Policy,
  Portfolio,
  Settings,
} from "../agent/src/types.ts";
import { blockAtOrBefore, CANDLE_SECONDS, COSTS, POOL, TIMING, timestampOfBlock } from "./config.ts";
import { PoolReplay, quoteSwap, TradedPool, type PoolView } from "./pool.ts";
import type { ReferenceHistory } from "./reference.ts";
import { SimVault, VaultRevert } from "./vault.ts";

/**
 * What stands between a rule's candidate and the vault. Each arm adds one thing to the one
 * before it, so a difference in results can be put down to that one thing.
 *   rule         every candidate that fits the owner's size and frequency limits is traded in full
 *   gate         as above, but only candidates the verification gate passes
 *   gate+sizing  as above, with the rule-based judgment scaling the size (the live default without an LLM)
 *   gate+llm     as `gate`, with Claude as the judgment step (the live agent with an API key)
 */
export type Arm = "rule" | "gate" | "gate+sizing" | "gate+llm";

/** Gate checks that only mirror the owner's and the vault's limits. Every arm obeys these. */
const LIMIT_CHECKS = new Set(["agent-active", "breaker", "asset-allowed", "frequency", "size-limits"]);

export interface RunOptions {
  label: string;
  /** Period in seconds: decisions are made from `from` (inclusive) to `to` (exclusive). */
  from: number;
  to: number;
  arm: Arm;
  policy: Policy;
  settings: Settings;
  depositUsdt: number;
  /**
   * Leave the pool on its recorded path after each of our trades, as if they had no
   * lasting effect on its price. Off by default; kept to show what that shortcut hides.
   */
  ignoreOwnImpact?: boolean;
  /**
   * Hours after the drawdown breaker trips at which the owner calls `resume()`. Without
   * it a tripped breaker blocks buying for the rest of the run, as it does on-chain until
   * the owner acts.
   */
  resumeAfterHours?: number;
  /** The judgment step of the `gate+llm` arm (see backtest/llm.ts). */
  judge?: (input: JudgeInput) => Promise<Judgment>;
}

export interface EquityPoint {
  t: number;
  /** NAV as the vault reports it: idle base plus the position at the TWAP. */
  nav: number;
  /** What the vault would hold after selling the position right now, fee and impact included. */
  liquid: number;
  /** Gas paid so far by the agent's key, in USDT. */
  gas: number;
  /** Position value at the TWAP as a share of NAV. */
  exposure: number;
  dexSpot: number;
  cexMid?: number;
}

/** One candidate as the gate saw it, whether or not it was recorded as a decision. */
export interface GateSighting {
  t: number;
  kind: CandidateKind;
  side: "buy" | "sell";
  ok: boolean;
  failed: string[];
  basisBps?: number;
  netEdgeBps?: number;
}

export interface RunResult {
  options: RunOptions;
  equity: EquityPoint[];
  decisions: DecisionRecord[];
  sightings: GateSighting[];
  counters: {
    ticks: number;
    /** Ticks where the pool's oracle could not serve the TWAP window, so the vault could not be read. */
    ticksWithoutTwap: number;
    ticksWithoutReference: number;
    tickErrors: number;
    transactions: number;
    revertedTransactions: number;
    /** Times the owner cleared a tripped breaker (only with `resumeAfterHours`). */
    resumes: number;
  };
  gasUsdt: number;
  /** Final state, with the open position (if any) valued as sold at the end. */
  final: { t: number; liquid: number; openPositionUsdt: number; gasUsdt: number; halted: boolean };
}

// Placeholder addresses: nothing in the pipeline depends on them.
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const OWNER = "0x0000000000000000000000000000000000000002" as const;
const AGENT = "0x0000000000000000000000000000000000000003" as const;

const chainTime = (timestamp: number) => timestampOfBlock(blockAtOrBefore(timestamp));

export async function runBacktest(history: PoolReplay, reference: ReferenceHistory, options: RunOptions): Promise<RunResult> {
  const asset = assetBySymbol(POOL.symbol) as AssetInfo;
  const traded = options.ignoreOwnImpact ? undefined : new TradedPool(history);
  const pool: PoolView = traded ?? history;
  const vault = new SimVault(options.policy, pool, asset.fee);
  const { policy, settings, arm } = options;

  const result: RunResult = {
    options,
    equity: [],
    decisions: [],
    sightings: [],
    counters: { ticks: 0, ticksWithoutTwap: 0, ticksWithoutReference: 0, tickErrors: 0, transactions: 0, revertedTransactions: 0, resumes: 0 },
    gasUsdt: 0,
    final: { t: 0, liquid: 0, openPositionUsdt: 0, gasUsdt: 0, halted: false },
  };

  /** Where the simulation stands inside the current tick. */
  const clock = { close: 0, decisionTs: 0, executionTs: 0, chainTs: 0, hskPrice: 0 };

  function chargeGas(units: bigint): void {
    result.gasUsdt += (Number(units * COSTS.gasPriceWei) / 1e18) * clock.hskPrice;
  }

  function portfolioAt(ts: number): Portfolio {
    const value = vault.positionValue(ts);
    return {
      vault: VAULT,
      blockNumber: BigInt(blockAtOrBefore(ts)),
      blockTimestamp: ts,
      owner: OWNER,
      agent: AGENT,
      nav: vault.idleBase + value,
      idleBase: vault.idleBase,
      pricePerShare: vault.pricePerShare(ts),
      highWaterMark: vault.highWaterMark,
      drawdownBps: vault.drawdownBps(ts),
      halted: vault.halted,
      // The vault resets its counter lazily, on the first buy of a new UTC day.
      buysToday: vault.currentDay === Math.floor(ts / 86_400) ? vault.buysToday : 0,
      lastBuyAt: vault.lastBuyAt,
      policy,
      positions: [
        {
          symbol: asset.symbol,
          address: asset.address,
          enabled: true,
          balance: vault.balance,
          value,
          cost: vault.costBasis,
          lockedUntil: vault.lockedUntil,
          stopLossReached: vault.stopLossReached(ts),
        },
      ],
    };
  }

  function snapshotAt(twapWindow: number): MarketSnapshot {
    const ts = clock.decisionTs;
    const now = (clock.close + TIMING.decisionDelay) * 1000;
    const state = pool.stateAt(ts);
    const market: AssetMarket = {
      symbol: asset.symbol,
      dexSpot: priceFromSqrtX96(state.sqrtPriceX96, asset),
      dexTwap: priceFromTick(pool.meanTick(ts, twapWindow), asset),
      poolLiquidity: state.liquidity,
    };
    const warnings: string[] = [];

    const cex = reference.quoteAt(clock.close, now);
    if (cex) {
      market.cex = cex;
      market.basisBps = bps(market.dexSpot, cex.mid);
    } else {
      result.counters.ticksWithoutReference += 1;
      warnings.push(`${asset.symbol}: exchange quote unavailable (fewer than two exchanges traded in the last candle)`);
    }
    market.trend = reference.trendAt(clock.close);
    clock.hskPrice = cex?.mid ?? market.dexTwap;

    return {
      takenAt: now,
      blockNumber: BigInt(blockAtOrBefore(ts)),
      blockTimestamp: ts,
      gasPriceWei: COSTS.gasPriceWei,
      assets: [market],
      warnings,
    };
  }

  /** Quotes against the pool as it stood at `ts`. */
  const quoterAt =
    (ts: number): Quoter =>
    async (info, side, amountIn) => {
      const amountOut = quoteSwap(pool.stateAt(ts), side, amountIn, info.fee);
      if (amountOut === 0n) throw new Error("the pool returns nothing for this amount");
      return { amountOut, effectivePrice: effectivePrice(info, side, amountIn, amountOut) };
    };

  /**
   * Sends one vault call the way the live executor does: simulate it against the state the
   * agent can see, and only if that passes let it land a few seconds later, against
   * whatever the pool is by then.
   */
  function transact<T>(call: (ts: number) => T, gasUnits: bigint): { ok: true; value: T } | { ok: false; error: string; sent: boolean } {
    try {
      vault.preview(() => call(clock.decisionTs));
    } catch (error) {
      if (!(error instanceof VaultRevert)) throw error;
      return { ok: false, error: error.message, sent: false };
    }

    result.counters.transactions += 1;
    clock.chainTs = clock.executionTs;
    try {
      const value = call(clock.executionTs);
      chargeGas(gasUnits);
      // From here on the pool stands where this trade left it, until somebody else trades.
      const swap = vault.takeSwap();
      if (swap) traded?.applyTrade(swap.at, swap.sqrtPriceAfter);
      return { ok: true, value };
    } catch (error) {
      if (!(error instanceof VaultRevert)) throw error;
      result.counters.revertedTransactions += 1;
      chargeGas(COSTS.revertedGasUnits);
      return { ok: false, error: error.message, sent: true };
    }
  }

  const fullSize: Judgment = {
    source: "rule",
    action: "approve",
    sizeFraction: 1,
    confidence: 0.5,
    rationale: "Backtest arm without the sizing step: the full proposed size.",
    riskFlags: [],
  };

  const ports: Ports = {
    async readPortfolio() {
      return portfolioAt(clock.chainTs);
    },
    async collectMarket(twapWindow) {
      return snapshotAt(twapWindow);
    },
    async verify(candidate: Candidate, context): Promise<GateVerdict> {
      const verdict = await verify(candidate, { ...context, quoter: quoterAt(clock.decisionTs), now: context.snapshot.takenAt });
      const market = context.snapshot.assets.find((a) => a.symbol === candidate.symbol);
      result.sightings.push({
        t: clock.decisionTs,
        kind: candidate.kind,
        side: candidate.side,
        ok: verdict.ok,
        failed: verdict.checks.filter((c) => !c.ok).map((c) => c.name),
        basisBps: market?.basisBps,
        netEdgeBps: verdict.netEdgeBps,
      });
      if (arm !== "rule" || verdict.ok) return verdict;
      // Without the gate, only the limit checks can stop a candidate. The verdict keeps
      // the failed checks, so each trade of this arm shows what the gate would have said.
      const blocked = verdict.checks.some((c) => !c.ok && LIMIT_CHECKS.has(c.name));
      return blocked ? verdict : { ...verdict, ok: true };
    },
    async judge(input) {
      if (arm === "gate+llm") {
        if (!options.judge) throw new Error("The gate+llm arm needs a judge (see backtest/llm.ts).");
        return options.judge(input);
      }
      return arm === "gate+sizing" ? ruleJudgment(input) : fullSize;
    },
    async executeTrade(candidate, amountIn, gate): Promise<Execution> {
      const fresh = await quoterAt(clock.decisionTs)(asset, candidate.side, amountIn);
      const guard = guardAgainstDrift(candidate.side, gate.effectivePrice, fresh);
      if ("skip" in guard) return { status: "skipped", error: guard.skip };

      const buying = candidate.side === "buy";
      const outcome = transact(
        (ts) => (buying ? vault.buy(amountIn, guard.minOut, ts) : vault.sell(amountIn, guard.minOut, ts)),
        buying ? COSTS.gasUnits.buy : COSTS.gasUnits.sell,
      );
      if (!outcome.ok) return { status: "failed", error: outcome.error, blockNumber: outcome.sent ? BigInt(blockAtOrBefore(clock.executionTs)) : undefined };
      const receipt = outcome.value;
      return {
        status: "sent",
        blockNumber: BigInt(blockAtOrBefore(clock.executionTs)),
        gasUsed: buying ? COSTS.gasUnits.buy : COSTS.gasUnits.sell,
        // A buy that returns no receipt latched the drawdown breaker instead of trading.
        baseAmount: receipt?.baseAmount ?? 0n,
        assetAmount: receipt?.assetAmount ?? 0n,
        realizedPnl: receipt?.realizedPnl,
      };
    },
    async runSafetyCall(call: SafetyCall): Promise<Execution> {
      if (call.functionName === "checkpoint") {
        const outcome = transact((ts) => vault.checkpoint(ts), COSTS.gasUnits.checkpoint);
        return outcome.ok
          ? { status: "sent", blockNumber: BigInt(blockAtOrBefore(clock.executionTs)), gasUsed: COSTS.gasUnits.checkpoint }
          : { status: "failed", error: outcome.error };
      }
      const outcome = transact((ts) => vault.triggerStopLoss(call.args[1], ts), COSTS.gasUnits.stopLoss);
      if (!outcome.ok) return { status: "failed", error: outcome.error };
      return {
        status: "sent",
        blockNumber: BigInt(blockAtOrBefore(clock.executionTs)),
        gasUsed: COSTS.gasUnits.stopLoss,
        baseAmount: outcome.value.baseAmount,
        assetAmount: outcome.value.assetAmount,
        realizedPnl: outcome.value.realizedPnl,
      };
    },
  };

  const memory = { quiet: new Map<string, { at: number; reason: string }>(), decisions: result.decisions };
  const record = (decision: DecisionRecord) => void result.decisions.push(decision);

  /** Vault holdings if the position were sold into the pool at `ts`. */
  function liquidAt(ts: number): number {
    const proceeds = vault.balance > 0n ? quoteSwap(pool.stateAt(ts), "sell", vault.balance, asset.fee) : 0n;
    return Number(vault.idleBase + proceeds) / 1e6;
  }

  let deposited = false;
  let haltedSince: number | undefined;
  const firstClose = Math.ceil(options.from / CANDLE_SECONDS) * CANDLE_SECONDS;
  for (let close = firstClose; close < options.to; close += CANDLE_SECONDS) {
    clock.close = close;
    clock.decisionTs = chainTime(close + TIMING.decisionDelay);
    clock.executionTs = chainTime(close + TIMING.decisionDelay + TIMING.executionDelay);
    clock.chainTs = clock.decisionTs;
    result.counters.ticks += 1;

    if (!deposited) {
      vault.deposit(BigInt(Math.round(options.depositUsdt * 1e6)), clock.decisionTs);
      deposited = true;
    }

    // Without a TWAP the vault cannot value a position or price a trade. The live agent's
    // tick fails at this point and it tries again on the next one.
    if (!pool.canObserve(clock.decisionTs, policy.twapWindow)) {
      result.counters.ticksWithoutTwap += 1;
      continue;
    }

    if (vault.halted) {
      haltedSince ??= clock.decisionTs;
      if (options.resumeAfterHours !== undefined && clock.decisionTs - haltedSince >= options.resumeAfterHours * 3600) {
        vault.resume(clock.decisionTs);
        result.counters.resumes += 1;
        haltedSince = undefined;
      }
    }

    let snapshot: MarketSnapshot | undefined;
    try {
      ({ snapshot } = await runTick(ports, settings, memory, record));
    } catch (error) {
      if (!(error instanceof VaultRevert)) throw error;
      result.counters.tickErrors += 1;
      continue;
    }

    const ts = clock.chainTs;
    if (!pool.canObserve(ts, policy.twapWindow)) continue;
    const nav = Number(vault.nav(ts)) / 1e6;
    const market = snapshot.assets[0]!;
    result.equity.push({
      t: ts,
      nav,
      liquid: liquidAt(ts),
      gas: result.gasUsdt,
      exposure: nav > 0 ? Number(vault.positionValue(ts)) / 1e6 / nav : 0,
      dexSpot: market.dexSpot,
      cexMid: market.cex?.mid,
    });
  }

  const end = chainTime(options.to - 1);
  const liquid = liquidAt(end);
  const openPositionUsdt = liquid - Number(vault.idleBase) / 1e6;
  // Closing the last position would cost one more sale.
  if (vault.balance > 0n) chargeGas(COSTS.gasUnits.sell);
  result.final = { t: end, liquid, openPositionUsdt, gasUsdt: result.gasUsdt, halted: vault.halted };
  return result;
}
