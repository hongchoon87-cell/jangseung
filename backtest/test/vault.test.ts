import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PoolReplay, TradedPool } from "../pool.ts";
import { PPS_ONE, SimVault, VaultRevert } from "../vault.ts";
import { at, FORK, policy, PoolScript, USDT } from "./helpers.ts";

const FEE = 3000;
const START = 2_000_000;

/**
 * A deep pool resting at the fork block's price, with whatever swaps the test adds. Its
 * oracle keeps 240 observations, as the real pool has since 2026-10-31, unless the test
 * asks for the single slot it had before.
 */
function scripted(edit: (script: PoolScript) => void = () => {}, oracleSlots = 240) {
  const script = new PoolScript(START, FORK.tick, FORK.liquidity, FORK.sqrtPriceX96);
  if (oracleSlots > 1) script.cardinality(START - 100, oracleSlots);
  edit(script);
  return new PoolReplay(script.events);
}

function funded(pool: PoolReplay, overrides = {}) {
  const vault = new SimVault({ ...policy, ...overrides }, pool, FEE);
  vault.deposit(1_000n * USDT, at(START));
  return vault;
}

function reverts(call: () => unknown, name: string): void {
  assert.throws(call, (error: unknown) => error instanceof VaultRevert && error.name === name, `expected ${name}`);
}

describe("vault copy against the contract's fork test", () => {
  it("deposit 1,000, buy 100: same WHSK received and same NAV as test/AgentVaultFork.t.sol", () => {
    // The pool as it was at block 30,581,400, with the swap 162 seconds earlier that its oracle shows.
    const swapBlock = FORK.block - 81;
    const script = new PoolScript(swapBlock - 1_000, -301_484, FORK.liquidity)
      .cardinality(swapBlock - 500, 240)
      .swapTo(swapBlock, FORK.tick, FORK.liquidity, FORK.sqrtPriceX96);
    const vault = new SimVault(policy, new PoolReplay(script.events), FEE);
    const now = at(FORK.block);

    vault.deposit(1_000n * USDT, now);
    assert.equal(vault.pricePerShare(now), PPS_ONE);

    const receipt = vault.buy(100n * USDT, 0n, now)!;
    assert.equal(receipt.assetAmount, 1233601571998242702399n);
    assert.equal(receipt.navAfter, 999_665_712n);
    assert.equal(vault.idleBase, 900n * USDT);
    assert.equal(vault.costBasis, 100n * USDT);
  });
});

describe("vault copy: buy limits", () => {
  it("rejects a buy over the trade limit and leaves no trace of it", () => {
    const vault = funded(scripted());
    reverts(() => vault.buy(101n * USDT, 0n, at(START + 10)), "TradeTooLarge");
    assert.equal(vault.buysToday, 0);
    assert.equal(vault.lastBuyAt, 0);
    assert.equal(vault.idleBase, 1_000n * USDT);
  });

  it("enforces the cooldown between buys and the daily count", () => {
    const vault = funded(scripted(), { maxTradesPerDay: 2 });
    vault.buy(50n * USDT, 0n, at(START + 10));
    reverts(() => vault.buy(50n * USDT, 0n, at(START + 10) + 298), "CooldownActive");
    vault.buy(50n * USDT, 0n, at(START + 10) + 300);
    reverts(() => vault.buy(50n * USDT, 0n, at(START + 10) + 900), "DailyLimitReached");

    // The count starts again with the next UTC day.
    const tomorrow = (Math.floor(at(START) / 86_400) + 1) * 86_400 + 60;
    assert.ok(vault.buy(50n * USDT, 0n, tomorrow));
    assert.equal(vault.buysToday, 1);
  });

  it("measures the trade limit against NAV as it is now, not as it was deposited", () => {
    const vault = funded(scripted());
    vault.buy(100n * USDT, 0n, at(START + 10));
    // The first buy's fee took NAV to about 999.67, so 10% of it is now under 100. The
    // same thing reverted a transaction in the mainnet fork run.
    reverts(() => vault.buy(100n * USDT, 0n, at(START + 10) + 300), "TradeTooLarge");
  });

  it("stops the position at its share of NAV", () => {
    const vault = funded(scripted());
    let now = at(START + 10);
    for (let i = 0; i < 3; i++, now += 300) vault.buy(95n * USDT, 0n, now);
    // About 284 is held; 20 more would pass 30% of a NAV just under 1,000.
    reverts(() => vault.buy(20n * USDT, 0n, now), "PositionTooLarge");
    assert.ok(vault.buy(10n * USDT, 0n, now));
  });

  it("refuses a price more than the allowed slippage above the TWAP", () => {
    // The price jumps 2% (200 ticks) one block before the buy; the TWAP has barely moved.
    const pool = scripted((script) => script.swapTo(START + 100, FORK.tick + 200, FORK.liquidity));
    const vault = funded(pool);
    reverts(() => vault.buy(50n * USDT, 0n, at(START + 101)), "Slippage");
    // Five minutes later the TWAP has caught up and the same buy goes through.
    assert.ok(vault.buy(50n * USDT, 0n, at(START + 100) + 300));
  });

  it("honours the caller's own minimum on top of the TWAP floor", () => {
    const vault = funded(scripted());
    reverts(() => vault.buy(50n * USDT, 10n ** 24n, at(START + 10)), "Slippage");
  });

  it("cannot price anything while a one-slot oracle has no price old enough", () => {
    // Until 2026-10-26 the pool kept a single observation, overwritten by every price change.
    const pool = scripted((script) => script.swapTo(START + 100, FORK.tick + 5, FORK.liquidity), 1);
    const vault = funded(pool);
    reverts(() => vault.buy(50n * USDT, 0n, at(START + 100) + 60), "OLD");
    assert.ok(vault.buy(50n * USDT, 0n, at(START + 100) + 300));
  });
});

describe("vault copy: selling and accounting", () => {
  it("a round trip loses the two pool fees and reports it as realised loss", () => {
    const vault = funded(scripted());
    const bought = vault.buy(100n * USDT, 0n, at(START + 10))!;
    const sold = vault.sell(bought.assetAmount, 0n, at(START + 20));

    // On-chain an immediate sale walks back down the price the buy pushed up and returns
    // 99.4010. The copy leaves the pool on its recorded path, so both legs pay their own
    // impact (about 2.4 bps each at this depth): a little worse, never better.
    assert.ok(sold.baseAmount > 99_340_000n && sold.baseAmount < 99_370_000n, `got ${sold.baseAmount}`);
    assert.equal(sold.realizedPnl, sold.baseAmount - 100n * USDT);
    assert.equal(vault.balance, 0n);
    assert.equal(vault.costBasis, 0n);
    assert.equal(vault.idleBase, 900n * USDT + sold.baseAmount);
  });

  it("with our own price impact carried over, an immediate round trip returns what the chain returned", () => {
    // test/AgentVaultFork.t.sol buys 100 USDT of WHSK and sells it straight back: 99.400970.
    const pool = new TradedPool(scripted());
    const vault = new SimVault(policy, pool, FEE);
    vault.deposit(1_000n * USDT, at(START));

    const bought = vault.buy(100n * USDT, 0n, at(START + 10))!;
    const swap = vault.takeSwap()!;
    assert.equal(swap.at, at(START + 10));
    pool.applyTrade(swap.at, swap.sqrtPriceAfter);
    assert.equal(vault.takeSwap(), undefined, "a swap is handed over once");

    const sold = vault.sell(bought.assetAmount, 0n, at(START + 11));
    assert.equal(bought.assetAmount, 1233601571998242702399n);
    assert.equal(sold.baseAmount, 99_400_970n);
  });

  it("a reverted or previewed call leaves no swap behind", () => {
    const vault = funded(scripted());
    vault.preview(() => vault.buy(100n * USDT, 0n, at(START + 10)));
    assert.equal(vault.takeSwap(), undefined);
    reverts(() => vault.buy(100n * USDT, 10n ** 24n, at(START + 10)), "Slippage");
    assert.equal(vault.takeSwap(), undefined);
  });

  it("removes cost in proportion on a partial sale", () => {
    const vault = funded(scripted());
    const bought = vault.buy(100n * USDT, 0n, at(START + 10))!;
    vault.sell(bought.assetAmount / 4n, 0n, at(START + 20));
    // A quarter rounded down leaves one unit more than three quarters, as mulDiv does on-chain.
    assert.equal(vault.costBasis, 75n * USDT + 1n);
    reverts(() => vault.sell(bought.assetAmount, 0n, at(START + 30)), "InsufficientAsset");
  });

  it("a preview changes nothing", () => {
    const vault = funded(scripted());
    const receipt = vault.preview(() => vault.buy(100n * USDT, 0n, at(START + 10)));
    assert.ok(receipt);
    assert.equal(vault.balance, 0n);
    assert.equal(vault.buysToday, 0);
    assert.equal(vault.idleBase, 1_000n * USDT);
  });
});

describe("vault copy: stop-loss", () => {
  // The price falls 6.1% (630 ticks) at block START+1000.
  const crashed = () => scripted((script) => script.swapTo(START + 1_000, FORK.tick - 630, FORK.liquidity));

  it("cannot be forced right after a crash, and fires once the TWAP has followed", () => {
    const vault = funded(crashed());
    vault.buy(100n * USDT, 0n, at(START + 10));

    const crash = at(START + 1_000);
    assert.equal(vault.stopLossReached(crash + 20), false, "20 seconds in, the TWAP is down well under 1%");
    reverts(() => vault.triggerStopLoss(0n, crash + 20), "StopLossNotReached");

    assert.equal(vault.stopLossReached(crash + 300), true);
    const receipt = vault.triggerStopLoss(0n, crash + 300);
    assert.ok(receipt.realizedPnl < -6n * USDT && receipt.realizedPnl > -7n * USDT, `lost ${receipt.realizedPnl}`);
    assert.equal(vault.balance, 0n);
    assert.equal(vault.lockedUntil, crash + 300 + policy.reentryLockout);
  });

  it("locks the asset against re-entry for the lockout", () => {
    const vault = funded(crashed());
    vault.buy(100n * USDT, 0n, at(START + 10));
    const stopped = at(START + 1_000) + 300;
    vault.triggerStopLoss(0n, stopped);

    reverts(() => vault.buy(50n * USDT, 0n, stopped + 600), "AssetLocked");
    assert.ok(vault.buy(50n * USDT, 0n, stopped + policy.reentryLockout));
  });

  it("has nothing to do without a position", () => {
    const vault = funded(crashed());
    assert.equal(vault.stopLossReached(at(START + 1_000) + 300), false);
    reverts(() => vault.triggerStopLoss(0n, at(START + 1_000) + 300), "NothingToSell");
  });

  it("takes an amount, and never sells more than is held", () => {
    const vault = funded(crashed());
    const bought = vault.buy(100n * USDT, 0n, at(START + 10))!.assetAmount;
    const later = at(START + 1_000) + 300;

    vault.triggerStopLoss(bought / 4n, later);
    assert.equal(vault.balance, bought - bought / 4n);
    assert.equal(vault.costBasis, 75n * USDT + 1n);
    assert.equal(vault.lockedUntil, later + policy.reentryLockout);

    vault.triggerStopLoss(10n ** 30n, later + 10);
    assert.equal(vault.balance, 0n);
    assert.equal(vault.costBasis, 0n);
  });
});

describe("vault copy: a position too large for the pool", () => {
  // The pool is deep while the position is built, then loses 98% of its liquidity (about
  // 8,400 USDT a side is left), then the price falls 6.1% in one swap.
  const THIN = FORK.liquidity / 50n;
  const thinned = () =>
    scripted((script) => {
      script.events.push({ kind: "burn", block: START + 500, index: 900, tickLower: -887220, tickUpper: 887220, amount: FORK.liquidity - THIN });
      script.swapTo(START + 1_000, FORK.tick - 630, THIN);
    });

  function stuck() {
    const pool = new TradedPool(thinned());
    const vault = new SimVault(policy, pool, FEE);
    vault.deposit(1_000n * USDT, at(START));
    let now = at(START + 10);
    for (let i = 0; i < 3; i++, now += 300) {
      vault.buy(95n * USDT, 0n, now);
      const swap = vault.takeSwap()!;
      pool.applyTrade(swap.at, swap.sqrtPriceAfter);
    }
    return { pool, vault };
  }

  it("the estimate is a fraction of the position, and that fraction is what sells", () => {
    const { vault } = stuck();
    const later = at(START + 1_000) + 300;
    assert.equal(vault.stopLossReached(later), true);

    const fits = vault.maxSellNow(later);
    assert.ok(fits > 0n && fits < vault.balance / 3n, `fits ${fits} of ${vault.balance}`);

    // All of it in one swap would fill far under the TWAP floor: still refused.
    reverts(() => vault.triggerStopLoss(vault.balance, later), "Slippage");

    const before = vault.balance;
    const receipt = vault.triggerStopLoss(0n, later);
    assert.equal(receipt.assetAmount, fits);
    assert.equal(vault.balance, before - fits);
  });

  it("closes the position over several sales, each waiting for the TWAP", () => {
    const { pool, vault } = stuck();
    let now = at(START + 1_000) + 300;
    let sales = 0;

    while (vault.balance > 0n) {
      vault.triggerStopLoss(0n, now);
      const swap = vault.takeSwap()!;
      pool.applyTrade(swap.at, swap.sqrtPriceAfter);
      sales += 1;
      assert.ok(sales < 20, "the position should be gone in a handful of sales");

      if (vault.balance > 0n) {
        // The sale left the price about 1.2% under the TWAP, so nothing more fits for now.
        assert.equal(vault.maxSellNow(now + 2), 0n);
        reverts(() => vault.triggerStopLoss(0n, now + 2), "NoRoomToSell");
      }
      now += 300;
    }
    assert.ok(sales >= 4, `took ${sales} sales`);
    assert.equal(vault.costBasis, 0n);
  });

  it("a breaker flatten sells what fits in the same way", () => {
    const { vault } = stuck();
    const later = at(START + 1_000) + 300;
    reverts(() => vault.flatten(0n, later), "NotHalted");

    // Force the halt the way a far larger fall would: the copy only needs the flag.
    const halted = new SimVault({ ...policy, maxDrawdownBps: 10 }, new TradedPool(thinned()), FEE);
    halted.deposit(1_000n * USDT, at(START));
    halted.buy(95n * USDT, 0n, at(START + 10));
    assert.equal(halted.checkpoint(later), true);
    const fits = halted.maxSellNow(later);
    assert.ok(fits > 0n && fits < halted.balance);
    assert.equal(halted.flatten(0n, later).assetAmount, fits);
    assert.equal(halted.flatten(1n, later).assetAmount, 1n);
  });
});

describe("vault copy: drawdown breaker", () => {
  // The price falls 40% (5,108 ticks), far more than a stop-loss would normally allow.
  const collapsed = () => scripted((script) => script.swapTo(START + 2_000, FORK.tick - 5_108, FORK.liquidity));

  function exposed() {
    const vault = funded(collapsed());
    let now = at(START + 10);
    for (const amount of [95n, 95n, 95n]) {
      vault.buy(amount * USDT, 0n, now);
      now += 300;
    }
    return vault;
  }

  it("trips when NAV per share falls past the limit and then blocks buying", () => {
    const vault = exposed();
    const later = at(START + 2_000) + 300;
    assert.ok(vault.drawdownBps(later) > 1_000, `drawdown ${vault.drawdownBps(later)} bps`);
    assert.equal(vault.halted, false, "nothing has recorded the breach yet");

    assert.equal(vault.checkpoint(later), true);
    assert.equal(vault.halted, true);
    reverts(() => vault.buy(10n * USDT, 0n, later + 600), "Halted");
  });

  it("a buy that discovers the breach buys nothing and keeps the halt", () => {
    const vault = exposed();
    const later = at(START + 2_000) + 300;
    const idle = vault.idleBase;
    assert.equal(vault.buy(10n * USDT, 0n, later), undefined);
    assert.equal(vault.halted, true);
    assert.equal(vault.idleBase, idle);
  });

  it("lets anyone flatten while halted, and only then", () => {
    const vault = exposed();
    const later = at(START + 2_000) + 300;
    reverts(() => vault.flatten(0n, later), "NotHalted");
    vault.checkpoint(later);
    const receipt = vault.flatten(0n, later);
    assert.ok(receipt.baseAmount > 0n);
    assert.equal(vault.balance, 0n);
  });

  it("resumes from the current NAV when the owner says so", () => {
    const vault = exposed();
    const later = at(START + 2_000) + 300;
    vault.checkpoint(later);
    vault.resume(later);
    assert.equal(vault.halted, false);
    assert.equal(vault.highWaterMark, vault.pricePerShare(later));
    assert.equal(vault.drawdownBps(later), 0);
  });
});

describe("vault copy: share accounting", () => {
  it("a second deposit does not change NAV per share", () => {
    const vault = funded(scripted());
    vault.buy(100n * USDT, 0n, at(START + 10));
    const before = vault.pricePerShare(at(START + 20));
    vault.deposit(500n * USDT, at(START + 20));
    const after = vault.pricePerShare(at(START + 20));
    assert.ok(after >= before - 10n ** 9n && after <= before + 10n ** 9n, `pps moved from ${before} to ${after}`);
    reverts(() => vault.deposit(0n, at(START + 30)), "ZeroAmount");
  });
});
