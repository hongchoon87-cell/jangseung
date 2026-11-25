import type { Hex } from "viem";

import { memoFor, type SafetyCall } from "./executor.ts";
import type { GateContext } from "./gate.ts";
import { generateCandidates } from "./signals.ts";
import type { JudgeInput } from "./strategist.ts";
import type { Candidate, DecisionRecord, Execution, GateVerdict, Judgment, MarketSnapshot, Portfolio, Settings } from "./types.ts";

/** A candidate turned down for the same reason is not recorded or re-judged more often than this. */
const REPEAT_QUIET_MS = 10 * 60 * 1000;
/** A trade whose transaction failed or was skipped is not retried sooner than this. */
const RETRY_AFTER_FAILURE_MS = 2 * 60 * 1000;

/**
 * Everything one pass of the pipeline needs from the outside world. The live engine wires
 * these to the chain, the exchanges and Claude; the backtest wires them to recorded
 * history. The order of the steps and every decision between them is the code below, so
 * what is tested on history is what runs live.
 */
export interface Ports {
  readPortfolio(): Promise<Portfolio>;
  collectMarket(twapWindow: number): Promise<MarketSnapshot>;
  verify(candidate: Candidate, context: Omit<GateContext, "quoter">): Promise<GateVerdict>;
  judge(input: JudgeInput): Promise<Judgment>;
  executeTrade(candidate: Candidate, amountIn: bigint, gate: GateVerdict, memo: Hex): Promise<Execution>;
  runSafetyCall(call: SafetyCall): Promise<Execution>;
}

/** What the pipeline remembers between passes. */
export interface Memory {
  /** When each kind of candidate was last turned down, and why. */
  quiet: Map<string, { at: number; reason: string }>;
  /** Recent decisions, oldest first; the judgment step is shown the last few. */
  decisions: readonly DecisionRecord[];
}

export interface TickResult {
  portfolio: Portfolio;
  snapshot: MarketSnapshot;
}

function marketOf(snapshot: MarketSnapshot, symbol: string): DecisionRecord["market"] {
  const m = snapshot.assets.find((a) => a.symbol === symbol);
  return {
    symbol: symbol as DecisionRecord["market"]["symbol"],
    dexSpot: m?.dexSpot ?? 0,
    dexTwap: m?.dexTwap ?? 0,
    basisBps: m?.basisBps,
    cexMid: m?.cex?.mid,
    trendBps: m?.trend?.trendBps,
  };
}

/**
 * One pass: read the vault and the market, apply the vault's own safety rules, then take
 * the rule candidates one at a time through gate, judgment and execution.
 * @param record called with every decision worth keeping, in order.
 */
export async function runTick(
  ports: Ports,
  settings: Settings,
  memory: Memory,
  record: (decision: DecisionRecord) => void,
): Promise<TickResult> {
  const { quiet } = memory;

  /** True when the same candidate was turned down for the same reason a moment ago. */
  function recentlyDeclined(candidate: Candidate, reason: string, now: number): boolean {
    const key = `${candidate.symbol}:${candidate.kind}`;
    const last = quiet.get(key);
    if (last && last.reason === reason && now - last.at < REPEAT_QUIET_MS) return true;
    quiet.set(key, { at: now, reason });
    return false;
  }

  /**
   * True while a candidate should be left alone: the judgment step vetoed it, a dry run
   * already showed what would happen, or its transaction just failed. Without this the
   * agent would ask the model, or retry a failing trade, on every tick.
   */
  function isResting(candidate: Candidate, now: number): boolean {
    const last = quiet.get(`${candidate.symbol}:${candidate.kind}`);
    if (!last) return false;
    const rest = { veto: REPEAT_QUIET_MS, "dry-run": REPEAT_QUIET_MS, failed: RETRY_AFTER_FAILURE_MS }[last.reason];
    return rest !== undefined && now - last.at < rest;
  }

  /** The vault's own safety rules. These run even while the agent is paused. */
  async function safetyPass(portfolio: Portfolio, snapshot: MarketSnapshot): Promise<boolean> {
    let acted = false;
    const now = snapshot.takenAt;

    for (const position of portfolio.positions) {
      if (!position.stopLossReached || position.balance === 0n) continue;
      const candidate: Candidate = {
        id: `${now.toString(36)}-${position.symbol}-hard-stop`,
        kind: "hard-stop",
        side: "sell",
        symbol: position.symbol,
        amountIn: position.balance,
        trigger: `Position fell past the vault's ${portfolio.policy.stopLossBps} bps stop-loss.`,
      };
      // Zero asks the vault to sell as much as the pool can take inside its slippage limit.
      // A position too large for one sale is closed over several ticks: each sale leaves
      // the price under the TWAP, and the next one fits once the TWAP has followed.
      const execution = await ports.runSafetyCall({ functionName: "triggerStopLoss", args: [position.address, 0n] });
      const sent = execution.status === "sent";
      // A stop that cannot fire yet is tried again every tick but written down only now and then.
      if (sent || !recentlyDeclined(candidate, "hard-stop", now)) {
        record({ id: candidate.id, at: now, candidate, market: marketOf(snapshot, position.symbol), gate: { ok: true, checks: [] }, execution });
      }
      acted ||= sent;
    }

    if (!portfolio.halted && portfolio.drawdownBps >= portfolio.policy.maxDrawdownBps) {
      const candidate: Candidate = {
        id: `${now.toString(36)}-vault-breaker`,
        kind: "breaker",
        side: "sell",
        symbol: portfolio.positions[0]?.symbol ?? "WHSK",
        amountIn: 0n,
        trigger: `Drawdown ${portfolio.drawdownBps} bps reached the ${portfolio.policy.maxDrawdownBps} bps limit.`,
      };
      if (!recentlyDeclined(candidate, "breaker", now)) {
        const execution = await ports.runSafetyCall({ functionName: "checkpoint", args: [] });
        record({ id: candidate.id, at: now, candidate, market: marketOf(snapshot, candidate.symbol), gate: { ok: true, checks: [] }, execution });
        acted = true;
      }
    }
    return acted;
  }

  /** Runs one candidate through gate, judgment and execution. Returns true if a trade went out. */
  async function consider(candidate: Candidate, portfolio: Portfolio, snapshot: MarketSnapshot): Promise<boolean> {
    const now = snapshot.takenAt;
    if (isResting(candidate, now)) return false;

    const market = snapshot.assets.find((a) => a.symbol === candidate.symbol);
    if (!market) return false;

    const gate = await ports.verify(candidate, { snapshot, portfolio, settings });
    const base = { id: candidate.id, at: now, candidate, market: marketOf(snapshot, candidate.symbol), gate };

    if (!gate.ok) {
      const reason = gate.checks.find((c) => !c.ok)?.name ?? "gate";
      if (!recentlyDeclined(candidate, reason, now)) record(base);
      return false;
    }

    const judgment = await ports.judge({ candidate, gate, market, snapshot, portfolio, settings, recent: memory.decisions });
    const judged = { ...base, judgment };

    if (judgment.action === "veto") {
      recentlyDeclined(candidate, "veto", now);
      record(judged);
      return false;
    }

    const amountIn =
      judgment.sizeFraction >= 1
        ? candidate.amountIn
        : (candidate.amountIn * BigInt(Math.round(judgment.sizeFraction * 10_000))) / 10_000n;
    const memo = memoFor(judged);
    const execution = await ports.executeTrade(candidate, amountIn, gate, memo);
    record({ ...judged, memo, execution });

    if (execution.status === "dry-run") recentlyDeclined(candidate, "dry-run", now);
    if (execution.status === "failed" || execution.status === "skipped") recentlyDeclined(candidate, "failed", now);
    return execution.status === "sent";
  }

  let portfolio = await ports.readPortfolio();
  const snapshot = await ports.collectMarket(portfolio.policy.twapWindow);

  // A stop-loss just changed the vault, so candidates must come from what is left.
  if (await safetyPass(portfolio, snapshot)) portfolio = await ports.readPortfolio();

  for (const candidate of generateCandidates(snapshot, portfolio, settings)) {
    if (await consider(candidate, portfolio, snapshot)) {
      // One trade per tick: the next one should see the vault as this one left it.
      portfolio = await ports.readPortfolio();
      break;
    }
  }
  return { portfolio, snapshot };
}
