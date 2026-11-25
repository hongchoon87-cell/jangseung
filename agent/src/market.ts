import type { PublicClient } from "viem";

import { aggregatorAbi, poolAbi } from "./chain.ts";
import { ASSETS, BASE, config, type AssetInfo } from "./config.ts";
import { bps, ema, realizedVolBps, rsi } from "./indicators.ts";
import type { AssetMarket, CexQuote, MarketSnapshot, OracleReading, Trend } from "./types.ts";

const Q192 = 1n << 192n;
const CANDLE_MS = 5 * 60 * 1000;
const CANDLE_REFRESH_MS = 60 * 1000;

function assetIsToken0(asset: AssetInfo): boolean {
  return BigInt(asset.address) < BigInt(BASE.address);
}

/** Converts a pool price expressed as token1 per token0 (raw units) to base token per asset. */
function toBasePerAsset(rawToken1PerToken0: number, asset: AssetInfo): number {
  const scale = 10 ** (asset.decimals - BASE.decimals);
  return assetIsToken0(asset) ? rawToken1PerToken0 * scale : scale / rawToken1PerToken0;
}

/**
 * Base token the pool holds in range at its current price, in base token units. In a
 * Uniswap V3 pool that is liquidity times the square root of the price (or divided by it,
 * when the base token is token0). A trade worth x% of this moves the average fill by x%.
 */
export function baseDepth(market: Pick<AssetMarket, "dexSpot" | "poolLiquidity">, asset: AssetInfo): number {
  const scale = 10 ** (asset.decimals - BASE.decimals);
  const rawToken1PerToken0 = assetIsToken0(asset) ? market.dexSpot / scale : scale / market.dexSpot;
  const root = Math.sqrt(rawToken1PerToken0);
  return assetIsToken0(asset) ? Number(market.poolLiquidity) * root : Number(market.poolLiquidity) / root;
}

export function priceFromSqrtX96(sqrtPriceX96: bigint, asset: AssetInfo): number {
  // Scale before dividing so prices as small as 1e-14 keep their precision.
  const raw = Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** 30n) / Q192) / 1e30;
  return toBasePerAsset(raw, asset);
}

export function priceFromTick(tick: number, asset: AssetInfo): number {
  return toBasePerAsset(Math.pow(1.0001, tick), asset);
}

/** Mean tick over `window` seconds from two cumulative tick readings, rounded down. */
export function meanTick(tickCumulatives: readonly bigint[], window: number): number {
  const delta = tickCumulatives[1]! - tickCumulatives[0]!;
  const span = BigInt(window);
  let tick = delta / span;
  if (delta < 0n && delta % span !== 0n) tick -= 1n;
  return Number(tick);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${new URL(url).pathname}`);
  return response.json();
}

export interface VenueQuote {
  venue: string;
  bid: number;
  ask: number;
}

type Json = Record<string, unknown>;

/** Best bid and ask of `ticker`/USDT on each exchange that lists it. */
const VENUES: ReadonlyArray<{ name: string; quote(ticker: string): Promise<{ bid: unknown; ask: unknown }> }> = [
  {
    name: "hashkey",
    async quote(ticker) {
      const [row] = (await getJson(`${config.cexBaseUrl}/quote/v1/ticker/bookTicker?symbol=${ticker}USDT`)) as Json[];
      return { bid: row?.b, ask: row?.a };
    },
  },
  {
    name: "gate",
    async quote(ticker) {
      const [row] = (await getJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${ticker}_USDT`)) as Json[];
      return { bid: row?.highest_bid, ask: row?.lowest_ask };
    },
  },
  {
    name: "kucoin",
    async quote(ticker) {
      const body = (await getJson(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${ticker}-USDT`)) as {
        data?: Json;
      };
      return { bid: body.data?.bestBid, ask: body.data?.bestAsk };
    },
  },
  {
    name: "mexc",
    async quote(ticker) {
      const row = (await getJson(`https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${ticker}USDT`)) as Json;
      return { bid: row.bidPrice, ask: row.askPrice };
    },
  },
  {
    // Added with the backtest: one of the three venues whose HSK market trades in nearly
    // every 5-minute candle, so the live reference and the replayed one share two sources.
    name: "lbank",
    async quote(ticker) {
      const body = (await getJson(`https://api.lbkex.com/v2/supplement/ticker/bookTicker.do?symbol=${ticker.toLowerCase()}_usdt`)) as {
        data?: Json;
      };
      return { bid: body.data?.bidPrice, ask: body.data?.askPrice };
    },
  },
];

/** A venue whose own spread is wider than this tells us little about the price. */
const MAX_VENUE_SPREAD_BPS = 60;
const MIN_VENUES = 2;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Combines venue quotes into one reference price. A single exchange can be thin or stale
 * (HashKey Global's HSK book was 150 bps wide when this was written), so venues with a
 * wide spread are dropped and the median of the rest is used. Fewer than two usable
 * venues means there is no reference, and the caller must not trade on one.
 */
export function consensus(symbol: string, quotes: readonly VenueQuote[], now = Date.now()): CexQuote {
  const usable = quotes.filter((q) => q.bid > 0 && q.ask >= q.bid && bps(q.ask, q.bid) <= MAX_VENUE_SPREAD_BPS);
  if (usable.length < MIN_VENUES) {
    throw new Error(`only ${usable.length} of ${quotes.length} exchanges quote ${symbol} tightly enough`);
  }
  const mids = usable.map((q) => (q.bid + q.ask) / 2);
  const bid = median(usable.map((q) => q.bid));
  const ask = median(usable.map((q) => q.ask));
  return {
    symbol,
    bid,
    ask,
    mid: median(mids),
    spreadBps: bps(ask, bid),
    dispersionBps: bps(Math.max(...mids), Math.min(...mids)),
    sources: usable.map((q) => q.venue),
    fetchedAt: now,
  };
}

/** Reference price of `ticker` from every exchange that answers in time. */
export async function fetchReference(ticker: string): Promise<CexQuote> {
  const settled = await Promise.allSettled(
    VENUES.map(async (venue): Promise<VenueQuote> => {
      const { bid, ask } = await venue.quote(ticker);
      return { venue: venue.name, bid: Number(bid), ask: Number(ask) };
    }),
  );
  const quotes = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  return consensus(ticker, quotes);
}

/**
 * Closing prices of finished 5-minute candles, oldest first, with the last close time.
 * MEXC is tried first because its HSK market trades in most intervals; HashKey Global is
 * the fallback. Both return rows that start with the open time and carry the close fifth.
 */
export async function fetchCloses(ticker: string, limit = 150): Promise<{ closes: number[]; asOf: number }> {
  const sources = [
    `https://api.mexc.com/api/v3/klines?symbol=${ticker}USDT&interval=5m&limit=${limit}`,
    `${config.cexBaseUrl}/quote/v1/klines?symbol=${ticker}USDT&interval=5m&limit=${limit}`,
  ];
  let lastError: unknown;
  for (const url of sources) {
    try {
      const rows = (await getJson(url)) as [number, string, string, string, string, ...unknown[]][];
      if (!Array.isArray(rows) || rows.length === 0) throw new Error(`no candles for ${ticker}`);

      // The newest row is usually still forming. Using it would leak the future into the signal.
      const now = Date.now();
      const finished = rows.filter((row) => Number(row[0]) + CANDLE_MS <= now);
      if (finished.length === 0) throw new Error(`no finished candles for ${ticker}`);
      return {
        closes: finished.map((row) => Number(row[4])),
        asOf: Number(finished[finished.length - 1]![0]) + CANDLE_MS,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function trendFromCloses(closes: readonly number[], asOf: number): Trend | undefined {
  if (closes.length < 60) return undefined;
  const last = closes[closes.length - 1]!;
  const hourAgo = closes[closes.length - 13]!;
  return {
    trendBps: bps(ema(closes, 12), ema(closes, 48)),
    ret1hBps: bps(last, hourAgo),
    vol1hBps: realizedVolBps(closes.slice(-49), 12),
    rsi14: rsi(closes.slice(-60)),
    asOf,
  };
}

const trendCache = new Map<string, { trend: Trend | undefined; fetchedAt: number }>();

async function getTrend(symbol: string): Promise<Trend | undefined> {
  const cached = trendCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CANDLE_REFRESH_MS) return cached.trend;
  const { closes, asOf } = await fetchCloses(symbol);
  const trend = trendFromCloses(closes, asOf);
  trendCache.set(symbol, { trend, fetchedAt: Date.now() });
  return trend;
}

async function readOracle(
  client: PublicClient,
  asset: AssetInfo,
  blockTimestamp: number,
): Promise<OracleReading | undefined> {
  if (!asset.oracle) return undefined;
  const [round, decimals] = await Promise.all([
    client.readContract({ address: asset.oracle, abi: aggregatorAbi, functionName: "latestRoundData" }),
    client.readContract({ address: asset.oracle, abi: aggregatorAbi, functionName: "decimals" }),
  ]);
  const updatedAt = Number(round[3]);
  return { price: Number(round[1]) / 10 ** decimals, updatedAt, ageSeconds: blockTimestamp - updatedAt };
}

/**
 * One consistent look at the market: pool state from the chain, the reference price agreed
 * by several exchanges, and the oracle with its age. A failed source is recorded as a warning and
 * left undefined, so later stages can refuse to act on missing data instead of guessing.
 */
export async function collectMarket(
  clients: { publicClient: PublicClient; directClient: PublicClient },
  pools: ReadonlyMap<string, `0x${string}`>,
  twapWindow: number,
): Promise<MarketSnapshot> {
  const client = clients.publicClient;
  const warnings: string[] = [];
  const [block, gasPriceWei] = await Promise.all([client.getBlock(), config.assumedGasPriceWei ?? client.getGasPrice()]);
  const blockTimestamp = Number(block.timestamp);

  const assets = await Promise.all(
    ASSETS.map(async (asset): Promise<AssetMarket | undefined> => {
      const pool = pools.get(asset.symbol);
      if (!pool) return undefined;

      const [slot0, liquidity, observation] = await Promise.all([
        client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[twapWindow, 0]] }),
      ]);

      const market: AssetMarket = {
        symbol: asset.symbol,
        dexSpot: priceFromSqrtX96(slot0[0], asset),
        dexTwap: priceFromTick(meanTick(observation[0], twapWindow), asset),
        poolLiquidity: liquidity,
      };

      const [cex, trend, oracle] = await Promise.allSettled([
        fetchReference(asset.ticker),
        getTrend(asset.ticker),
        // The feeds reject reads that arrive through another contract, so skip Multicall3 here.
        readOracle(clients.directClient, asset, blockTimestamp),
      ]);
      if (cex.status === "fulfilled") {
        market.cex = cex.value;
        market.basisBps = bps(market.dexSpot, cex.value.mid);
      } else {
        warnings.push(`${asset.symbol}: exchange quote unavailable (${String(cex.reason?.message ?? cex.reason)})`);
      }
      if (trend.status === "fulfilled") market.trend = trend.value;
      else warnings.push(`${asset.symbol}: candles unavailable (${String(trend.reason?.message ?? trend.reason)})`);
      if (oracle.status === "fulfilled") market.oracle = oracle.value;
      else warnings.push(`${asset.symbol}: oracle unreadable (${String(oracle.reason?.shortMessage ?? oracle.reason?.message ?? oracle.reason).split("\n")[0]})`);

      return market;
    }),
  );

  return {
    takenAt: Date.now(),
    blockNumber: block.number,
    blockTimestamp,
    gasPriceWei,
    assets: assets.filter((a): a is AssetMarket => a !== undefined),
    warnings,
  };
}
