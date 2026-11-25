import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SafetyCall } from "../src/executor.ts";
import { runTick, type Memory, type Ports } from "../src/pipeline.ts";
import type { DecisionRecord, Execution, GateVerdict, Judgment, MarketSnapshot, Settings } from "../src/types.ts";
import { NOW, portfolio, position, settings, snapshot, USDT, whskMarket } from "./fixtures.ts";

const MINUTE = 60_000;
const approve: Judgment = { source: "rule", action: "approve", sizeFraction: 1, confidence: 0.5, rationale: "test", riskFlags: [] };
const passed: GateVerdict = { ok: true, checks: [], effectivePrice: 0.0792, netEdgeBps: 60 };

/** WHSK trading 1% under the exchanges: a gap buy candidate. */
const gap = () => whskMarket({ dexSpot: 0.0792, basisBps: -100 });
/** A WHSK position whose stop-loss the vault says has been reached. */
const stopped = () => position("WHSK", { balance: 10n ** 21n, value: 94n * USDT, cost: 100n * USDT, stopLossReached: true });

/**
 * The pipeline with every port replaced by a recorder. Tests set what the vault and the
 * market look like, then call `tick(minutes)` to run one pass at that time.
 */
function harness(custom: Partial<Ports> = {}, owner: Settings = settings()) {
  const world = { portfolio: portfolio(), market: snapshot() as MarketSnapshot };
  const seen = { reads: 0, verified: [] as string[], judged: 0, executed: [] as Array<{ kind: string; amountIn: bigint }>, safety: [] as SafetyCall[] };
  const records: DecisionRecord[] = [];
  const memory: Memory = { quiet: new Map(), decisions: records };

  const ports: Ports = {
    async readPortfolio() {
      seen.reads += 1;
      return world.portfolio;
    },
    async collectMarket() {
      return world.market;
    },
    async verify(candidate) {
      seen.verified.push(candidate.kind);
      return passed;
    },
    async judge() {
      seen.judged += 1;
      return approve;
    },
    async executeTrade(candidate, amountIn): Promise<Execution> {
      seen.executed.push({ kind: candidate.kind, amountIn });
      return { status: "sent", baseAmount: amountIn, assetAmount: 1n };
    },
    async runSafetyCall(call): Promise<Execution> {
      seen.safety.push(call);
      return { status: "sent" };
    },
    ...custom,
  };

  return {
    world,
    seen,
    records,
    tick(minutes = 0) {
      world.market = { ...world.market, takenAt: NOW + minutes * MINUTE };
      return runTick(ports, owner, memory, (decision) => void records.push(decision));
    },
  };
}

describe("pipeline: one pass", () => {
  it("does nothing in a quiet market", async () => {
    const h = harness();
    const result = await h.tick();
    assert.equal(result.portfolio, h.world.portfolio);
    assert.deepEqual([h.seen.reads, h.seen.verified.length, h.seen.executed.length, h.records.length], [1, 0, 0, 0]);
  });

  it("takes a candidate through gate, judgment and execution, then reads the vault again", async () => {
    const h = harness();
    h.world.market = snapshot([gap()]);
    await h.tick();

    assert.deepEqual(h.seen.verified, ["basis-entry"]);
    assert.equal(h.seen.judged, 1);
    assert.deepEqual(h.seen.executed, [{ kind: "basis-entry", amountIn: 50n * USDT }]);
    assert.equal(h.seen.reads, 2, "the vault changed, so it is read again");

    const [record] = h.records;
    assert.equal(record?.execution?.status, "sent");
    assert.match(record!.memo!, /^0x[0-9a-f]{64}$/);
    assert.equal(record?.judgment?.action, "approve");
  });

  it("scales the size by the judgment and trades nothing on a veto", async () => {
    const reduce = harness({ judge: async () => ({ ...approve, action: "reduce", sizeFraction: 0.4 }) });
    reduce.world.market = snapshot([gap()]);
    await reduce.tick();
    assert.deepEqual(reduce.seen.executed, [{ kind: "basis-entry", amountIn: 20n * USDT }]);

    const veto = harness({ judge: async () => ({ ...approve, action: "veto", sizeFraction: 0 }) });
    veto.world.market = snapshot([gap()]);
    await veto.tick();
    assert.equal(veto.seen.executed.length, 0);
    assert.equal(veto.records[0]?.judgment?.action, "veto");

    // A vetoed candidate is left alone for ten minutes: no second opinion on every tick.
    await veto.tick(5);
    assert.equal(veto.seen.verified.length, 1);
    await veto.tick(11);
    assert.equal(veto.seen.verified.length, 2);
  });

  it("makes one trade per pass, exits first", async () => {
    const h = harness({}, settings({ targetAssets: ["WHSK", "WBTC"] }));
    // WHSK is held and past its soft stop; WBTC shows a gap worth buying.
    h.world.portfolio = portfolio({ positions: [position("WHSK", { balance: 10n ** 21n, value: 96n * USDT, cost: 100n * USDT }), position("WETH"), position("WBTC")] });
    h.world.market = snapshot([whskMarket(), { ...whskMarket({ dexSpot: 60_000, dexTwap: 60_000, basisBps: -100 }), symbol: "WBTC" }]);
    await h.tick();
    assert.deepEqual(h.seen.executed.map((e) => e.kind), ["soft-stop"]);
  });

  it("writes a gate rejection down once, not on every pass", async () => {
    const rejected: GateVerdict = { ok: false, checks: [{ name: "net-edge", ok: false, detail: "too small" }] };
    const h = harness({ verify: async () => rejected });
    h.world.market = snapshot([gap()]);

    await h.tick(0);
    await h.tick(1);
    await h.tick(9);
    assert.equal(h.records.length, 1);
    assert.equal(h.seen.executed.length, 0);
    await h.tick(11);
    assert.equal(h.records.length, 2);
  });

  it("does not retry a failed trade for two minutes", async () => {
    let verified = 0;
    const h = harness({
      verify: async () => {
        verified += 1;
        return passed;
      },
      executeTrade: async () => ({ status: "failed", error: "vault rejected the call: TradeTooLarge(1, 0)" }),
    });
    h.world.market = snapshot([gap()]);

    await h.tick(0);
    await h.tick(1);
    assert.equal(verified, 1);
    await h.tick(2.5);
    assert.equal(verified, 2);
  });

  it("proposes nothing while paused", async () => {
    const h = harness({}, settings({ paused: true }));
    h.world.market = snapshot([gap()]);
    await h.tick();
    assert.equal(h.seen.verified.length, 0);
  });
});

describe("pipeline: the vault's own safety rules", () => {
  it("fires the stop-loss for as much as the pool can take, even while paused", async () => {
    const h = harness({}, settings({ paused: true }));
    const held = stopped();
    h.world.portfolio = portfolio({ positions: [held] });
    await h.tick();

    // Amount 0 tells the vault to size the sale itself.
    assert.deepEqual(h.seen.safety, [{ functionName: "triggerStopLoss", args: [held.address, 0n] }]);
    assert.equal(h.records[0]?.candidate.kind, "hard-stop");
    assert.equal(h.seen.reads, 2, "the stop changed the vault, so it is read again");
  });

  // The next two tests pause the agent so that only the vault's own rule acts: the rules
  // would otherwise propose their own early sale of the same losing position.

  it("keeps selling on every pass while the position stays past its stop", async () => {
    // The vault sells a part each time; the position stays flagged until it is gone.
    const h = harness({}, settings({ paused: true }));
    h.world.portfolio = portfolio({ positions: [stopped()] });

    await h.tick(0);
    await h.tick(0.5);
    await h.tick(1);
    assert.equal(h.seen.safety.length, 3);
    assert.equal(h.records.length, 3, "every sale that went out is on record");
  });

  it("retries a stop that cannot fire yet, but records the failure only now and then", async () => {
    let attempts = 0;
    const h = harness(
      {
        runSafetyCall: async () => {
          attempts += 1;
          return { status: "failed", error: "vault rejected the call: NoRoomToSell()" };
        },
      },
      settings({ paused: true }),
    );
    h.world.portfolio = portfolio({ positions: [stopped()] });

    for (const minute of [0, 0.5, 1, 5, 9]) await h.tick(minute);
    assert.equal(attempts, 5, "tried on every pass");
    assert.equal(h.records.length, 1, "one record for the first failure");
    assert.equal(h.seen.reads, 5, "nothing changed, so the vault is read once per pass");

    await h.tick(11);
    assert.equal(h.records.length, 2);
  });

  it("records a breached drawdown limit on-chain once", async () => {
    const h = harness();
    h.world.portfolio = portfolio({ drawdownBps: 1_050 });
    await h.tick(0);
    await h.tick(1);
    assert.deepEqual(h.seen.safety, [{ functionName: "checkpoint", args: [] }]);
    assert.equal(h.records[0]?.candidate.kind, "breaker");

    // Once the vault is halted there is nothing left to record.
    h.world.portfolio = portfolio({ drawdownBps: 1_050, halted: true });
    await h.tick(20);
    assert.equal(h.seen.safety.length, 1);
  });
});
