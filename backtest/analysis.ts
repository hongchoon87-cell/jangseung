// Error analysis: not whether a run made money, but which trades lost it and whether the
// candidates the gate turned away would have done better or worse than those it passed.
import type { CandidateKind } from "../agent/src/types.ts";
import { CANDLE_SECONDS, TIMING } from "./config.ts";
import type { GateSighting, RunResult } from "./engine.ts";
import { groupStats, type GroupStats, type RoundTrip } from "./metrics.ts";
import { quoteSwap, type PoolReplay } from "./pool.ts";
import type { ReferenceHistory } from "./reference.ts";

/** An exchange move smaller than this during a holding period counts as flat. */
const FLAT_BPS = 30;
const POOL_FEE_PIPS = 3000;
const HOURS = [1, 6, 24] as const;
/** A candidate seen again within this long, with the same outcome, is the same episode. */
const EPISODE_GAP_SECONDS = 15 * 60;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function grouped(trips: readonly RoundTrip[], key: (trip: RoundTrip) => string | undefined): Record<string, GroupStats> {
  const groups = new Map<string, RoundTrip[]>();
  for (const trip of trips) {
    const k = key(trip);
    if (k === undefined) continue;
    groups.set(k, [...(groups.get(k) ?? []), trip]);
  }
  return Object.fromEntries([...groups.entries()].sort().map(([k, list]) => [k, groupStats(list)]));
}

/**
 * Where the closed positions made and lost money.
 *   byExchangeMove  a gap trade wins when the DEX rises to meet the exchanges, and loses
 *                   when the exchanges fall to meet the DEX; this separates the two.
 *   byNetEdge       whether a larger measured edge at entry led to a better result.
 *   byGateVerdict   for the rule-only arm: trades the gate would have refused, by the
 *                   first check they failed, next to the ones it would have passed.
 */
export function analyseTrips(trips: readonly RoundTrip[]) {
  const move = (trip: RoundTrip) => {
    if (trip.referenceMoveBps === undefined) return undefined;
    const direction = trip.referenceMoveBps <= -FLAT_BPS ? "exchange fell" : trip.referenceMoveBps >= FLAT_BPS ? "exchange rose" : "exchange flat";
    return `${trip.entryKind}: ${direction}`;
  };
  const edge = (trip: RoundTrip) => {
    if (trip.entryKind !== "basis-entry" || trip.entryNetEdgeBps === undefined) return undefined;
    const e = trip.entryNetEdgeBps;
    return e < 25 ? "net edge under 25 bps" : e < 50 ? "net edge 25 to 50 bps" : e < 100 ? "net edge 50 to 100 bps" : "net edge over 100 bps";
  };
  const verdict = (trip: RoundTrip) => `${trip.entryKind}: ${trip.entryGateFailures[0] ?? "gate would pass"}`;

  const losers = [...trips].sort((a, b) => a.pnlUsdt - b.pnlUsdt).slice(0, 5);
  return {
    byExchangeMove: grouped(trips, move),
    byNetEdge: grouped(trips, edge),
    byGateVerdict: grouped(trips, verdict),
    worstFive: losers.map((t) => ({
      opened: new Date(t.openedAt * 1000).toISOString(),
      entry: t.entryKind,
      exit: t.exitKind,
      pnlUsdt: +t.pnlUsdt.toFixed(4),
      pnlBps: +t.pnlBps.toFixed(0),
      holdHours: +t.holdHours.toFixed(1),
      exchangeMoveBps: t.referenceMoveBps === undefined ? undefined : +t.referenceMoveBps.toFixed(0),
      dexMoveBps: +t.dexMoveBps.toFixed(0),
    })),
  };
}

interface Forward {
  /** Result of buying then and selling later, both fees and impact included, in bps. */
  raw: number;
  /** The same less the exchange price's own change: what the trade made beyond being long the market. */
  excess?: number;
}

interface ForwardStats {
  episodes: number;
  forward: Record<
    string,
    { measured: number; meanBps: number; medianBps: number; positiveShare: number; excessMeanBps: number; excessMedianBps: number }
  >;
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * What would have happened to every buy the rules proposed, whether or not it was traded:
 * the same notional bought at the next block and sold 1, 6 and 24 hours later, through
 * the replayed pool. Grouped by what the gate said. If the gate works, the candidates it
 * refused should look worse than the ones it passed.
 *
 * Uses prices after the decision, so it is analysis only; nothing here feeds a decision.
 */
export function analyseGate(result: RunResult, pool: PoolReplay, reference: ReferenceHistory): Record<string, ForwardStats> {
  const notional = BigInt(Math.round(result.options.depositUsdt * (result.options.settings.positionSizeBps / 10_000) * 1e6));
  const lastSeen = new Map<string, number>();
  const groups = new Map<string, Forward[][]>();
  const episodes = new Map<string, number>();

  const forwardBps = (sighting: GateSighting, hours: number): Forward | undefined => {
    const buyAt = sighting.t + TIMING.executionDelay;
    const sellAt = buyAt + hours * 3600;
    if (sellAt >= result.options.to || sellAt > pool.lastTimestamp) return undefined;
    const bought = quoteSwap(pool.stateAt(buyAt), "buy", notional, POOL_FEE_PIPS);
    if (bought === 0n) return undefined;
    const proceeds = quoteSwap(pool.stateAt(sellAt), "sell", bought, POOL_FEE_PIPS);
    const raw = (Number(proceeds) / Number(notional) - 1) * 10_000;

    const close = Math.floor(sighting.t / CANDLE_SECONDS) * CANDLE_SECONDS;
    const then = reference.quoteAt(close, 0)?.mid;
    const later = reference.quoteAt(close + hours * 3600, 0)?.mid;
    return { raw, excess: then && later ? raw - (later / then - 1) * 10_000 : undefined };
  };

  for (const sighting of result.sightings) {
    if (sighting.side !== "buy") continue;
    const outcome = sighting.ok ? "passed" : (sighting.failed[0] ?? "rejected");
    const key = `${sighting.kind as CandidateKind}: ${outcome}`;
    const previous = lastSeen.get(key);
    lastSeen.set(key, sighting.t);
    if (previous !== undefined && sighting.t - previous <= EPISODE_GAP_SECONDS) continue;

    episodes.set(key, (episodes.get(key) ?? 0) + 1);
    const lists = groups.get(key) ?? HOURS.map(() => []);
    groups.set(key, lists);
    HOURS.forEach((hours, i) => {
      const value = forwardBps(sighting, hours);
      if (value !== undefined) lists[i]!.push(value);
    });
  }

  return Object.fromEntries(
    [...groups.entries()].sort().map(([key, lists]) => [
      key,
      {
        episodes: episodes.get(key) ?? 0,
        forward: Object.fromEntries(
          HOURS.map((hours, i) => {
            const values = lists[i]!.map((v) => v.raw);
            const excess = lists[i]!.flatMap((v) => (v.excess === undefined ? [] : [v.excess]));
            return [
              `${hours}h`,
              {
                measured: values.length,
                meanBps: +mean(values).toFixed(1),
                medianBps: +median(values).toFixed(1),
                positiveShare: values.length ? +(values.filter((v) => v > 0).length / values.length).toFixed(3) : 0,
                excessMeanBps: +mean(excess).toFixed(1),
                excessMedianBps: +median(excess).toFixed(1),
              },
            ];
          }),
        ),
      },
    ]),
  );
}
