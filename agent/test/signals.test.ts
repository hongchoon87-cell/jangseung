import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assetBySymbol } from "../src/config.ts";
import { buySize, generateCandidates, sellAmount, sellCapacity, unrealizedBps } from "../src/signals.ts";
import { policy, portfolio, position, settings, snapshot, USDT, whskMarket } from "./fixtures.ts";

describe("entry signals", () => {
  it("proposes nothing when the DEX and the exchange agree and the trend is flat", () => {
    assert.deepEqual(generateCandidates(snapshot(), portfolio(), settings()), []);
  });

  it("ignores a gap that does not cover two pool fees plus the required edge", () => {
    // Balanced profile needs 2 x 30 + 25 = 85 bps. A 50 bps discount looks like a deal but is not.
    const market = snapshot([whskMarket({ dexSpot: 0.0796, basisBps: -50 })]);
    assert.deepEqual(generateCandidates(market, portfolio(), settings()), []);
  });

  it("proposes a gap buy once the discount clears the bar", () => {
    const market = snapshot([whskMarket({ dexSpot: 0.0792, basisBps: -100 })]);
    const [candidate, ...rest] = generateCandidates(market, portfolio(), settings());
    assert.equal(rest.length, 0);
    assert.equal(candidate?.kind, "basis-entry");
    assert.equal(candidate?.side, "buy");
    assert.equal(candidate?.amountIn, 50n * USDT, "5% of a 1,000 USDT vault");
  });

  it("proposes a trend buy only when average gap, return and RSI all line up", () => {
    const rising = { trendBps: 55, ret1hBps: 40, vol1hBps: 80, rsi14: 62, asOf: 0 };
    const kinds = (trend: typeof rising, basisBps = 0) =>
      generateCandidates(snapshot([whskMarket({ trend, basisBps })]), portfolio(), settings()).map((c) => c.kind);

    assert.deepEqual(kinds(rising), ["trend-entry"]);
    assert.deepEqual(kinds({ ...rising, trendBps: 30 }), [], "gap between averages too small");
    assert.deepEqual(kinds({ ...rising, ret1hBps: -5 }), [], "last hour was down");
    assert.deepEqual(kinds({ ...rising, rsi14: 78 }), [], "overbought");
    assert.deepEqual(kinds(rising, 35), [], "DEX already trades at a premium");
  });

  it("stays out while paused, halted, locked, disabled or off the target list", () => {
    const market = snapshot([whskMarket({ dexSpot: 0.0792, basisBps: -100 })]);
    const none = (p = portfolio(), s = settings()) => assert.deepEqual(generateCandidates(market, p, s), []);

    none(portfolio(), settings({ paused: true }));
    none(portfolio({ halted: true }));
    none(portfolio({ positions: [position("WHSK", { lockedUntil: 2_000_000_000 })] }));
    none(portfolio({ positions: [position("WHSK", { enabled: false })] }));
    none(portfolio(), settings({ targetAssets: ["WBTC"] }));
    none(portfolio(), settings({ strategies: ["trend"] }));
  });
});

describe("buy size", () => {
  it("is the owner's preference when nothing else binds", () => {
    assert.equal(buySize(portfolio(), position("WHSK"), settings({ positionSizeBps: 300 })), 30n * USDT);
  });

  it("stays 1% inside the vault's trade limit, because NAV drifts before the trade lands", () => {
    // The vault allows 100 USDT here. Asking for exactly that reverted on the fork when
    // NAV slipped by 0.04% between reading it and executing.
    assert.equal(buySize(portfolio(), position("WHSK"), settings({ positionSizeBps: 5000 })), 99n * USDT);
    assert.equal(buySize(portfolio(), position("WHSK"), settings({ positionSizeBps: 1000 })), 99n * USDT);
  });

  it("shrinks to the room left under the position cap, the exposure cap and idle funds", () => {
    // Position cap 300, held 280: 1% inside the cap leaves 17.
    const nearCap = position("WHSK", { balance: 1n, value: 280n * USDT, cost: 280n * USDT });
    assert.equal(buySize(portfolio({ positions: [nearCap] }), nearCap, settings()), 17n * USDT);

    // Exposure cap 600, held 580: 1% inside the cap leaves 14.
    const whsk = position("WHSK", { balance: 1n, value: 290n * USDT });
    const wbtc = position("WBTC", { balance: 1n, value: 290n * USDT });
    const weth = position("WETH");
    assert.equal(buySize(portfolio({ positions: [whsk, wbtc, weth] }), weth, settings()), 14n * USDT);

    assert.equal(buySize(portfolio({ idleBase: 7n * USDT }), position("WHSK"), settings()), 7n * USDT);
  });

  it("is zero when a cap is already exceeded", () => {
    const over = position("WHSK", { balance: 1n, value: 320n * USDT });
    assert.equal(buySize(portfolio({ positions: [over] }), over, settings()), 0n);
  });
});

describe("sizing against what the pool can take back", () => {
  const whsk = assetBySymbol("WHSK")!;
  const usdt = (units: bigint) => Number(units) / 1e6;
  // The fixture pool holds about 283,000 USDT a side (liquidity 1e18 at 0.08). With a 0.3%
  // fee and the agent stopping 10 bps inside the vault's 1% limit, 0.607% of that fits in one sale.
  const shallow = (liquidity: bigint) => whskMarket({ poolLiquidity: liquidity });

  it("measures the room for one sale from depth, fee and the slippage limit", () => {
    const capacity = usdt(sellCapacity(whskMarket(), policy, whsk));
    assert.ok(capacity > 1_700 && capacity < 1_735, `got ${capacity}`);
    assert.ok(Math.abs(usdt(sellCapacity(shallow(10n ** 17n), policy, whsk)) - capacity / 10) < 0.01, "a tenth of the depth, a tenth of the room");

    // A pool price already under the TWAP leaves less room, and none at all 0.7% under.
    const half = usdt(sellCapacity(whskMarket({ dexSpot: 0.0798 }), policy, whsk));
    assert.ok(half > 0.5 * capacity && half < 0.65 * capacity, `got ${half}`);
    assert.equal(sellCapacity(whskMarket({ dexSpot: 0.07944 }), policy, whsk), 0n);
  });

  it("stops building a position at half of what one sale could take out", () => {
    // Depth 14,142 USDT: one sale can move 85.9, so the position may reach 42.9.
    const pool = shallow(5n * 10n ** 16n);
    const fresh = usdt(buySize(portfolio(), position("WHSK"), settings(), pool));
    assert.ok(fresh > 42 && fresh < 44, `got ${fresh}`);

    const held = position("WHSK", { balance: 1n, value: 30n * USDT, cost: 30n * USDT });
    const more = usdt(buySize(portfolio({ positions: [held] }), held, settings(), pool));
    assert.ok(more > 12 && more < 14, `got ${more}`);

    assert.equal(buySize(portfolio(), position("WHSK"), settings(), whskMarket()), 50n * USDT, "a deep pool does not bind");
  });

  it("still sizes a gap buy made while the pool sits under its TWAP", () => {
    // The exit comes later; the price standing 1% under the TWAP right now must not zero the buy.
    assert.equal(buySize(portfolio(), position("WHSK"), settings(), whskMarket({ dexSpot: 0.0792 })), 50n * USDT);
  });

  it("sells the whole position when it fits and a part of it when it does not", () => {
    // 5,000 WHSK, worth 400 USDT at 0.08.
    const big = position("WHSK", { balance: 5_000n * 10n ** 18n, value: 400n * USDT, cost: 380n * USDT });
    assert.equal(sellAmount(big, whskMarket(), policy, whsk), big.balance);

    // Depth 28,284 USDT: one sale takes 171.7, sized at 95% of that, which is 40.8% of the position.
    const part = sellAmount(big, shallow(10n ** 17n), policy, whsk);
    const share = Number(part) / Number(big.balance);
    assert.ok(share > 0.40 && share < 0.415, `got ${share}`);

    const [exit] = generateCandidates(snapshot([shallow(10n ** 17n)]), portfolio({ positions: [big] }), settings());
    assert.equal(exit?.kind, "take-profit");
    assert.equal(exit?.amountIn, part);
    assert.match(exit!.trigger, /Selling 41% now/);
  });

  it("proposes no sale at all into an emptied pool", () => {
    // Depth under 3 USDT, as the WHSK pool was for six days in October 2026.
    const big = position("WHSK", { balance: 5_000n * 10n ** 18n, value: 400n * USDT, cost: 380n * USDT });
    const empty = shallow(10n ** 13n);
    assert.equal(sellAmount(big, empty, policy, whsk), 0n);
    assert.deepEqual(generateCandidates(snapshot([empty]), portfolio({ positions: [big] }), settings()), []);
  });
});

describe("exit signals", () => {
  const held = (value: bigint, cost = 100n * USDT) => position("WHSK", { balance: 10n ** 21n, value, cost });
  const kinds = (pos: ReturnType<typeof held>, market = whskMarket(), s = settings()) =>
    generateCandidates(snapshot([market]), portfolio({ positions: [pos] }), s).map((c) => c.kind);

  it("measures unrealised gain against cost", () => {
    assert.equal(Math.round(unrealizedBps(held(97n * USDT))), -300);
    assert.equal(unrealizedBps(position("WHSK")), 0);
  });

  it("sells early at 70% of the vault's stop-loss on a balanced profile", () => {
    // Vault stop-loss is 500 bps, so the soft stop sits at -350 bps.
    assert.deepEqual(kinds(held(97n * USDT)), [], "-300 bps is inside the soft stop");
    assert.deepEqual(kinds(held(96n * USDT)), ["soft-stop"]);
  });

  it("takes profit at the target", () => {
    assert.deepEqual(kinds(held(101n * USDT)), []);
    assert.deepEqual(kinds(held(102n * USDT)), ["take-profit"]);
  });

  it("sells into a DEX premium and on a broken trend", () => {
    assert.deepEqual(kinds(held(100n * USDT), whskMarket({ basisBps: 60 })), ["basis-exit"]);
    assert.deepEqual(kinds(held(100n * USDT), whskMarket({ basisBps: 40 })), [], "premium under fee plus edge");
    const falling = { trendBps: -25, ret1hBps: -30, vol1hBps: 80, rsi14: 40, asOf: 0 };
    assert.deepEqual(kinds(held(100n * USDT), whskMarket({ trend: falling })), ["trend-exit"]);
  });

  it("puts exits ahead of entries and sells the whole position", () => {
    const whsk = held(96n * USDT);
    const market = snapshot([
      whskMarket(),
      { ...whskMarket({ dexSpot: 60_000, dexTwap: 60_000, basisBps: -100 }), symbol: "WBTC" },
    ]);
    const candidates = generateCandidates(
      market,
      portfolio({ positions: [whsk, position("WBTC")] }),
      settings({ targetAssets: ["WHSK", "WBTC"] }),
    );
    assert.deepEqual(candidates.map((c) => `${c.symbol}:${c.kind}`), ["WHSK:soft-stop", "WBTC:basis-entry"]);
    assert.equal(candidates[0]?.amountIn, whsk.balance);
  });
});
