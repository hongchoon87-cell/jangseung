import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../agent/src/settings.ts";
import { ASSUMED_ORACLE_SLOTS, timestampOfBlock, VENUES, type Venue } from "../config.ts";
import { loadHistory, type Candle, type History, type PoolEvent } from "../data.ts";
import { runBacktest, type Arm, type RunResult } from "../engine.ts";
import { roundTrips, summarize } from "../metrics.ts";
import { PoolReplay } from "../pool.ts";
import { ReferenceHistory } from "../reference.ts";
import { policy } from "./helpers.ts";

// These tests replay a week of the committed history (inside the development period).
const history = loadHistory();
const FROM = Date.UTC(2026, 7, 17) / 1000;
const TO = Date.UTC(2026, 7, 24) / 1000;

function run(source: Pick<History, "events" | "candles">, arm: Arm = "gate+sizing", to = TO): Promise<RunResult> {
  return runBacktest(new PoolReplay(source.events, { oracleSlots: ASSUMED_ORACLE_SLOTS }), new ReferenceHistory(source.candles), {
    label: "test",
    from: FROM,
    to,
    arm,
    policy,
    settings: DEFAULT_SETTINGS,
    depositUsdt: 1_000,
  });
}

/** Everything a decision could have been influenced by: the decisions, what the gate saw, the equity path. */
const fingerprint = (result: RunResult) =>
  JSON.stringify([result.decisions, result.sightings, result.equity, result.final], (_k, v) => (typeof v === "bigint" ? v.toString() : v));

describe("no information from the future", () => {
  it("the week trades at all, so the comparison below means something", async () => {
    const result = await run(history);
    const sent = result.decisions.filter((d) => d.execution?.status === "sent");
    assert.ok(sent.length >= 6, `only ${sent.length} trades in the test week`);
  });

  it("deleting everything after the period changes nothing", async () => {
    const cut: Pick<History, "events" | "candles"> = {
      events: history.events.filter((e) => timestampOfBlock(e.block) < TO),
      candles: Object.fromEntries(VENUES.map((v) => [v, history.candles[v].filter((c) => c.t < TO)])) as Record<Venue, Candle[]>,
    };
    assert.ok(cut.events.length < history.events.length);
    assert.equal(fingerprint(await run(cut)), fingerprint(await run(history)));
  });

  it("replacing everything after the period with nonsense changes nothing", async () => {
    // Exchange prices triple and the pool is swapped to a far-away price right after the cut.
    const poisoned: Pick<History, "events" | "candles"> = {
      events: [
        ...history.events.filter((e) => timestampOfBlock(e.block) < TO),
        ...history.events
          .filter((e): e is Extract<PoolEvent, { kind: "swap" }> => e.kind === "swap" && timestampOfBlock(e.block) >= TO)
          .map((e) => ({ ...e, sqrtPriceX96: e.sqrtPriceX96 * 2n, tick: e.tick + 13_863 })),
      ],
      candles: Object.fromEntries(
        VENUES.map((v) => [v, history.candles[v].map((c) => (c.t < TO ? c : { ...c, c: String(Number(c.c) * 3) }))]),
      ) as Record<Venue, Candle[]>,
    };
    assert.equal(fingerprint(await run(poisoned)), fingerprint(await run(history)));
  });

  it("a shorter run is the exact beginning of a longer one", async () => {
    const half = FROM + 3 * 86_400;
    const short = await run(history, "gate+sizing", half);
    const long = await run(history);
    const until = (result: RunResult) => JSON.stringify(result.decisions.filter((d) => d.at < half * 1000), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.equal(until(short), until(long));
  });
});

describe("accounting", () => {
  it("the final balance is the deposit, less every buy, plus every sale and what is still held", async () => {
    const result = await run(history);
    let idle = 1_000;
    let trades = 0;
    for (const decision of result.decisions) {
      const execution = decision.execution;
      if (execution?.status !== "sent" || !execution.baseAmount) continue;
      trades += 1;
      idle += (decision.candidate.side === "buy" ? -1 : 1) * (Number(execution.baseAmount) / 1e6);
    }
    assert.ok(trades >= 6);
    const expected = idle + result.final.openPositionUsdt;
    assert.ok(Math.abs(result.final.liquid - expected) < 1e-6, `final ${result.final.liquid}, trades say ${expected}`);
  });

  it("round trips cover every trade up to the last sale that emptied the position", async () => {
    const result = await run(history);
    const trips = roundTrips(result.decisions);
    assert.ok(trips.length >= 2);
    for (const trip of trips) assert.ok(trip.buys >= 1 && trip.sells >= 1 && trip.closedAt > trip.openedAt);

    const lastClose = Math.max(...trips.map((t) => t.closedAt));
    const sent = result.decisions.filter(
      (d) => d.execution?.status === "sent" && d.execution.baseAmount && timestampOfBlock(Number(d.execution.blockNumber)) <= lastClose,
    );
    const total = (side: "buy" | "sell") =>
      sent.filter((d) => d.candidate.side === side).reduce((sum, d) => sum + Number(d.execution!.baseAmount) / 1e6, 0);
    assert.ok(Math.abs(trips.reduce((sum, t) => sum + t.costUsdt, 0) - total("buy")) < 1e-6);
    assert.ok(Math.abs(trips.reduce((sum, t) => sum + t.proceedsUsdt, 0) - total("sell")) < 1e-6);
  });

  it("the same inputs give the same result", async () => {
    assert.equal(fingerprint(await run(history)), fingerprint(await run(history)));
  });

  it("gas is charged on every transaction that lands", async () => {
    const result = await run(history);
    assert.ok(result.counters.transactions > 0);
    assert.ok(result.gasUsdt > 0.005 * result.counters.transactions, `gas ${result.gasUsdt} for ${result.counters.transactions} transactions`);
    assert.ok(summarize(result).summary.returnPct < summarize(result).summary.returnBeforeGasPct);
  });
});

describe("the three arms", () => {
  const sentBuys = (result: RunResult) => result.decisions.filter((d) => d.execution?.status === "sent" && d.candidate.side === "buy");
  const LIMITS = new Set(["agent-active", "breaker", "asset-allowed", "frequency", "size-limits"]);

  it("with the gate, nothing is traded that failed a check", async () => {
    for (const arm of ["gate", "gate+sizing"] as const) {
      const result = await run(history, arm);
      for (const decision of result.decisions) {
        if (decision.execution) assert.ok(decision.gate.ok && decision.gate.checks.every((c) => c.ok), `${arm} traded ${decision.id} past a failed check`);
      }
    }
  });

  it("without the gate, the limit checks still hold and the other failures are kept on record", async () => {
    const result = await run(history, "rule");
    for (const decision of sentBuys(result)) {
      assert.ok(decision.gate.checks.every((c) => c.ok || !LIMITS.has(c.name)), `${decision.id} went past a limit`);
    }
    assert.ok(sentBuys(result).length >= sentBuys(await run(history, "gate")).length);
  });

  it("the sizing step can only shrink a trade", async () => {
    const result = await run(history, "gate+sizing");
    const buys = sentBuys(result);
    assert.ok(buys.length > 0);
    for (const decision of buys) assert.ok(decision.execution!.baseAmount! <= decision.candidate.amountIn);
    assert.ok(buys.some((d) => d.execution!.baseAmount! < d.candidate.amountIn), "the rule sizes at least one trade below the proposal");
    for (const decision of sentBuys(await run(history, "gate"))) assert.equal(decision.execution!.baseAmount, decision.candidate.amountIn);
  });
});
