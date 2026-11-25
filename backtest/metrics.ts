// Turns a run into the numbers the report shows: return after every cost, drawdown, what
// was traded and why, what the gate turned away, and how each closed position ended.
import type { CandidateKind, DecisionRecord } from "../agent/src/types.ts";
import { timestampOfBlock } from "./config.ts";
import type { EquityPoint, RunResult } from "./engine.ts";

export interface RoundTrip {
  entryKind: CandidateKind;
  exitKind: CandidateKind;
  openedAt: number;
  closedAt: number;
  buys: number;
  /** Sales it took to close. More than one means the pool could not take the position in one go. */
  sells: number;
  costUsdt: number;
  proceedsUsdt: number;
  pnlUsdt: number;
  pnlBps: number;
  holdHours: number;
  /** Gap between DEX and exchanges when the first buy was decided, in bps. */
  entryBasisBps?: number;
  /** Net edge the gate measured for the first buy, in bps. */
  entryNetEdgeBps?: number;
  /** Which gate checks the first buy failed. Only the rule-only arm trades such candidates. */
  entryGateFailures: string[];
  /** Exchange price change from the first buy to the sale, in bps. */
  referenceMoveBps?: number;
  /** DEX price change over the same span, in bps. */
  dexMoveBps: number;
}

export interface GroupStats {
  count: number;
  wins: number;
  pnlUsdt: number;
  meanBps: number;
  medianBps: number;
  worstBps: number;
  bestBps: number;
  meanHoldHours: number;
}

export interface Summary {
  label: string;
  arm: string;
  from: string;
  to: string;
  days: number;
  depositUsdt: number;
  /** After pool fees, price impact and gas, with any open position valued as sold at the end. */
  finalUsdt: number;
  returnPct: number;
  returnBeforeGasPct: number;
  gasUsdt: number;
  poolFeesUsdt: number;
  /** Deepest fall of NAV (position at the TWAP) less gas, from its running peak. */
  maxDrawdownPct: number;
  /** The same, with the position valued at what selling it into the pool would fetch. */
  maxDrawdownLiquidPct: number;
  timeInMarketPct: number;
  meanExposurePct: number;
  executions: Record<string, number>;
  transactions: number;
  revertedTransactions: number;
  roundTrips: GroupStats;
  byEntryKind: Record<string, GroupStats>;
  byExitKind: Record<string, GroupStats>;
  gate: Record<string, Record<string, number>>;
  monthly: Array<{ month: string; returnPct: number }>;
  openPositionUsdt: number;
  halted: boolean;
  counters: RunResult["counters"];
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function groupStats(trips: readonly RoundTrip[]): GroupStats {
  const bps = trips.map((t) => t.pnlBps);
  return {
    count: trips.length,
    wins: trips.filter((t) => t.pnlUsdt > 0).length,
    pnlUsdt: trips.reduce((sum, t) => sum + t.pnlUsdt, 0),
    meanBps: bps.length ? bps.reduce((a, b) => a + b, 0) / bps.length : 0,
    medianBps: median(bps),
    worstBps: bps.length ? Math.min(...bps) : 0,
    bestBps: bps.length ? Math.max(...bps) : 0,
    meanHoldHours: trips.length ? trips.reduce((sum, t) => sum + t.holdHours, 0) / trips.length : 0,
  };
}

function groupBy(trips: readonly RoundTrip[], key: (trip: RoundTrip) => string): Record<string, GroupStats> {
  const groups = new Map<string, RoundTrip[]>();
  for (const trip of trips) {
    const k = key(trip);
    groups.set(k, [...(groups.get(k) ?? []), trip]);
  }
  return Object.fromEntries([...groups.entries()].sort().map(([k, list]) => [k, groupStats(list)]));
}

/** Largest fall from a running peak, as a positive percentage. */
export function maxDrawdownPct(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    else if (peak > 0 && (peak - value) / peak > worst) worst = (peak - value) / peak;
  }
  return worst * 100;
}

const executedAt = (decision: DecisionRecord) =>
  decision.execution?.blockNumber !== undefined ? timestampOfBlock(Number(decision.execution.blockNumber)) : Math.floor(decision.at / 1000);

/**
 * Groups trades into round trips: from the first buy of a position to the sale that
 * empties it. A position can be built by several buys and, when the pool cannot take it
 * in one go, closed by several sales.
 */
export function roundTrips(decisions: readonly DecisionRecord[]): RoundTrip[] {
  const trips: RoundTrip[] = [];
  let open: { first: DecisionRecord; openedAt: number; buys: number; sells: number; cost: bigint; proceeds: bigint; held: bigint } | undefined;

  for (const decision of decisions) {
    const execution = decision.execution;
    if (execution?.status !== "sent" || !execution.baseAmount || !execution.assetAmount) continue;

    if (decision.candidate.side === "buy") {
      open ??= { first: decision, openedAt: executedAt(decision), buys: 0, sells: 0, cost: 0n, proceeds: 0n, held: 0n };
      open.buys += 1;
      open.cost += execution.baseAmount;
      open.held += execution.assetAmount;
    } else if (open) {
      open.sells += 1;
      open.proceeds += execution.baseAmount;
      open.held -= execution.assetAmount;
      if (open.held > 0n) continue;

      const cost = Number(open.cost) / 1e6;
      const proceeds = Number(open.proceeds) / 1e6;
      const closedAt = executedAt(decision);
      const entry = open.first;
      trips.push({
        entryKind: entry.candidate.kind,
        exitKind: decision.candidate.kind,
        openedAt: open.openedAt,
        closedAt,
        buys: open.buys,
        sells: open.sells,
        costUsdt: cost,
        proceedsUsdt: proceeds,
        pnlUsdt: proceeds - cost,
        pnlBps: (proceeds / cost - 1) * 10_000,
        holdHours: (closedAt - open.openedAt) / 3600,
        entryBasisBps: entry.market.basisBps,
        entryNetEdgeBps: entry.gate.netEdgeBps,
        entryGateFailures: entry.gate.checks.filter((c) => !c.ok).map((c) => c.name),
        referenceMoveBps:
          entry.market.cexMid && decision.market.cexMid ? (decision.market.cexMid / entry.market.cexMid - 1) * 10_000 : undefined,
        dexMoveBps: (decision.market.dexSpot / entry.market.dexSpot - 1) * 10_000,
      });
      open = undefined;
    }
  }
  return trips;
}

export function summarize(result: RunResult): { summary: Summary; trips: RoundTrip[] } {
  const { options, equity, decisions } = result;
  const trips = roundTrips(decisions);
  const deposit = options.depositUsdt;
  const final = result.final.liquid - result.final.gasUsdt;

  const executions: Record<string, number> = {};
  let poolFees = 0;
  for (const decision of decisions) {
    const execution = decision.execution;
    if (!execution) continue;
    const key = `${decision.candidate.kind}:${execution.status}`;
    executions[key] = (executions[key] ?? 0) + 1;
    if (execution.status === "sent" && execution.baseAmount) {
      // The pool keeps 0.3% of the input: of the USDT on a buy, of the asset (worth this much) on a sale.
      const notional = Number(execution.baseAmount) / 1e6;
      poolFees += decision.candidate.side === "buy" ? notional * 0.003 : (notional / 0.997) * 0.003;
    }
  }

  const gate: Record<string, Record<string, number>> = {};
  for (const sighting of result.sightings) {
    const bucket = (gate[sighting.kind] ??= {});
    const outcome = sighting.ok ? "passed" : (sighting.failed[0] ?? "rejected");
    bucket[outcome] = (bucket[outcome] ?? 0) + 1;
  }

  const monthly: Summary["monthly"] = [];
  let monthStart = deposit;
  let current = "";
  let last: EquityPoint | undefined;
  for (const point of equity) {
    const key = iso(point.t).slice(0, 7);
    if (current && key !== current && last) {
      const end = last.liquid - last.gas;
      monthly.push({ month: current, returnPct: (end / monthStart - 1) * 100 });
      monthStart = end;
    }
    current = key;
    last = point;
  }
  if (current) monthly.push({ month: current, returnPct: (final / monthStart - 1) * 100 });

  const inMarket = equity.filter((p) => p.exposure > 0.001);
  const summary: Summary = {
    label: options.label,
    arm: options.arm,
    from: iso(options.from),
    to: iso(options.to),
    days: (options.to - options.from) / 86_400,
    depositUsdt: deposit,
    finalUsdt: final,
    returnPct: (final / deposit - 1) * 100,
    returnBeforeGasPct: (result.final.liquid / deposit - 1) * 100,
    gasUsdt: result.final.gasUsdt,
    poolFeesUsdt: poolFees,
    maxDrawdownPct: maxDrawdownPct([deposit, ...equity.map((p) => p.nav - p.gas)]),
    maxDrawdownLiquidPct: maxDrawdownPct([deposit, ...equity.map((p) => p.liquid - p.gas)]),
    timeInMarketPct: equity.length ? (inMarket.length / equity.length) * 100 : 0,
    meanExposurePct: equity.length ? (equity.reduce((sum, p) => sum + p.exposure, 0) / equity.length) * 100 : 0,
    executions,
    transactions: result.counters.transactions,
    revertedTransactions: result.counters.revertedTransactions,
    roundTrips: groupStats(trips),
    byEntryKind: groupBy(trips, (t) => t.entryKind),
    byExitKind: groupBy(trips, (t) => t.exitKind),
    gate,
    monthly,
    openPositionUsdt: result.final.openPositionUsdt,
    halted: result.final.halted,
    counters: result.counters,
  };
  return { summary, trips };
}

export interface Baseline {
  label: string;
  returnPct: number;
  maxDrawdownPct: number;
  monthly: Array<{ month: string; returnPct: number }>;
}

/**
 * What simply holding would have done over the same period, from the exchange reference
 * price alone: no fees, no slippage. `weight` is the share of the vault put into HSK.
 */
export function holdBaseline(label: string, prices: ReadonlyArray<{ t: number; price: number }>, weight: number): Baseline {
  if (prices.length === 0) return { label, returnPct: 0, maxDrawdownPct: 0, monthly: [] };
  const start = prices[0]!.price;
  const value = (price: number) => 1 - weight + (weight * price) / start;

  const monthly: Baseline["monthly"] = [];
  let monthStart = 1;
  let current = "";
  let last = 1;
  for (const point of prices) {
    const key = iso(point.t).slice(0, 7);
    if (current && key !== current) {
      monthly.push({ month: current, returnPct: (last / monthStart - 1) * 100 });
      monthStart = last;
    }
    current = key;
    last = value(point.price);
  }
  monthly.push({ month: current, returnPct: (last / monthStart - 1) * 100 });

  return {
    label,
    returnPct: (last - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(prices.map((p) => value(p.price))),
    monthly,
  };
}
