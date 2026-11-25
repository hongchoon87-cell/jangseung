import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blockAtOrBefore, timestampOfBlock } from "../config.ts";
import { parsePoolEvents, serializePoolEvents } from "../data.ts";
import { sqrtRatioAtTick } from "../math.ts";
import { PoolReplay, quoteSwap, TradedPool } from "../pool.ts";
import { at, FORK, PoolScript, USDT } from "./helpers.ts";

const L = 10n ** 18n;

describe("chain clock", () => {
  it("maps blocks to timestamps two seconds apart and back", () => {
    assert.equal(timestampOfBlock(30_581_400), 1_795_509_935, "the fork block's real timestamp");
    assert.equal(blockAtOrBefore(1_795_509_935), 30_581_400);
    assert.equal(blockAtOrBefore(1_795_509_936), 30_581_400, "no block on the even second");
    assert.equal(blockAtOrBefore(1_795_509_937), 30_581_401);
  });
});

describe("pool replay: state", () => {
  it("gives the state left by the newest block at or before a moment", () => {
    const script = new PoolScript(1_000_000, -300_000, L).swapTo(1_000_010, -300_050, L).swapTo(1_000_020, -300_100, L);
    const pool = new PoolReplay(script.events);

    assert.equal(pool.stateAt(at(1_000_009)).tick, -300_000);
    assert.equal(pool.stateAt(at(1_000_010)).tick, -300_050, "the swap's own block already shows the new price");
    assert.equal(pool.stateAt(at(1_000_010) + 1).tick, -300_050);
    assert.equal(pool.stateAt(at(1_000_025)).tick, -300_100);
    assert.throws(() => pool.stateAt(at(1_000_000 - 50_000)), /did not exist/);
  });

  it("keeps only the last swap of a block", () => {
    const script = new PoolScript(1_000_000, -300_000, L).swapTo(1_000_010, -300_050, L).swapTo(1_000_010, -300_020, L);
    assert.equal(new PoolReplay(script.events).stateAt(at(1_000_010)).tick, -300_020);
  });

  it("tracks liquidity added and removed around the current price only", () => {
    const script = new PoolScript(1_000_000, -300_000, L);
    script.events.push({ kind: "mint", block: 1_000_005, index: 90, tickLower: -300_600, tickUpper: -299_400, amount: 5n });
    script.events.push({ kind: "mint", block: 1_000_006, index: 91, tickLower: -299_400, tickUpper: -298_000, amount: 7n });
    script.events.push({ kind: "burn", block: 1_000_007, index: 92, tickLower: -300_600, tickUpper: -299_400, amount: 2n });
    const pool = new PoolReplay(script.events);
    assert.equal(pool.stateAt(at(1_000_005)).liquidity, L + 5n);
    assert.equal(pool.stateAt(at(1_000_006)).liquidity, L + 5n, "a range above the price adds nothing in range");
    assert.equal(pool.stateAt(at(1_000_007)).liquidity, L + 3n);
  });

  it("survives a round trip through the file format", () => {
    const script = new PoolScript(1_000_000, -300_000, L).swapTo(1_000_010, -300_050, L).cardinality(1_000_011, 240);
    assert.deepEqual(parsePoolEvents(serializePoolEvents(script.events)), script.events);
  });
});

describe("pool replay: time-weighted price", () => {
  it("weights each tick by the seconds it was current", () => {
    // Tick -300,000 until block 1,000,100, then -300,300.
    const pool = new PoolReplay(new PoolScript(1_000_000, -300_000, L).swapTo(1_000_100, -300_300, L).events);
    const swapTime = at(1_000_100);

    assert.equal(pool.meanTick(swapTime, 300), -300_000, "a swap does not count in its own block");
    assert.equal(pool.meanTick(swapTime + 100, 300), -300_100, "100 of 300 seconds at the new tick");
    assert.equal(pool.meanTick(swapTime + 300, 300), -300_300);
    assert.equal(pool.meanTick(swapTime + 2, 300), -300_002);
  });

  it("rounds toward minus infinity like the contract", () => {
    const pool = new PoolReplay(new PoolScript(1_000_000, -300_000, L).swapTo(1_000_100, -300_001, L).events);
    // 2 seconds at -300,001 and 298 at -300,000: mean -300,000.0067, floored to -300,001.
    assert.equal(pool.meanTick(at(1_000_100) + 2, 300), -300_001);
  });

  it("reproduces the pool's own oracle at the fork block", () => {
    // observe([300, 0]) at block 30,581,400 returned a difference of -90,445,038, which is
    // 138 seconds at tick -301,484 and 162 seconds at -301,483.
    const swapBlock = FORK.block - 81;
    const script = new PoolScript(swapBlock - 1_000, -301_484, FORK.liquidity).swapTo(swapBlock, FORK.tick, FORK.liquidity, FORK.sqrtPriceX96);
    const pool = new PoolReplay(script.events);
    const now = at(FORK.block);

    assert.equal(pool.tickCumulativeAt(now) - pool.tickCumulativeAt(now - 300), -90_445_038n);
    assert.equal(pool.meanTick(now, 300), -301_484);
  });
});

describe("pool replay: what the oracle can answer", () => {
  it("with one observation slot, cannot look back past the last price change", () => {
    const pool = new PoolReplay(new PoolScript(1_000_000, -300_000, L).swapTo(1_000_100, -300_300, L).events);
    const swapTime = at(1_000_100);

    assert.equal(pool.canObserve(swapTime - 2, 300), true, "before the swap the pool's first observation is a day old");
    assert.equal(pool.canObserve(swapTime, 300), false);
    assert.equal(pool.canObserve(swapTime + 298, 300), false);
    assert.equal(pool.canObserve(swapTime + 300, 300), true);
  });

  it("can look back through price changes once the history has been enlarged", () => {
    const script = new PoolScript(1_000_000, -300_000, L).cardinality(1_000_050, 240).swapTo(1_000_100, -300_300, L).swapTo(1_000_120, -300_400, L);
    const pool = new PoolReplay(script.events);
    assert.equal(pool.canObserve(at(1_000_100), 300), true, "the older observation is kept next to the new one");
    assert.equal(pool.canObserve(at(1_000_130), 300), true);
  });

  it("a swap that leaves the tick unchanged writes no observation", () => {
    const pool = new PoolReplay(new PoolScript(1_000_000, -300_000, L).swapTo(1_000_100, -300_000, L).events);
    assert.equal(pool.canObserve(at(1_000_100) + 10, 300), true);
  });
});

describe("assumed oracle size", () => {
  it("lets the oracle look back through a price change from the start", () => {
    const script = new PoolScript(1_000_000, -300_000, L).swapTo(1_000_100, -300_300, L);
    assert.equal(new PoolReplay(script.events).canObserve(at(1_000_100) + 10, 300), false, "as recorded: one slot");
    assert.equal(new PoolReplay(script.events, { oracleSlots: 240 }).canObserve(at(1_000_100) + 10, 300), true);
  });

  it("still cannot look back past the pool's own beginning", () => {
    const script = new PoolScript(1_000_000, -300_000, L);
    const born = at(1_000_000 - 43_200);
    assert.equal(new PoolReplay(script.events, { oracleSlots: 240 }).canObserve(born + 100, 300), false);
    assert.equal(new PoolReplay(script.events, { oracleSlots: 240 }).canObserve(born + 300, 300), true);
  });
});

describe("the pool with our own trades laid over it", () => {
  // Recorded swaps at blocks 1,000,100 and 1,000,400; quiet in between.
  const recorded = () => new PoolReplay(new PoolScript(1_000_000, -300_000, L).swapTo(1_000_100, -300_050, L).swapTo(1_000_400, -300_200, L).events, { oracleSlots: 240 });
  const ourPrice = sqrtRatioAtTick(-299_990) + 12_345n;

  it("stays where our trade left it until somebody else trades", () => {
    const pool = new TradedPool(recorded());
    const ours = at(1_000_200);
    assert.equal(pool.stateAt(ours).tick, -300_050, "before our trade: the recorded state");

    pool.applyTrade(ours, ourPrice);
    assert.equal(pool.stateAt(ours).sqrtPriceX96, ourPrice);
    assert.equal(pool.stateAt(ours).tick, -299_990);
    assert.equal(pool.stateAt(at(1_000_399)).sqrtPriceX96, ourPrice);
    assert.equal(pool.stateAt(ours - 2).tick, -300_050, "nothing changes before our block");

    // The next recorded swap puts the pool back on its recorded path.
    assert.equal(pool.stateAt(at(1_000_400)).tick, -300_200);
    assert.equal(pool.stateAt(at(1_000_400)).sqrtPriceX96, sqrtRatioAtTick(-300_200));
  });

  it("the TWAP follows our price for exactly as long as it stood", () => {
    const pool = new TradedPool(recorded());
    const ours = at(1_000_200);
    pool.applyTrade(ours, ourPrice);

    // In our own block the trade does not count yet: 100 s at -300,000, then 200 s at
    // -300,050 since the recorded swap, a mean of -300,033.3 that rounds down.
    assert.equal(pool.meanTick(ours, 300), -300_034);
    // 150 seconds after our trade: half the window at each tick.
    assert.equal(pool.meanTick(ours + 150, 300), -300_020);
    assert.equal(pool.meanTick(ours + 300, 300), -299_990);

    // Our price stood for 400 seconds, until the recorded swap at block 1,000,400. Five
    // minutes after that swap nothing of it is left in the window.
    const next = at(1_000_400);
    assert.equal(pool.meanTick(next + 150, 300), Math.floor((-299_990 * 150 - 300_200 * 150) / 300));
    assert.equal(pool.meanTick(next + 300, 300), -300_200);
    assert.equal(pool.meanTick(next + 900, 300), -300_200);
  });

  it("a second trade of ours starts from the first one's price", () => {
    const pool = new TradedPool(recorded());
    pool.applyTrade(at(1_000_200), ourPrice);
    const second = sqrtRatioAtTick(-299_900);
    pool.applyTrade(at(1_000_300), second);

    assert.equal(pool.stateAt(at(1_000_250)).sqrtPriceX96, ourPrice);
    assert.equal(pool.stateAt(at(1_000_300)).sqrtPriceX96, second);
    // 200 s at the first price, then 100 s at the second.
    assert.equal(pool.meanTick(at(1_000_300) + 100, 300), Math.floor((-299_990 * 200 - 299_900 * 100) / 300));
    assert.equal(pool.stateAt(at(1_000_400)).tick, -300_200);
  });

  it("a trade after the last recorded swap stands for good", () => {
    const pool = new TradedPool(recorded());
    pool.applyTrade(at(1_000_500), ourPrice);
    assert.equal(pool.stateAt(at(2_000_000)).sqrtPriceX96, ourPrice);
  });
});

describe("quotes from a replayed state", () => {
  it("match the mainnet fork measurement", () => {
    const script = new PoolScript(FORK.block - 1_000, FORK.tick, FORK.liquidity, FORK.sqrtPriceX96);
    const pool = new PoolReplay(script.events);
    assert.equal(quoteSwap(pool.stateAt(at(FORK.block)), "buy", 100n * USDT, 3000), 1233601571998242702399n);
  });
});
