import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assetBySymbol } from "../src/config.ts";
import { bps, ema, realizedVolBps, rsi } from "../src/indicators.ts";
import { consensus, meanTick, priceFromSqrtX96, priceFromTick, trendFromCloses } from "../src/market.ts";
import { applySettings, DEFAULT_SETTINGS, effectiveLimits } from "../src/settings.ts";
import { canonicalJson } from "../src/store.ts";
import { policy } from "./fixtures.ts";

const near = (actual: number, expected: number, tolerance: number) =>
  assert.ok(Math.abs(actual / expected - 1) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe("pool price maths", () => {
  const whsk = assetBySymbol("WHSK")!;
  const wbtc = assetBySymbol("WBTC")!;

  it("reads the prices seen on mainnet at block 30,581,469", () => {
    // Ticks read from the HSKSwap pools; one tick is 0.01%.
    near(priceFromTick(-301483, whsk), 0.0808, 2e-4);
    near(priceFromTick(64273, wbtc), 61_830, 2e-4);
  });

  it("agrees between the sqrt price and the tick it falls in", () => {
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(8.08e-14) * 2 ** 96));
    near(priceFromSqrtX96(sqrtPriceX96, whsk), 0.0808, 1e-6);
  });

  it("averages ticks over the window and rounds toward negative infinity", () => {
    assert.equal(meanTick([0n, -301483n * 300n], 300), -301483);
    assert.equal(meanTick([0n, -301483n * 300n - 1n], 300), -301484);
    assert.equal(meanTick([1_000n, 1_000n + 64273n * 300n + 299n], 300), 64273);
  });
});

describe("reference price from several exchanges", () => {
  // Quotes seen on 2026-11-24: three venues near 0.0815 and HashKey Global with a 150 bps book.
  const live = [
    { venue: "hashkey", bid: 0.0802, ask: 0.0814 },
    { venue: "gate", bid: 0.08155, ask: 0.08172 },
    { venue: "kucoin", bid: 0.0815, ask: 0.0817 },
    { venue: "mexc", bid: 0.08131, ask: 0.08138 },
  ];

  it("drops the venue with a wide book and takes the median of the rest", () => {
    const quote = consensus("HSK", live, 123);
    assert.deepEqual(quote.sources, ["gate", "kucoin", "mexc"]);
    near(quote.mid, 0.0816, 1e-9);
    near(quote.bid, 0.0815, 1e-9);
    assert.ok(quote.dispersionBps > 30 && quote.dispersionBps < 40, `dispersion ${quote.dispersionBps}`);
    assert.equal(quote.fetchedAt, 123);
  });

  it("refuses to name a price from fewer than two usable venues", () => {
    assert.throws(() => consensus("HSK", live.slice(0, 2)), /only 1 of 2 exchanges/);
    assert.throws(() => consensus("HSK", [{ venue: "gate", bid: 0, ask: Number.NaN }]), /only 0 of 1/);
    assert.throws(() => consensus("HSK", [{ venue: "a", bid: 2, ask: 1 }, { venue: "b", bid: 1, ask: 1.001 }]), /only 1 of 2/);
  });
});

describe("indicators", () => {
  it("handles flat, rising and falling series", () => {
    const flat = Array.from({ length: 80 }, () => 5);
    const rising = Array.from({ length: 80 }, (_, i) => 100 + i);
    assert.equal(ema(flat, 12), 5);
    assert.equal(rsi(flat), 50);
    assert.equal(rsi(rising), 100);
    assert.equal(rsi([...rising].reverse()), 0);
    assert.equal(realizedVolBps(flat, 12), 0);
    near(bps(101, 100), 100, 1e-9);
  });

  it("needs sixty finished candles before it reports a trend", () => {
    assert.equal(trendFromCloses(Array.from({ length: 59 }, () => 1), 0), undefined);
    const rising = Array.from({ length: 120 }, (_, i) => 100 * 1.001 ** i);
    const trend = trendFromCloses(rising, 123)!;
    assert.ok(trend.trendBps > 0 && trend.ret1hBps > 100 && trend.rsi14 === 100);
    assert.equal(trend.asOf, 123);
  });
});

describe("owner preferences stay inside the on-chain policy", () => {
  it("caps buy size and daily count at the vault's limits and says so", () => {
    const { settings, notes } = applySettings(DEFAULT_SETTINGS, { positionSizeBps: 2500, maxTradesPerDay: 50 }, policy);
    assert.equal(settings.positionSizeBps, policy.maxTradeBps);
    assert.equal(settings.maxTradesPerDay, policy.maxTradesPerDay);
    assert.equal(notes.length, 2);
  });

  it("raises the spacing to the vault's cooldown", () => {
    const { settings, notes } = applySettings(DEFAULT_SETTINGS, { minMinutesBetweenTrades: 1 }, policy);
    assert.equal(settings.minMinutesBetweenTrades, 5);
    assert.equal(notes.length, 1);
  });

  it("accepts stricter values unchanged and without notes", () => {
    const patch = { positionSizeBps: 300, maxTradesPerDay: 2, minMinutesBetweenTrades: 30, paused: true } as const;
    const { settings, notes } = applySettings(DEFAULT_SETTINGS, patch, policy);
    assert.deepEqual(notes, []);
    assert.deepEqual(
      [settings.positionSizeBps, settings.maxTradesPerDay, settings.minMinutesBetweenTrades, settings.paused],
      [300, 2, 30, true],
    );
  });

  it("ignores values it does not understand", () => {
    const patch = { targetAssets: ["WHSK", "DOGE"], riskAppetite: "yolo", positionSizeBps: -5 } as never;
    const { settings, notes } = applySettings(DEFAULT_SETTINGS, patch, policy);
    assert.deepEqual(settings.targetAssets, ["WHSK"]);
    assert.equal(settings.riskAppetite, DEFAULT_SETTINGS.riskAppetite);
    assert.equal(settings.positionSizeBps, DEFAULT_SETTINGS.positionSizeBps);
    assert.equal(notes.length, 3);
  });

  it("reports the stricter of preference and policy as the limit in force", () => {
    const loose = { ...DEFAULT_SETTINGS, positionSizeBps: 9999, maxTradesPerDay: 99, minMinutesBetweenTrades: 0 };
    assert.deepEqual(effectiveLimits(loose, policy), {
      positionSizeBps: 1000,
      maxTradesPerDay: 12,
      minSecondsBetweenTrades: 300,
    });
  });
});

describe("decision hashing", () => {
  it("does not depend on key order and keeps token amounts exact", () => {
    const a = canonicalJson({ b: 1, a: { y: 2n ** 80n, x: [1, { d: 1, c: 2 }] }, skipped: undefined });
    const b = canonicalJson({ a: { x: [1, { c: 2, d: 1 }], y: 2n ** 80n }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"x":[1,{"c":2,"d":1}],"y":"1208925819614629174706176"},"b":1}');
  });
});
