// Rebuilds, for any moment in the past, the two things the live agent takes from the
// exchanges: a reference price agreed by several venues, and the trend of recent candles.
// Only candles that had already closed at that moment are used.
import { consensus, trendFromCloses, type VenueQuote } from "../agent/src/market.ts";
import type { CexQuote, Trend } from "../agent/src/types.ts";
import { ASSUMED_REFERENCE_SPREAD_BPS, CANDLE_SECONDS, VENUES, type Venue } from "./config.ts";
import type { Candle } from "./data.ts";

/**
 * Closed candles behind each trend reading. The live agent asks the exchange for its
 * newest 150 and drops the one still forming, which leaves 149.
 */
const TREND_CANDLES = 149;
/** The exchange whose candles drive the trend, as in the live agent's fetchCloses. */
const TREND_VENUE: Venue = "mexc";

interface Series {
  /** Opening times, ascending. */
  times: number[];
  closes: number[];
  volumes: number[];
  byTime: Map<number, number>;
}

function toSeries(candles: readonly Candle[]): Series {
  const series: Series = { times: [], closes: [], volumes: [], byTime: new Map() };
  for (const candle of candles) {
    const close = Number(candle.c);
    if (!(close > 0)) continue;
    series.byTime.set(candle.t, series.times.length);
    series.times.push(candle.t);
    series.closes.push(close);
    series.volumes.push(Number(candle.v));
  }
  return series;
}

export class ReferenceHistory {
  private readonly series: Record<Venue, Series>;
  /** Added to every venue price, in bps. Used to test how much the results lean on the reference. */
  private readonly shiftBps: number;

  constructor(candles: Record<Venue, readonly Candle[]>, shiftBps = 0) {
    this.series = Object.fromEntries(VENUES.map((venue) => [venue, toSeries(candles[venue])])) as Record<Venue, Series>;
    this.shiftBps = shiftBps;
  }

  /**
   * Last traded price on `venue` in the candle that closed exactly at `closeTime`, or
   * undefined when that candle is missing or had no trade. A candle without a trade only
   * repeats an older price, so it cannot serve as a quote for now.
   */
  private lastTrade(venue: Venue, closeTime: number): number | undefined {
    const series = this.series[venue];
    const index = series.byTime.get(closeTime - CANDLE_SECONDS);
    if (index === undefined || !(series.volumes[index]! > 0)) return undefined;
    return series.closes[index]! * (1 + this.shiftBps / 10_000);
  }

  /**
   * Reference price at `closeTime`, a 5-minute boundary, through the live agent's own
   * consensus rule: the median of the venues that qualify, and none at all when fewer than
   * two do. History has trades but no order books, so each venue's quote is its last trade
   * with an assumed spread around it; the live rule that drops a venue for a wide spread
   * cannot be replayed.
   * @param now timestamp in ms recorded as the moment the quotes were fetched.
   */
  quoteAt(closeTime: number, now: number): CexQuote | undefined {
    const half = ASSUMED_REFERENCE_SPREAD_BPS / 2 / 10_000;
    const quotes: VenueQuote[] = [];
    for (const venue of VENUES) {
      const price = this.lastTrade(venue, closeTime);
      if (price !== undefined) quotes.push({ venue, bid: price * (1 - half), ask: price * (1 + half) });
    }
    try {
      return consensus("HSK", quotes, now);
    } catch {
      return undefined;
    }
  }

  /**
   * Trend at `closeTime` from the newest candles that had closed by then, computed by the
   * live agent's own function.
   */
  trendAt(closeTime: number): Trend | undefined {
    const series = this.series[TREND_VENUE];
    const end = upperBound(series.times, closeTime - CANDLE_SECONDS);
    if (end === 0) return undefined;
    const closes = series.closes.slice(Math.max(0, end - TREND_CANDLES), end);
    return trendFromCloses(closes, (series.times[end - 1]! + CANDLE_SECONDS) * 1000);
  }

  /** Coverage of each venue between two times, for the data report. */
  coverage(from: number, to: number): Record<Venue, { candles: number; withTrades: number; expected: number }> {
    const expected = Math.floor((to - from) / CANDLE_SECONDS);
    const out = {} as Record<Venue, { candles: number; withTrades: number; expected: number }>;
    for (const venue of VENUES) {
      const series = this.series[venue];
      let candles = 0;
      let withTrades = 0;
      for (let i = upperBound(series.times, from - 1); i < series.times.length && series.times[i]! < to; i++) {
        candles += 1;
        if (series.volumes[i]! > 0) withTrades += 1;
      }
      out[venue] = { candles, withTrades, expected };
    }
    return out;
  }

  /** Closing prices of one venue on the 5-minute grid, NaN where there was no trade. */
  gridCloses(venue: Venue, from: number, to: number): Float64Array {
    const grid = new Float64Array(Math.floor((to - from) / CANDLE_SECONDS)).fill(NaN);
    const series = this.series[venue];
    for (let i = upperBound(series.times, from - 1); i < series.times.length && series.times[i]! < to; i++) {
      if (series.volumes[i]! > 0) grid[(series.times[i]! - from) / CANDLE_SECONDS] = series.closes[i]!;
    }
    return grid;
  }
}

/** Number of entries in the ascending array `values` that are not greater than `limit`. */
function upperBound(values: readonly number[], limit: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
