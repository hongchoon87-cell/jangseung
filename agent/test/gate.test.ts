import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateQuote, verify, type Quoter } from "../src/gate.ts";
import type { Candidate } from "../src/types.ts";
import { NOW, portfolio, position, settings, snapshot, USDT, whskMarket } from "./fixtures.ts";

const buy = (kind: Candidate["kind"] = "basis-entry", amountIn = 50n * USDT): Candidate => ({
  id: "t",
  kind,
  side: "buy",
  symbol: "WHSK",
  amountIn,
  trigger: "test",
});

/** A quote for 50 USDT at the given realised price. */
const quoteAt = (price: number) => ({ amountOut: BigInt(Math.round((50 / price) * 1e6)) * 10n ** 12n, effectivePrice: price });

/** The gate must reject before it ever needs a quote, so asking for one is a test failure. */
const noQuote: Quoter = () => assert.fail("the gate asked for a quote");

function failed(verdict: { checks: { name: string; ok: boolean }[] }): string[] {
  return verdict.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe("gate: checks that need no quote", () => {
  const ctx = (overrides = {}) => ({
    quoter: noQuote,
    snapshot: snapshot(),
    portfolio: portfolio(),
    settings: settings(),
    now: NOW,
    ...overrides,
  });

  it("stops a buy when the daily count or the spacing is used up", async () => {
    const full = await verify(buy(), ctx({ portfolio: portfolio({ buysToday: 4 }) }));
    assert.deepEqual(failed(full), ["frequency"], "the owner allows 4 a day although the vault allows 12");

    const tooSoon = await verify(buy(), ctx({ portfolio: portfolio({ lastBuyAt: NOW / 1000 - 600 }) }));
    assert.deepEqual(failed(tooSoon), ["frequency"], "15 minutes are required, 10 have passed");
  });

  it("stops a buy larger than the vault's caps or the idle balance", async () => {
    assert.deepEqual(failed(await verify(buy("basis-entry", 101n * USDT), ctx())), ["size-limits"]);
    const poor = portfolio({ idleBase: 10n * USDT });
    assert.deepEqual(failed(await verify(buy(), ctx({ portfolio: poor }))), ["size-limits"]);
  });

  it("stops a buy while the breaker is tripped or the asset is locked", async () => {
    assert.deepEqual(failed(await verify(buy(), ctx({ portfolio: portfolio({ halted: true }) }))), ["breaker"]);
    const locked = portfolio({ positions: [position("WHSK", { lockedUntil: NOW / 1000 + 60 })] });
    assert.deepEqual(failed(await verify(buy(), ctx({ portfolio: locked }))), ["asset-allowed"]);
  });

  it("refuses to act on an old or missing exchange quote", async () => {
    const stale = whskMarket();
    stale.cex = { ...stale.cex!, fetchedAt: NOW - 30_000 };
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: snapshot([stale]) }))), ["reference-fresh"]);

    const missing = whskMarket({ cex: undefined });
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: snapshot([missing]) }))), ["reference-fresh"]);
  });

  it("refuses a reference price that a fresh oracle contradicts, and ignores a stale oracle", async () => {
    const contradicted = whskMarket({ oracle: { price: 0.0775, updatedAt: 0, ageSeconds: 600 } });
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: snapshot([contradicted]) }))), ["reference-sane"]);

    // The same disagreement from a ten-hour-old oracle says nothing about now.
    const staleOracle = whskMarket({ oracle: { price: 0.0775, updatedAt: 0, ageSeconds: 36_000 } });
    const verdict = await verify(buy("basis-entry", 2_000n * USDT), ctx({ snapshot: snapshot([staleOracle]) }));
    assert.deepEqual(failed(verdict), ["size-limits"], "only the deliberately oversized amount fails");
  });

  it("refuses a wide exchange spread or exchanges that disagree", async () => {
    const wide = whskMarket();
    wide.cex = { ...wide.cex!, spreadBps: 90 };
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: snapshot([wide]) }))), ["reference-sane"]);

    const split = whskMarket();
    split.cex = { ...split.cex!, dispersionBps: 120 };
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: snapshot([split]) }))), ["reference-sane"]);
  });

  it("treats an implausibly large gap as a fault rather than a bargain", async () => {
    // Seen on the fork: after a 10% sell-off the pool sat 1,237 bps under the exchanges and
    // the rule wanted to buy at full size.
    const broken = whskMarket({ dexSpot: 0.0715, dexTwap: 0.0715, basisBps: -1237 });
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: snapshot([broken]) }))), ["gap-plausible"]);
  });

  it("refuses chain data that is too old", async () => {
    const old = { ...snapshot(), blockTimestamp: NOW / 1000 - 120 };
    assert.deepEqual(failed(await verify(buy(), ctx({ snapshot: old }))), ["chain-fresh"]);
  });
});

describe("gate: price and edge", () => {
  const ctx = { snapshot: snapshot(), portfolio: portfolio(), settings: settings() };

  it("accepts a gap buy whose gain survives both fees", () => {
    // DEX at 0.0790 with the exchange at 0.0800: buying costs 0.0790 x 1.003.
    const market = whskMarket({ dexSpot: 0.079, dexTwap: 0.079, basisBps: -125 });
    const verdict = evaluateQuote(buy(), market, ctx, quoteAt(0.079 * 1.003), 30);
    assert.equal(verdict.ok, true);
    // 95 bps under the exchange after buying, less 30 bps to sell and two swaps' gas.
    // At 500 gwei a swap costs about 0.016 USDT, which is 3.2 bps of a 50 USDT trade.
    assert.ok(verdict.netEdgeBps! > 57 && verdict.netEdgeBps! < 61, `net edge ${verdict.netEdgeBps}`);
    assert.ok(verdict.gasBps! > 3 && verdict.gasBps! < 3.5, `gas ${verdict.gasBps}`);
    assert.ok(Math.abs(verdict.impactBps!) < 0.5);
  });

  it("rejects a gap that is real but smaller than its costs", () => {
    const market = whskMarket({ dexSpot: 0.0795, dexTwap: 0.0795, basisBps: -62 });
    const verdict = evaluateQuote(buy(), market, ctx, quoteAt(0.0795 * 1.003), 30);
    assert.deepEqual(failed(verdict), ["net-edge"]);
  });

  it("rejects a thin pool: the gap exists but the fill eats it", () => {
    // 80 bps of price impact on top of the fee.
    const market = whskMarket({ dexSpot: 0.079, dexTwap: 0.079, basisBps: -125 });
    const verdict = evaluateQuote(buy(), market, ctx, quoteAt(0.079 * 1.011), 30);
    assert.deepEqual(failed(verdict), ["twap-floor", "net-edge"]);
  });

  it("stops short of the vault's TWAP floor so the transaction cannot revert", () => {
    // The pool was just pushed up: spot is 95 bps over the TWAP. With the fee the fill is
    // about 125 bps worse than the TWAP, and the vault would revert beyond 100.
    const market = whskMarket({ dexSpot: 0.08076, dexTwap: 0.08, basisBps: 95 });
    const verdict = evaluateQuote(buy("trend-entry"), market, ctx, quoteAt(0.08076 * 1.003), 30);
    assert.ok(failed(verdict).includes("twap-floor"));
    assert.ok(verdict.slippageVsTwapBps! > 100);

    // 55 bps over the TWAP plus the fee is 85 bps: inside the agent's 90 bps stop line.
    const mild = whskMarket({ dexSpot: 0.08044, dexTwap: 0.08, basisBps: 55 });
    const ok = evaluateQuote(buy("trend-entry"), mild, ctx, quoteAt(0.08044 * 1.003), 30);
    assert.ok(!failed(ok).includes("twap-floor"));
  });

  it("caps the round-trip cost of a trend buy and refuses to pay a premium", () => {
    const fair = evaluateQuote(buy("trend-entry"), whskMarket(), ctx, quoteAt(0.08 * 1.003), 30);
    assert.equal(fair.ok, true, "two fees and gas come to about 62 bps, under the 85 bps cap");

    const pricey = whskMarket({ dexSpot: 0.0806, dexTwap: 0.0806, basisBps: 75 });
    const verdict = evaluateQuote(buy("trend-entry"), pricey, ctx, quoteAt(0.0806 * 1.003), 30);
    assert.deepEqual(failed(verdict), ["no-premium"]);
  });

  it("measures a sale against the exchange after fee and impact", () => {
    const sell: Candidate = { id: "t", kind: "basis-exit", side: "sell", symbol: "WHSK", amountIn: 625n * 10n ** 18n, trigger: "test" };
    const rich = whskMarket({ dexSpot: 0.0808, dexTwap: 0.0808, basisBps: 100 });
    const quoted = { amountOut: BigInt(Math.round(625 * 0.0808 * 0.997 * 1e6)), effectivePrice: 0.0808 * 0.997 };
    const verdict = evaluateQuote(sell, rich, ctx, quoted, 30);
    assert.equal(verdict.ok, true);
    assert.ok(verdict.netEdgeBps! > 65 && verdict.netEdgeBps! < 70, `net edge ${verdict.netEdgeBps}`);
  });
});
