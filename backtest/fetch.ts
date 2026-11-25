// Downloads the history the backtest replays and writes it to backtest/data:
//
//   pool-whsk.jsonl.gz     every Initialize, Swap, Mint, Burn and oracle-size change of the
//                          WHSK/USDT pool
//   candles-<venue>.csv.gz 5-minute candles of HSK/USDT from each exchange
//   manifest.json          what was fetched, from where, with a hash of each file
//
//   npm run backtest:fetch              everything
//   npm run backtest:fetch -- pool      only the pool events
//   npm run backtest:fetch -- candles   only the candles
//
// The block range and the venues are pinned in config.ts, so a second run downloads the
// same history. Pool chunks are cached in data/backtest-cache, so an interrupted run resumes.
//
// A full download is about 2,600 eth_getLogs calls. The public RPC answers 429 for a
// minute or more partway through; the fetcher waits and carries on, and takes about ten
// minutes in all. Set HSK_RPC_URL to use another endpoint.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { decodeEventLog, parseAbi, type Hex } from "viem";

import { CACHE_DIR, CANDLE_SECONDS, DATA_BLOCKS, DATA_DIR, POOL, timestampOfBlock, VENUES, type Venue } from "./config.ts";
import { candleFile, poolFile, serializeCandles, serializePoolEvents, type Candle, type PoolEvent } from "./data.ts";

const RPC_URL = process.env.HSK_RPC_URL ?? "https://mainnet.hsk.xyz";
/** The public RPC refuses eth_getLogs over more than 5,000 blocks. */
const LOG_CHUNK = 5_000;
const RPC_WORKERS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ pool logs

interface RawLog {
  topics: [Hex, ...Hex[]];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
  logIndex: Hex;
  removed?: boolean;
}

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError = "no attempt made";
  // The public RPC answers 429 for a minute or more once its quota is spent, so be patient.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body = (await response.json()) as { result?: T; error?: { message: string } };
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result as T;
      }
    } catch (error) {
      lastError = (error as Error).message;
      if (lastError.includes("block range too large")) throw error;
    }
    await sleep(Math.min(1_000 * (attempt + 1), 15_000));
  }
  throw new Error(`${method} failed after retries: ${lastError}`);
}

const poolEvents = parseAbi([
  "event Initialize(uint160 sqrtPriceX96, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event IncreaseObservationCardinalityNext(uint16 observationCardinalityNextOld, uint16 observationCardinalityNextNew)",
]);

function decode(log: RawLog): PoolEvent | undefined {
  const block = Number(BigInt(log.blockNumber));
  const index = Number(BigInt(log.logIndex));

  // The whole backtest computes time from block numbers, so every log has to agree.
  if (log.blockTimestamp !== undefined && Number(BigInt(log.blockTimestamp)) !== timestampOfBlock(block)) {
    throw new Error(`block ${block} has timestamp ${Number(BigInt(log.blockTimestamp))}, the 2-second clock says ${timestampOfBlock(block)}`);
  }

  let event;
  try {
    event = decodeEventLog({ abi: poolEvents, topics: log.topics, data: log.data });
  } catch {
    // Collect and Flash do not change price, liquidity or the oracle.
    return undefined;
  }
  switch (event.eventName) {
    case "Initialize":
      return { kind: "init", block, index, sqrtPriceX96: event.args.sqrtPriceX96, tick: event.args.tick };
    case "Swap":
      return {
        kind: "swap",
        block,
        index,
        sqrtPriceX96: event.args.sqrtPriceX96,
        liquidity: event.args.liquidity,
        tick: event.args.tick,
        amount0: event.args.amount0,
        amount1: event.args.amount1,
      };
    case "IncreaseObservationCardinalityNext":
      return { kind: "cardinality", block, index, next: event.args.observationCardinalityNextNew };
    case "Mint":
    case "Burn":
      return {
        kind: event.eventName === "Mint" ? "mint" : "burn",
        block,
        index,
        tickLower: event.args.tickLower,
        tickUpper: event.args.tickUpper,
        amount: event.args.amount,
      };
  }
}

async function fetchPoolEvents(): Promise<PoolEvent[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `pool-logs-${DATA_BLOCKS.from}-${DATA_BLOCKS.to}.json`);
  const cache: Record<string, RawLog[]> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

  const starts: number[] = [];
  for (let from = DATA_BLOCKS.from; from <= DATA_BLOCKS.to; from += LOG_CHUNK) starts.push(from);
  const todo = starts.filter((from) => cache[from] === undefined);
  console.log(`pool: ${starts.length} chunks of ${LOG_CHUNK} blocks, ${todo.length} still to download`);

  let done = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < todo.length) {
      const from = todo[next++]!;
      const to = Math.min(from + LOG_CHUNK - 1, DATA_BLOCKS.to);
      cache[from] = await rpc<RawLog[]>("eth_getLogs", [
        { address: POOL.address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ]);
      done += 1;
      if (done % 100 === 0) {
        writeFileSync(cachePath, JSON.stringify(cache));
        console.log(`pool: ${done}/${todo.length} chunks`);
      }
      await sleep(250);
    }
  }
  try {
    await Promise.all(Array.from({ length: RPC_WORKERS }, worker));
  } finally {
    // Keep what was downloaded even when a chunk gives up, so the next run resumes.
    writeFileSync(cachePath, JSON.stringify(cache));
  }

  const events: PoolEvent[] = [];
  let other = 0;
  for (const from of starts) {
    for (const log of cache[from]!) {
      if (log.removed) continue;
      const event = decode(log);
      if (event) events.push(event);
      else other += 1;
    }
  }
  events.sort((a, b) => a.block - b.block || a.index - b.index);
  console.log(`pool: ${events.length} events kept, ${other} other logs ignored`);
  return events;
}

// -------------------------------------------------------------------- candles

async function getJson(url: string): Promise<unknown> {
  let lastError = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(1_000 * (attempt + 1));
  }
  throw new Error(`${new URL(url).host} failed after retries: ${lastError}`);
}

type Row = Array<string | number>;
const text = (value: string | number | undefined) => String(value ?? "");

/**
 * One page of candles starting at `from` (seconds). Every venue here stamps a candle with
 * its opening time; checked for each one against a candle that was still forming.
 */
const PAGES: Record<Venue, { source: string; page(from: number, to: number): Promise<Candle[]> }> = {
  mexc: {
    source: "https://api.mexc.com/api/v3/klines?symbol=HSKUSDT&interval=5m",
    async page(from, to) {
      const end = Math.min(to, from + 1_000 * CANDLE_SECONDS) * 1000 - 1;
      const rows = (await getJson(`${this.source}&limit=1000&startTime=${from * 1000}&endTime=${end}`)) as Row[];
      return rows.map((r) => ({ t: Number(r[0]) / 1000, o: text(r[1]), h: text(r[2]), l: text(r[3]), c: text(r[4]), v: text(r[5]) }));
    },
  },
  hashkey: {
    source: "https://api-glb.hashkey.com/quote/v1/klines?symbol=HSKUSDT&interval=5m",
    async page(from, to) {
      const end = Math.min(to, from + 1_000 * CANDLE_SECONDS) * 1000 - 1;
      const rows = (await getJson(`${this.source}&limit=1000&startTime=${from * 1000}&endTime=${end}`)) as Row[];
      return rows.map((r) => ({ t: Number(r[0]) / 1000, o: text(r[1]), h: text(r[2]), l: text(r[3]), c: text(r[4]), v: text(r[5]) }));
    },
  },
  lbank: {
    source: "https://api.lbkex.com/v2/kline.do?symbol=hsk_usdt&type=minute5",
    async page(from) {
      const body = (await getJson(`${this.source}&size=2000&time=${from}`)) as { data?: Row[] };
      return (body.data ?? []).map((r) => ({ t: Number(r[0]), o: text(r[1]), h: text(r[2]), l: text(r[3]), c: text(r[4]), v: text(r[5]) }));
    },
  },
};

async function fetchCandles(venue: Venue, from: number, to: number): Promise<Candle[]> {
  const byTime = new Map<number, Candle>();
  let cursor = from;
  while (cursor < to) {
    const rows = (await PAGES[venue].page(cursor, to)).filter((row) => row.t >= from && row.t < to);
    const before = byTime.size;
    let newest = cursor;
    for (const row of rows) {
      if (row.t % CANDLE_SECONDS !== 0) throw new Error(`${venue}: candle at ${row.t} is not on a 5-minute boundary`);
      byTime.set(row.t, row);
      if (row.t > newest) newest = row.t;
    }
    // An empty or repeated page means the venue has nothing in this stretch: skip a day.
    cursor = byTime.size > before ? newest + CANDLE_SECONDS : cursor + 86_400;
    await sleep(250);
  }
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  console.log(`${venue}: ${candles.length} candles`);
  return candles;
}

// ------------------------------------------------------------------- manifest

interface FileEntry {
  file: string;
  source: string;
  fetchedAt: string;
  rows: number;
  first: string;
  last: string;
  sha256: string;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Writes one data file and records it in the manifest, leaving the other entries as they are. */
function save(key: string, file: string, source: string, content: string, rows: number, first: number, last: number): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path.join(DATA_DIR, file), gzipSync(Buffer.from(content, "utf8"), { level: 9 }));

  const manifestPath = path.join(DATA_DIR, "manifest.json");
  const manifest: { blocks: typeof DATA_BLOCKS; files: Record<string, FileEntry> } = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { blocks: DATA_BLOCKS, files: {} };
  manifest.blocks = DATA_BLOCKS;
  manifest.files[key] = {
    file,
    source,
    fetchedAt: new Date().toISOString(),
    rows,
    first: iso(first),
    last: iso(last),
    // Hash of the uncompressed text, so it does not depend on the zlib version.
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${file}: ${rows} rows, ${iso(first)} to ${iso(last)}`);
}

async function main(): Promise<void> {
  const what = process.argv[2] ?? "all";
  const from = timestampOfBlock(DATA_BLOCKS.from);
  const to = timestampOfBlock(DATA_BLOCKS.to) + 1;

  if (what === "all" || what === "pool") {
    const events = await fetchPoolEvents();
    save(
      "pool",
      poolFile,
      `${RPC_URL} eth_getLogs, pool ${POOL.address}, blocks ${DATA_BLOCKS.from} to ${DATA_BLOCKS.to}`,
      serializePoolEvents(events),
      events.length,
      timestampOfBlock(events[0]!.block),
      timestampOfBlock(events[events.length - 1]!.block),
    );
  }

  if (what === "all" || what === "candles") {
    // Candles start on the 5-minute boundary at or before the pool's creation.
    const start = Math.floor(from / CANDLE_SECONDS) * CANDLE_SECONDS;
    for (const venue of VENUES) {
      const candles = await fetchCandles(venue, start, to);
      save(venue, candleFile(venue), PAGES[venue].source, serializeCandles(candles), candles.length, candles[0]!.t, candles[candles.length - 1]!.t);
    }
  }
}

await main();
