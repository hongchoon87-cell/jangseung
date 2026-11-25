// Everything that pins a backtest run: where the data comes from, how it is cut into
// periods, and what trading costs. Changing a value here changes the results, so each one
// says where it came from.

import path from "node:path";

/** Committed snapshot of the history the backtest replays. */
export const DATA_DIR = path.join("backtest", "data");
/** Results of each run: config, metrics, trades, equity curve. */
export const RESULTS_DIR = path.join("backtest", "results");
/** Raw downloads kept between fetches. Not committed. */
export const CACHE_DIR = path.join("data", "backtest-cache");

// ---------------------------------------------------------------- chain clock

/**
 * HSK Chain is an OP Stack chain with a fixed 2-second block. Checked on 2026-11-24 at
 * eight blocks spread over 20 million: every one sits exactly on this line. The fetcher
 * checks it again against the timestamp of every log it downloads.
 */
export const CHAIN_CLOCK = { block: 30_585_896, timestamp: 1_795_518_927, blockSeconds: 2 } as const;

export function timestampOfBlock(block: number): number {
  return CHAIN_CLOCK.timestamp + (block - CHAIN_CLOCK.block) * CHAIN_CLOCK.blockSeconds;
}

/** Number of the newest block whose timestamp is not later than `timestamp`. */
export function blockAtOrBefore(timestamp: number): number {
  return CHAIN_CLOCK.block + Math.floor((timestamp - CHAIN_CLOCK.timestamp) / CHAIN_CLOCK.blockSeconds);
}

// ----------------------------------------------------------------------- data

/** The pool the backtest trades on. WETH and WBTC pools are too thin to be default targets. */
export const POOL = {
  symbol: "WHSK",
  address: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC",
  /** Block in which the pool contract first has code (binary search on eth_getCode). */
  createdBlock: 17_714_162,
} as const;

/** Blocks downloaded: from the pool's creation to the last block of 2026-11-23 UTC. */
export const DATA_BLOCKS = { from: POOL.createdBlock, to: blockAtOrBefore(Date.UTC(2026, 10, 24) / 1000 - 1) } as const;

export const CANDLE_SECONDS = 300;

/**
 * Exchanges whose 5-minute history is dense enough to replay. The live agent also reads
 * Gate and KuCoin, but Gate serves only its last 10,000 candles and most of KuCoin's HSK
 * candles have no trade in them, so neither can stand in for a price in the past.
 */
export const VENUES = ["mexc", "hashkey", "lbank"] as const;
export type Venue = (typeof VENUES)[number];

/**
 * Observations the pool's oracle is assumed to hold throughout a backtest.
 *
 * Until 2026-10-26 the real pool kept a single observation, overwritten by every price
 * change. With one slot nothing can read a TWAP for five minutes after a swap, the swap's
 * own transaction included, so every vault buy would have reverted at the valuation that
 * follows its swap. Enlarging a pool's oracle is a call anyone may make and pay for, and
 * somebody did: 16 slots on 2026-10-26, 240 on 2026-10-31. The backtest assumes the
 * vault's owner had done that before listing the pool. Prices are not affected by it,
 * only whether the TWAP can be read.
 */
export const ASSUMED_ORACLE_SLOTS = 240;

// -------------------------------------------------------------------- periods

const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / 1000;

/**
 * Time is the unit that leaks, so the split is by date and was fixed before any strategy
 * result was looked at. Choices are made on `development`; `report` is run once, with the
 * configuration already frozen.
 *
 * Development starts on the first full day the pool could be traded at all: until
 * 2026-04-20 it held under 20 USDT a side, and the position that brought it to about
 * 50,000 USDT a side settled on 2026-04-21. The boundary between the two periods is a
 * calendar date, 2026-09-01, chosen without looking at prices.
 */
export const PERIODS = {
  development: { from: utc(2026, 4, 22), to: utc(2026, 9, 1) },
  report: { from: utc(2026, 9, 1), to: utc(2026, 11, 24) },
} as const;
export type PeriodName = keyof typeof PERIODS;

// ---------------------------------------------------------------------- costs

export const COSTS = {
  /**
   * Gas price charged on every simulated transaction: the 500 gwei base fee the chain has
   * used since block 25,742,703 (2026-08-04) plus the 1 gwei tip seen on real swaps. Before
   * that date the base fee was near zero, so applying today's price to the whole history
   * overstates what gas really cost then. That is deliberate: the question is what the
   * strategy would earn under the costs it faces now.
   */
  gasPriceWei: 501_000_000_000n,
  /**
   * Gas per vault call, rounded up from runs on a mainnet fork: a buy used up to 322,526, an
   * agent's sale well under 200,000, and a stop-loss sale that sizes itself 222,900.
   */
  gasUnits: { buy: 325_000n, sell: 200_000n, stopLoss: 225_000n, checkpoint: 60_000n },
  /** A reverted transaction still pays for the work done before the revert. */
  revertedGasUnits: 150_000n,
} as const;

// --------------------------------------------------------------------- timing

export const TIMING = {
  /** Seconds after a candle closes before the agent has it and has read the chain. */
  decisionDelay: 6,
  /** Seconds from decision to the block the transaction lands in (two blocks). */
  executionDelay: 4,
} as const;

/**
 * Spread assumed around the reference price. History has no order books, only trades, so
 * the live spread checks cannot be replayed. 20 bps is what MEXC showed on 2026-11-24; it
 * only feeds the "no-premium" check for trend entries.
 */
export const ASSUMED_REFERENCE_SPREAD_BPS = 20;
