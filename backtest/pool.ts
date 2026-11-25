// Replays the WHSK/USDT pool from its event history: price, tick and liquidity at any
// moment, the time-weighted average the vault would read, and what a swap would fetch.
import { timestampOfBlock } from "./config.ts";
import type { PoolEvent } from "./data.ts";
import { meanTickOf, swapExactInput, tickAtSqrtRatio } from "./math.ts";

export interface PoolState {
  block: number;
  timestamp: number;
  sqrtPriceX96: bigint;
  tick: number;
  /** Liquidity in range at the current price. */
  liquidity: bigint;
}

/** What the vault and the agent need to know about a pool at a moment in time. */
export interface PoolView {
  /** Pool state at the end of the newest block not later than `timestamp`. */
  stateAt(timestamp: number): PoolState;
  /** Mean tick over the `window` seconds before `timestamp`, as TwapLib.meanTick computes it. */
  meanTick(timestamp: number, window: number): number;
  /** Whether `observe([window, 0])` would succeed at `timestamp`, i.e. the oracle still holds a price that old. */
  canObserve(timestamp: number, window: number): boolean;
}

/** Pool state at the end of one block that changed it. */
interface Step extends PoolState {
  /** Integral of the tick over time from the pool's first block up to this block's timestamp. */
  tickCumulative: bigint;
  /** Timestamp of the oldest price observation the pool's oracle still holds after this block. */
  oldestObservation: number;
  /** Whether a swap happened in this block (as opposed to liquidity being added or removed). */
  swapped: boolean;
}

export interface ReplayStats {
  swaps: number;
  mints: number;
  burns: number;
  /** Swaps after which in-range liquidity differs from before: they crossed an initialised tick. */
  swapsCrossingTicks: number;
}

export interface ReplayOptions {
  /**
   * Treat the pool's oracle as having held this many observations from the start, instead
   * of what the chain recorded. See ASSUMED_ORACLE_SLOTS in config.ts for why a backtest
   * needs this.
   */
  oracleSlots?: number;
}

/**
 * A Uniswap V3 pool's price only changes in swaps, and its in-range liquidity only in
 * swaps, mints and burns, all of which emit events. Replaying the events therefore gives
 * the exact state at the end of every block.
 *
 * The pool's oracle accumulates the tick that was current at the START of each block, so
 * the tick that counts for the seconds between two blocks is the one left by the earlier
 * block. `tickCumulativeAt` integrates exactly that step function.
 */
export class PoolReplay implements PoolView {
  readonly stats: ReplayStats = { swaps: 0, mints: 0, burns: 0, swapsCrossingTicks: 0 };
  private readonly steps: Step[] = [];

  constructor(events: readonly PoolEvent[], options: ReplayOptions = {}) {
    let sqrtPriceX96 = 0n;
    let tick = 0;
    let liquidity = 0n;
    let initialised = false;

    // The oracle's ring buffer, tracked only as far as the timestamps it holds.
    const observations: number[] = [];
    let index = 0;
    let cardinality = 1;
    let cardinalityNext = options.oracleSlots ?? 1;
    let wroteInBlock = -1;

    const writeObservation = (block: number) => {
      if (wroteInBlock === block) return;
      wroteInBlock = block;
      if (cardinalityNext > cardinality && index === cardinality - 1) cardinality = cardinalityNext;
      index = (index + 1) % cardinality;
      observations[index] = timestampOfBlock(block);
    };
    const oldest = () => observations[(index + 1) % cardinality] ?? observations[0]!;

    let i = 0;
    while (i < events.length) {
      const block = events[i]!.block;
      let swapped = false;
      for (; i < events.length && events[i]!.block === block; i++) {
        const event = events[i]!;
        if (event.kind === "init") {
          ({ sqrtPriceX96, tick } = event);
          initialised = true;
          observations[0] = timestampOfBlock(block);
          wroteInBlock = block;
        } else if (event.kind === "cardinality") {
          cardinalityNext = Math.max(cardinalityNext, event.next);
        } else if (event.kind === "swap") {
          this.stats.swaps += 1;
          swapped = true;
          if (event.liquidity !== liquidity) this.stats.swapsCrossingTicks += 1;
          if (event.tick !== tick) writeObservation(block);
          ({ sqrtPriceX96, tick, liquidity } = event);
        } else {
          this.stats[event.kind === "mint" ? "mints" : "burns"] += 1;
          if (event.amount !== 0n && event.tickLower <= tick && tick < event.tickUpper) {
            writeObservation(block);
            liquidity += event.kind === "mint" ? event.amount : -event.amount;
          }
        }
      }
      if (!initialised) throw new Error(`pool event in block ${block} before the pool was initialised`);

      const timestamp = timestampOfBlock(block);
      const previous = this.steps[this.steps.length - 1];
      const tickCumulative = previous ? previous.tickCumulative + BigInt(previous.tick) * BigInt(timestamp - previous.timestamp) : 0n;
      this.steps.push({ block, timestamp, sqrtPriceX96, tick, liquidity, tickCumulative, oldestObservation: oldest(), swapped });
    }
    if (this.steps.length === 0) throw new Error("no pool events");
  }

  get firstTimestamp(): number {
    return this.steps[0]!.timestamp;
  }

  get lastTimestamp(): number {
    return this.steps[this.steps.length - 1]!.timestamp;
  }

  /** Index of the newest step whose block is not later than `timestamp`, or -1. */
  private indexAt(timestamp: number): number {
    if (this.steps[0]!.timestamp > timestamp) return -1;
    let lo = 0;
    let hi = this.steps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.steps[mid]!.timestamp <= timestamp) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  stateAt(timestamp: number): PoolState {
    const step = this.steps[this.indexAt(timestamp)];
    if (!step) throw new Error(`the pool did not exist at ${timestamp}`);
    return step;
  }

  /**
   * What the pool's oracle reports for a transaction in the block stamped `timestamp`:
   * the integral of the tick up to that block's start. A swap inside that same block does
   * not count yet, which is why the lookup is strictly before `timestamp`.
   */
  tickCumulativeAt(timestamp: number): bigint {
    const step = this.steps[this.indexAt(timestamp - 1)];
    if (!step) throw new Error(`the pool did not exist before ${timestamp}`);
    return step.tickCumulative + BigInt(step.tick) * BigInt(timestamp - step.timestamp);
  }

  canObserve(timestamp: number, window: number): boolean {
    const step = this.steps[this.indexAt(timestamp)];
    return step !== undefined && step.oldestObservation <= timestamp - window;
  }

  meanTick(timestamp: number, window: number): number {
    return meanTickOf(this.tickCumulativeAt(timestamp - window), this.tickCumulativeAt(timestamp), window);
  }

  /** Timestamp of the first block after `timestamp` in which somebody swapped, if any. */
  nextSwapAfter(timestamp: number): number | undefined {
    for (let i = this.indexAt(timestamp) + 1; i < this.steps.length; i++) {
      if (this.steps[i]!.swapped) return this.steps[i]!.timestamp;
    }
    return undefined;
  }

  /** Steps between two timestamps (inclusive start, exclusive end), for statistics and checks. */
  stepsBetween(from: number, to: number): readonly PoolState[] {
    return this.steps.filter((step) => step.timestamp >= from && step.timestamp < to);
  }
}

/**
 * The recorded pool with the simulated vault's own trades laid over it.
 *
 * A trade moves the pool's price, and nothing moves it back until somebody else trades.
 * So after one of our swaps the pool stays at the price we left it, and the TWAP follows
 * that price, until the next swap in the recorded history. From that swap on the pool is
 * back on its recorded path: whoever traded then is assumed to have traded to the same
 * price they did in reality, as an arbitrageur aiming at the exchange price would.
 *
 * Without this, several small buys made while the pool is quiet would each be priced as
 * if the others had never happened, which understates what a position costs to build.
 */
export class TradedPool implements PoolView {
  private readonly history: PoolReplay;
  private readonly own: Array<{ from: number; until: number; sqrtPriceX96: bigint; tick: number; recordedTick: number }> = [];

  constructor(history: PoolReplay) {
    this.history = history;
  }

  /** Our displacement in force at `timestamp`, if the pool has not been traded by anyone else since. */
  private activeAt(timestamp: number): (typeof this.own)[number] | undefined {
    for (let i = this.own.length - 1; i >= 0; i--) {
      const trade = this.own[i]!;
      if (trade.from <= timestamp) return timestamp < trade.until ? trade : undefined;
    }
    return undefined;
  }

  /** Records that our swap in the block stamped `timestamp` left the pool at `sqrtPriceAfter`. */
  applyTrade(timestamp: number, sqrtPriceAfter: bigint): void {
    const active = this.activeAt(timestamp);
    if (active) active.until = timestamp;
    this.own.push({
      from: timestamp,
      until: this.history.nextSwapAfter(timestamp) ?? Number.POSITIVE_INFINITY,
      sqrtPriceX96: sqrtPriceAfter,
      tick: tickAtSqrtRatio(sqrtPriceAfter),
      recordedTick: this.history.stateAt(timestamp).tick,
    });
  }

  stateAt(timestamp: number): PoolState {
    const recorded = this.history.stateAt(timestamp);
    const active = this.activeAt(timestamp);
    return active ? { ...recorded, sqrtPriceX96: active.sqrtPriceX96, tick: active.tick } : recorded;
  }

  private tickCumulativeAt(timestamp: number): bigint {
    let cumulative = this.history.tickCumulativeAt(timestamp);
    // A displacement that ended before a window began adds the same amount to both ends
    // of the window, so old ones cancel out of every mean and need not be dropped.
    for (const trade of this.own) {
      const seconds = Math.min(timestamp, trade.until) - trade.from;
      if (seconds > 0) cumulative += BigInt(trade.tick - trade.recordedTick) * BigInt(seconds);
    }
    return cumulative;
  }

  meanTick(timestamp: number, window: number): number {
    return meanTickOf(this.tickCumulativeAt(timestamp - window), this.tickCumulativeAt(timestamp), window);
  }

  canObserve(timestamp: number, window: number): boolean {
    return this.history.canObserve(timestamp, window);
  }
}

export interface SwapQuote {
  amountOut: bigint;
  sqrtPriceAfter: bigint;
}

/** What swapping `amountIn` against `state` returns: the asset is token0, the base token is token1. */
export function simulateSwap(state: PoolState, side: "buy" | "sell", amountIn: bigint, feePips: number): SwapQuote {
  return swapExactInput(state.sqrtPriceX96, state.liquidity, amountIn, side === "sell", feePips);
}

export function quoteSwap(state: PoolState, side: "buy" | "sell", amountIn: bigint, feePips: number): bigint {
  return simulateSwap(state, side, amountIn, feePips).amountOut;
}
