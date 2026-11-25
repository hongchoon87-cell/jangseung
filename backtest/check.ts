// Checks the downloaded history before anything is concluded from it.
//
//   npm run backtest:check             data quality, from the files alone
//   npm run backtest:check -- chain    also compares the replay with the chain itself
//
// The chain comparison picks blocks at random (fixed seed) across the whole history and
// asks the archive RPC for the pool's price, liquidity and TWAP and for QuoterV2's quote
// at each one. The replay has to give the same numbers. Results go to
// backtest/data/verification.json.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { createPublicClient, http } from "viem";

import { poolAbi, quoterAbi } from "../agent/src/chain.ts";
import { ADDRESSES, assetBySymbol, BASE } from "../agent/src/config.ts";
import { blockAtOrBefore, CANDLE_SECONDS, DATA_BLOCKS, DATA_DIR, PERIODS, POOL, timestampOfBlock, VENUES, type Venue } from "./config.ts";
import { loadHistory, type PoolEvent } from "./data.ts";
import { amount0Delta, amount1Delta, feeOnNetInput, meanTickOf, swapExactInput } from "./math.ts";
import { PoolReplay, quoteSwap } from "./pool.ts";
import { ReferenceHistory } from "./reference.ts";

const TWAP_WINDOW = 300;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const month = (seconds: number) => iso(seconds).slice(0, 7);
const pct = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Deterministic random numbers, so the sampled blocks are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- pool data

function poolReport(events: readonly PoolEvent[], pool: PoolReplay) {
  const byMonth = new Map<string, { swaps: number; liquidity: bigint[]; volumeUsdt: number }>();
  const cardinality: Array<{ at: string; block: number; next: number }> = [];

  for (const event of events) {
    const key = month(timestampOfBlock(event.block));
    const bucket = byMonth.get(key) ?? { swaps: 0, liquidity: [], volumeUsdt: 0 };
    byMonth.set(key, bucket);
    if (event.kind === "swap") {
      bucket.swaps += 1;
      bucket.liquidity.push(event.liquidity);
      bucket.volumeUsdt += Math.abs(Number(event.amount1)) / 1e6;
    } else if (event.kind === "cardinality") {
      cardinality.push({ at: iso(timestampOfBlock(event.block)), block: event.block, next: event.next });
    }
  }

  // Replay each swap from the state before it: the pool's own history is the test set
  // for the swap maths. A swap specified by its input must come out identical to the wei.
  // One specified by its output, or stopped at a price limit, charges its fee on top of
  // the net input instead; those are recognised by that identity. A swap that crossed an
  // initialised tick met a second liquidity on the way and is counted apart.
  let previous: { sqrtPriceX96: bigint; liquidity: bigint; tick: number } | undefined;
  const swapReplay = { exactInput: 0, exactOutputOrLimit: 0, crossedTicks: 0, unexplained: 0 };
  const unexplained: string[] = [];
  for (const event of events) {
    if (event.kind === "init") previous = { sqrtPriceX96: event.sqrtPriceX96, liquidity: 0n, tick: event.tick };
    else if (event.kind === "mint" || event.kind === "burn") {
      if (previous && event.tickLower <= previous.tick && previous.tick < event.tickUpper) {
        previous.liquidity += event.kind === "mint" ? event.amount : -event.amount;
      }
    } else if (event.kind === "swap") {
      if (previous && previous.liquidity > 0n) {
        if (previous.liquidity !== event.liquidity) swapReplay.crossedTicks += 1;
        else {
          const zeroForOne = event.amount0 > 0n;
          const amountIn = zeroForOne ? event.amount0 : event.amount1;
          const paidOut = zeroForOne ? -event.amount1 : -event.amount0;
          const before = previous.sqrtPriceX96;
          const after = event.sqrtPriceX96;
          const replayed = swapExactInput(before, previous.liquidity, amountIn, zeroForOne, 3000);
          if (replayed.amountOut === paidOut && replayed.sqrtPriceAfter === after) swapReplay.exactInput += 1;
          else {
            const netIn = zeroForOne ? amount0Delta(after, before, previous.liquidity, true) : amount1Delta(before, after, previous.liquidity, true);
            const curveOut = zeroForOne ? amount1Delta(after, before, previous.liquidity, false) : amount0Delta(before, after, previous.liquidity, false);
            // An exact-output swap never pays more than was asked for, so it may pay a hair less than the curve gives.
            if (amountIn === netIn + feeOnNetInput(netIn, 3000) && paidOut <= curveOut) swapReplay.exactOutputOrLimit += 1;
            else {
              swapReplay.unexplained += 1;
              if (unexplained.length < 5) unexplained.push(`block ${event.block} index ${event.index}`);
            }
          }
        }
      }
      previous = { sqrtPriceX96: event.sqrtPriceX96, liquidity: event.liquidity, tick: event.tick };
    }
  }

  const months = [...byMonth.entries()].map(([key, bucket]) => {
    const sorted = [...bucket.liquidity].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      month: key,
      swaps: bucket.swaps,
      volumeUsdt: Math.round(bucket.volumeUsdt),
      medianLiquidity: sorted.length ? sorted[sorted.length >> 1]!.toString() : "0",
    };
  });

  return {
    events: events.length,
    stats: pool.stats,
    first: iso(pool.firstTimestamp),
    last: iso(pool.lastTimestamp),
    months,
    cardinality,
    swapReplay: { ...swapReplay, unexplainedExamples: unexplained },
  };
}

/** Share of 5-minute boundaries in each month at which the vault's TWAP could be read. */
function twapAvailability(pool: PoolReplay, from: number, to: number) {
  const byMonth = new Map<string, { ticks: number; readable: number }>();
  for (let t = Math.ceil(from / CANDLE_SECONDS) * CANDLE_SECONDS; t < to; t += CANDLE_SECONDS) {
    const ts = timestampOfBlock(blockAtOrBefore(t + 6));
    if (ts < pool.firstTimestamp + TWAP_WINDOW) continue;
    const bucket = byMonth.get(month(t)) ?? { ticks: 0, readable: 0 };
    byMonth.set(month(t), bucket);
    bucket.ticks += 1;
    if (pool.canObserve(ts, TWAP_WINDOW)) bucket.readable += 1;
  }
  return [...byMonth.entries()].map(([key, b]) => ({ month: key, ticks: b.ticks, readable: pct(b.readable, b.ticks) }));
}

// ------------------------------------------------------------- candle data

function candleReport(reference: ReferenceHistory, from: number, to: number) {
  const grids = Object.fromEntries(VENUES.map((venue) => [venue, reference.gridCloses(venue, from, to)])) as Record<Venue, Float64Array>;
  const slots = grids[VENUES[0]]!.length;

  const coverage = Object.fromEntries(
    VENUES.map((venue) => {
      const c = reference.coverage(from, to);
      return [venue, { candles: c[venue].candles, expected: c[venue].expected, withTrades: pct(c[venue].withTrades, c[venue].expected) }];
    }),
  );

  // Per month: how often at least two venues traded in a candle (a reference price exists).
  const byMonth = new Map<string, { slots: number; two: number; three: number; perVenue: Record<string, number> }>();
  for (let i = 0; i < slots; i++) {
    const key = month(from + i * CANDLE_SECONDS);
    const bucket = byMonth.get(key) ?? { slots: 0, two: 0, three: 0, perVenue: Object.fromEntries(VENUES.map((v) => [v, 0])) };
    byMonth.set(key, bucket);
    bucket.slots += 1;
    let traded = 0;
    for (const venue of VENUES) {
      if (!Number.isNaN(grids[venue][i]!)) {
        traded += 1;
        bucket.perVenue[venue]! += 1;
      }
    }
    if (traded >= 2) bucket.two += 1;
    if (traded >= 3) bucket.three += 1;
  }
  const months = [...byMonth.entries()].map(([key, b]) => ({
    month: key,
    referenceAvailable: pct(b.two, b.slots),
    allThree: pct(b.three, b.slots),
    ...Object.fromEntries(VENUES.map((v) => [v, pct(b.perVenue[v]!, b.slots)])),
  }));

  // If one venue's timestamps were shifted by a candle, its returns would line up with the
  // others' at a lag of one instead of zero.
  const returns = (grid: Float64Array) => {
    const out = new Float64Array(grid.length).fill(NaN);
    for (let i = 1; i < grid.length; i++) out[i] = Math.log(grid[i]! / grid[i - 1]!);
    return out;
  };
  const correlation = (a: Float64Array, b: Float64Array, lag: number) => {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let i = Math.max(0, -lag); i < a.length - Math.max(0, lag); i++) {
      const x = a[i]!;
      const y = b[i + lag]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      n += 1;
      sa += x;
      sb += y;
      saa += x * x;
      sbb += y * y;
      sab += x * y;
    }
    const cov = sab / n - (sa / n) * (sb / n);
    return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
  };
  const alignment: Record<string, Record<string, string>> = {};
  for (let i = 0; i < VENUES.length; i++) {
    for (let j = i + 1; j < VENUES.length; j++) {
      const a = returns(grids[VENUES[i]!]);
      const b = returns(grids[VENUES[j]!]);
      alignment[`${VENUES[i]} vs ${VENUES[j]}`] = Object.fromEntries(
        [-2, -1, 0, 1, 2].map((lag) => [`lag ${lag}`, correlation(a, b, lag).toFixed(3)]),
      );
    }
  }

  // How far apart the venues' last trades sit in the same candle.
  const spreads: number[] = [];
  for (let i = 0; i < slots; i++) {
    const prices = VENUES.map((v) => grids[v][i]!).filter((p) => !Number.isNaN(p));
    if (prices.length >= 2) spreads.push((Math.max(...prices) / Math.min(...prices) - 1) * 10_000);
  }
  spreads.sort((a, b) => a - b);
  const quantile = (q: number) => spreads[Math.min(spreads.length - 1, Math.floor(q * spreads.length))]!;

  return {
    coverage,
    months,
    alignment,
    venueDisagreementBps: {
      median: +quantile(0.5).toFixed(1),
      p90: +quantile(0.9).toFixed(1),
      p99: +quantile(0.99).toFixed(1),
      max: +spreads[spreads.length - 1]!.toFixed(1),
    },
  };
}

// --------------------------------------------------------- chain comparison

async function chainReport(pool: PoolReplay, samples: number) {
  const client = createPublicClient({ transport: http(process.env.HSK_RPC_URL ?? "https://mainnet.hsk.xyz", { retryCount: 8, retryDelay: 1_000, timeout: 30_000 }) });
  const asset = assetBySymbol(POOL.symbol)!;
  const random = mulberry32(20261124);
  // Samples cover the periods the backtest trades in. Before them the pool held a few
  // USDT, where a 50 USDT quote runs through several liquidity ranges and no single-range
  // formula applies.
  const firstBlock = blockAtOrBefore(PERIODS.development.from);

  const blocks: number[] = [];
  // Half the samples are plain random blocks; the other half sit just after a swap, where
  // the TWAP window still contains the price change.
  const steps = pool.stepsBetween(timestampOfBlock(firstBlock), timestampOfBlock(DATA_BLOCKS.to));
  for (let i = 0; i < samples; i++) {
    if (i % 2 === 0) blocks.push(firstBlock + Math.floor(random() * (DATA_BLOCKS.to - firstBlock)));
    else blocks.push(Math.min(DATA_BLOCKS.to, steps[Math.floor(random() * steps.length)]!.block + 1 + Math.floor(random() * 100)));
  }

  const mismatches: string[] = [];
  let oracleReverts = 0;
  let oracleRevertsPredicted = 0;
  const compared = { state: 0, twap: 0, buyQuote: 0, sellQuote: 0 };
  /** Quotes that differ from the chain, by how much, and whether the pool was all but empty at the time. */
  const quoteGaps: Array<{ block: number; side: string; relative: number; ticksCrossed: number; depthUsdt: number }> = [];
  const buyIn = 50n * 10n ** BigInt(BASE.decimals);
  const sellIn = 600n * 10n ** BigInt(asset.decimals);

  for (const block of blocks) {
    const blockNumber = BigInt(block);
    const ts = timestampOfBlock(block);
    const state = pool.stateAt(ts);

    const [slot0, liquidity] = await Promise.all([
      client.readContract({ address: POOL.address, abi: poolAbi, functionName: "slot0", blockNumber }),
      client.readContract({ address: POOL.address, abi: poolAbi, functionName: "liquidity", blockNumber }),
    ]);
    compared.state += 1;
    if (slot0[0] !== state.sqrtPriceX96 || slot0[1] !== state.tick || liquidity !== state.liquidity) {
      mismatches.push(`block ${block}: state differs (chain sqrtP ${slot0[0]}, tick ${slot0[1]}, L ${liquidity}; replay ${state.sqrtPriceX96}, ${state.tick}, ${state.liquidity})`);
    }

    const predicted = pool.canObserve(ts, TWAP_WINDOW);
    try {
      const [cumulatives] = await client.readContract({ address: POOL.address, abi: poolAbi, functionName: "observe", args: [[TWAP_WINDOW, 0]], blockNumber });
      compared.twap += 1;
      const chainTick = meanTickOf(cumulatives[0]!, cumulatives[1]!, TWAP_WINDOW);
      if (!predicted) mismatches.push(`block ${block}: the oracle answered although the replay said it could not`);
      else if (chainTick !== pool.meanTick(ts, TWAP_WINDOW)) {
        mismatches.push(`block ${block}: TWAP tick differs (chain ${chainTick}, replay ${pool.meanTick(ts, TWAP_WINDOW)})`);
      }
    } catch {
      oracleReverts += 1;
      if (predicted) mismatches.push(`block ${block}: the oracle reverted although the replay said it could answer`);
      else oracleRevertsPredicted += 1;
    }

    for (const side of ["buy", "sell"] as const) {
      const amountIn = side === "buy" ? buyIn : sellIn;
      const [tokenIn, tokenOut] = side === "buy" ? [BASE.address, asset.address] : [asset.address, BASE.address];
      try {
        const { result } = await client.simulateContract({
          address: ADDRESSES.quoter,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee: asset.fee, sqrtPriceLimitX96: 0n }],
          blockNumber,
        });
        compared[side === "buy" ? "buyQuote" : "sellQuote"] += 1;
        const replayed = quoteSwap(state, side, amountIn, asset.fee);
        if (result[0] !== replayed) {
          quoteGaps.push({
            block,
            side,
            relative: Math.abs(Number(replayed) / Number(result[0]) - 1),
            ticksCrossed: result[2],
            // Base token the pool holds in range at this price: liquidity times sqrt(price).
            depthUsdt: Number((state.liquidity * state.sqrtPriceX96) >> 96n) / 10 ** BASE.decimals,
          });
        }
      } catch (error) {
        mismatches.push(`block ${block}: quoter call failed (${(error as Error).message.split("\n")[0]})`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // A quote can only differ when the swap crosses an initialised tick. With normal depth
  // that changes the amount by parts per million; in an emptied pool it changes everything,
  // and there the gate and the vault's TWAP floor refuse the trade anyway.
  const deep = quoteGaps.filter((gap) => gap.depthUsdt >= 1_000);
  const empty = quoteGaps.filter((gap) => gap.depthUsdt < 1_000);
  return {
    sampledBlocks: blocks.length,
    firstSample: iso(timestampOfBlock(Math.min(...blocks))),
    lastSample: iso(timestampOfBlock(Math.max(...blocks))),
    compared,
    oracleReverts,
    oracleRevertsPredicted,
    quotes: {
      identical: compared.buyQuote + compared.sellQuote - quoteGaps.length,
      differingWithNormalDepth: deep.length,
      largestRelativeGapWithNormalDepth: deep.reduce((worst, gap) => Math.max(worst, gap.relative), 0),
      differingInEmptiedPool: empty.length,
      examples: quoteGaps.slice(0, 8),
    },
    mismatches,
  };
}

// --------------------------------------------------------------------- main

const history = loadHistory();
const pool = new PoolReplay(history.events);
const reference = new ReferenceHistory(history.candles);
const from = Math.ceil(pool.firstTimestamp / CANDLE_SECONDS) * CANDLE_SECONDS;
const to = timestampOfBlock(DATA_BLOCKS.to) + 1;

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  dataFetchedAt: Object.fromEntries(Object.entries(history.manifest.files).map(([key, entry]) => [key, (entry as { fetchedAt?: string }).fetchedAt])),
  pool: poolReport(history.events, pool),
  twapAvailability: twapAvailability(pool, from, to),
  candles: candleReport(reference, from, to),
};

if (process.argv[2] === "chain") {
  const samples = Number(process.argv[3] ?? 120);
  console.log(`comparing the replay with the chain at ${samples} blocks...`);
  report.chain = await chainReport(pool, samples);
}

const target = path.join(DATA_DIR, process.argv[2] === "chain" ? "verification.json" : "quality.json");
writeFileSync(target, JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
console.log(`\nwrote ${target}`);
