import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maxInputAboveFloor, meanTickOf, quoteAtTick, sqrtRatioAtTick, swapExactInput, tickAtSqrtRatio } from "../math.ts";

/**
 * WHSK/USDT pool on HSK Chain mainnet at block 30,581,400, read from the archive RPC.
 * test/AgentVaultFork.t.sol runs real swaps through the real pool at this block, so its
 * measured numbers are the reference for the maths here.
 */
const FORK = {
  sqrtPriceX96: 22521022520436995312225n,
  liquidity: 1475813786831558685n,
  tick: -301483,
  /** observe([300, 0]) at the same block. */
  tickCumulatives: [-7671835585162n, -7671926030200n] as const,
};
const FEE = 3000;
const USDT = 1_000_000n;

describe("pool maths against the mainnet fork", () => {
  it("buying 100 USDT of WHSK returns the amount the real pool paid, to the wei", () => {
    const buy = swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, 100n * USDT, false, FEE);
    assert.equal(buy.amountOut, 1233601571998242702399n);
    assert.equal(buy.feeAmount, 300_000n, "0.3% of the input stays in the pool");
  });

  it("selling it straight back returns what the fork test measured", () => {
    const buy = swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, 100n * USDT, false, FEE);
    const sell = swapExactInput(buy.sqrtPriceAfter, FORK.liquidity, buy.amountOut, true, FEE);
    assert.equal(sell.amountOut, 99_400_970n, "99.400970 USDT: two fees and the pool's rounding");
    // The sell pushes the price down a little less than the buy pushed it up, because the
    // fee part of each input never reaches the curve.
    const driftBps = Number(((sell.sqrtPriceAfter - FORK.sqrtPriceX96) * 20_000_000n) / FORK.sqrtPriceX96) / 1_000;
    assert.ok(driftBps > 0 && driftBps < 0.05, `price ends ${driftBps} bps above where it started`);
  });

  it("the TWAP and the vault's valuation match the fork test", () => {
    const tick = meanTickOf(FORK.tickCumulatives[0], FORK.tickCumulatives[1], 300);
    assert.equal(tick, -301484, "one tick under the spot tick: a swap moved the price inside the window");

    // The fork test deposits 1,000 USDT, buys with 100 and reads NAV 999.665712.
    const position = quoteAtTick(tick, 1233601571998242702399n, true);
    assert.equal(900n * USDT + position, 999_665_712n);
  });
});

describe("how much one sale can put through the pool", () => {
  // The vault keeps a tenth of its 1% slippage allowance back, so it aims 0.9% under the TWAP.
  const KEEP = 9910n;
  const TWAP_TICK = -301484;

  it("gives the amount the contract computes on the mainnet fork, to the wei", () => {
    // test/AgentVaultLimitsFork.t.sol logs maxSellNow at this block and sells it into the real pool.
    const fits = maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, TWAP_TICK, true, FEE, KEEP);
    assert.equal(fits, 32085768055805492211360n);
    assert.equal(quoteAtTick(TWAP_TICK, fits, true), 2_592_288_313n, "worth 2,592.29 USDT at the TWAP");
    assert.equal(swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, fits, true, FEE).amountOut, 2_568_957_719n, "the real pool paid this");
  });

  it("lands exactly on the floor it aims at, and a third more falls through the vault's limit", () => {
    const fits = maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, TWAP_TICK, true, FEE, KEEP);
    const share = (amount: bigint) =>
      Number((swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, amount, true, FEE).amountOut * 1_000_000n) / quoteAtTick(TWAP_TICK, amount, true)) / 100;
    assert.equal(share(fits), 9910);
    assert.ok(share((fits * 13n) / 10n) < 9900, "under the 99% the vault enforces");
    assert.ok(share(fits + fits / 1000n) < 9910, "it is the largest amount that still clears the target");
  });

  it("is nothing when the price already sits under the floor, or the pool is empty", () => {
    // Spot one percent under the reference: the 0.3% fee alone takes the fill past 0.9%.
    assert.equal(maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, FORK.tick + 100, true, FEE, KEEP), 0n);
    assert.equal(maxInputAboveFloor(FORK.sqrtPriceX96, 0n, TWAP_TICK, true, FEE, KEEP), 0n);
    // A reference far above the spot must not overflow or throw, only say no.
    assert.equal(maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, FORK.tick + 20_000, true, FEE, KEEP), 0n);
  });

  it("grows with liquidity and with the price standing above the reference", () => {
    const base = maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, TWAP_TICK, true, FEE, KEEP);
    const doubled = maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity * 2n, TWAP_TICK, true, FEE, KEEP);
    assert.ok(doubled - 2n * base >= 0n && doubled - 2n * base <= 2n, "twice the liquidity, twice the room");
    assert.ok(maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, TWAP_TICK - 50, true, FEE, KEEP) > base);
    // A reference absurdly far below the spot is clamped rather than dividing by nothing.
    assert.ok(maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, -887_000, true, FEE, KEEP) > base);
  });

  it("works the same way when the token sold is the pool's token1", () => {
    // Mirror image of the fork pool: the asset is token1, so its price is the inverse and
    // selling it pushes the pool's price up.
    const mirrored = (1n << 192n) / FORK.sqrtPriceX96;
    const fits = maxInputAboveFloor(mirrored, FORK.liquidity, -TWAP_TICK, false, FEE, KEEP);
    const out = swapExactInput(mirrored, FORK.liquidity, fits, false, FEE).amountOut;
    const worth = quoteAtTick(-TWAP_TICK, fits, false);
    const share = Number((out * 1_000_000n) / worth) / 100;
    assert.ok(share >= 9910 && share < 9911, `fills at ${share} bps of the reference`);
    // The same pool seen from the other side takes the same amount, within rounding.
    const direct = maxInputAboveFloor(FORK.sqrtPriceX96, FORK.liquidity, TWAP_TICK, true, FEE, KEEP);
    assert.ok(Math.abs(Number(fits) / Number(direct) - 1) < 1e-6, `${fits} against ${direct}`);
  });
});

describe("tick maths", () => {
  it("matches TickMath at its documented end points", () => {
    assert.equal(sqrtRatioAtTick(0), 1n << 96n);
    assert.equal(sqrtRatioAtTick(-887272), 4295128739n);
    assert.equal(sqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342n);
    assert.throws(() => sqrtRatioAtTick(887273));
  });

  it("puts the pool's price between the ticks around it", () => {
    assert.ok(sqrtRatioAtTick(FORK.tick) <= FORK.sqrtPriceX96);
    assert.ok(FORK.sqrtPriceX96 < sqrtRatioAtTick(FORK.tick + 1));
  });

  it("finds the tick of a price, exactly at and just under a tick boundary", () => {
    assert.equal(tickAtSqrtRatio(FORK.sqrtPriceX96), FORK.tick, "the pool's own slot0 reports this tick for this price");
    for (const tick of [-887272, -301484, -1, 0, 1, 63_972, 887_271]) {
      assert.equal(tickAtSqrtRatio(sqrtRatioAtTick(tick)), tick);
      if (tick > -887272) assert.equal(tickAtSqrtRatio(sqrtRatioAtTick(tick) - 1n), tick - 1);
    }
  });

  it("rounds a negative mean tick toward minus infinity", () => {
    assert.equal(meanTickOf(0n, -301n, 300), -2);
    assert.equal(meanTickOf(0n, -300n, 300), -1);
    assert.equal(meanTickOf(0n, 301n, 300), 1);
  });

  it("quotes both directions consistently", () => {
    const usdt = quoteAtTick(-301484, 10n ** 18n, true);
    assert.ok(usdt > 80_000n && usdt < 82_000n, `1 WHSK should be about 0.081 USDT, got ${usdt}`);
    const whsk = quoteAtTick(-301484, USDT, false);
    assert.ok(whsk > 12n * 10n ** 18n && whsk < 13n * 10n ** 18n, "1 USDT should be about 12.3 WHSK");
  });
});

describe("swap maths", () => {
  it("returns nothing for nothing and refuses an empty pool", () => {
    assert.equal(swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, 0n, false, FEE).amountOut, 0n);
    assert.throws(() => swapExactInput(FORK.sqrtPriceX96, 0n, USDT, false, FEE));
  });

  it("moves the price up on a buy and down on a sell, more for larger trades", () => {
    const small = swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, 50n * USDT, false, FEE);
    const large = swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, 5_000n * USDT, false, FEE);
    assert.ok(small.sqrtPriceAfter > FORK.sqrtPriceX96);
    assert.ok(large.sqrtPriceAfter > small.sqrtPriceAfter);
    // Per USDT spent, the large buy gets less.
    assert.ok(large.amountOut * 50n < small.amountOut * 5_000n);

    const sell = swapExactInput(FORK.sqrtPriceX96, FORK.liquidity, 10n ** 21n, true, FEE);
    assert.ok(sell.sqrtPriceAfter < FORK.sqrtPriceX96);
  });
});
