import type { Policy } from "../../agent/src/types.ts";
import { timestampOfBlock } from "../config.ts";
import type { PoolEvent } from "../data.ts";
import { sqrtRatioAtTick } from "../math.ts";

export const USDT = 1_000_000n;
export const WHSK = 10n ** 18n;

/** WHSK/USDT pool at block 30,581,400 on mainnet: the block test/AgentVaultFork.t.sol forks. */
export const FORK = {
  block: 30_581_400,
  sqrtPriceX96: 22521022520436995312225n,
  liquidity: 1475813786831558685n,
  tick: -301483,
} as const;

export const policy: Policy = {
  maxTradeBps: 1000,
  maxPositionBps: 3000,
  maxExposureBps: 6000,
  maxSlippageBps: 100,
  stopLossBps: 500,
  maxDrawdownBps: 1000,
  maxTradesPerDay: 12,
  cooldown: 300,
  twapWindow: 300,
  reentryLockout: 3600,
};

/**
 * Builds a pool history by hand. The pool starts a day before `block` with one full-range
 * position, so its oracle can always look back a full window.
 */
export class PoolScript {
  readonly events: PoolEvent[] = [];
  private index = 0;

  constructor(block: number, tick: number, liquidity: bigint, sqrtPriceX96 = sqrtRatioAtTick(tick)) {
    const start = block - 43_200;
    this.events.push({ kind: "init", block: start, index: this.index++, sqrtPriceX96, tick });
    this.events.push({ kind: "mint", block: start, index: this.index++, tickLower: -887220, tickUpper: 887220, amount: liquidity });
  }

  /** A swap in `block` that leaves the pool at `tick` (and at `sqrtPriceX96`, by default the tick's own price). */
  swapTo(block: number, tick: number, liquidity: bigint, sqrtPriceX96 = sqrtRatioAtTick(tick)): this {
    this.events.push({ kind: "swap", block, index: this.index++, sqrtPriceX96, liquidity, tick, amount0: 1n, amount1: -1n });
    return this;
  }

  cardinality(block: number, next: number): this {
    this.events.push({ kind: "cardinality", block, index: this.index++, next });
    return this;
  }
}

export const at = timestampOfBlock;
