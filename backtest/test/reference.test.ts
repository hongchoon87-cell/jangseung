import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Venue } from "../config.ts";
import type { Candle } from "../data.ts";
import { ReferenceHistory } from "../reference.ts";

const T0 = 1_780_000_200; // a 5-minute boundary
const candle = (t: number, close: number, volume = 100): Candle => ({ t, o: String(close), h: String(close), l: String(close), c: String(close), v: String(volume) });

/** Three venues with one candle each in the slot that closes at T0 + 300. */
function venues(prices: Partial<Record<Venue, [number, number?]>>): Record<Venue, Candle[]> {
  const make = (venue: Venue) => (prices[venue] ? [candle(T0, prices[venue]![0], prices[venue]![1] ?? 100)] : []);
  return { mexc: make("mexc"), hashkey: make("hashkey"), lbank: make("lbank") };
}

describe("reference price from candles", () => {
  it("is the median of the venues' last trades in the candle that just closed", () => {
    const reference = new ReferenceHistory(venues({ mexc: [0.0810], hashkey: [0.0820], lbank: [0.0812] }));
    const quote = reference.quoteAt(T0 + 300, 123)!;
    assert.ok(Math.abs(quote.mid - 0.0812) < 1e-9);
    assert.deepEqual(quote.sources, ["mexc", "hashkey", "lbank"]);
    assert.equal(quote.fetchedAt, 123);
    assert.ok(Math.abs(quote.dispersionBps - (0.082 / 0.081 - 1) * 10_000) < 1e-6);
  });

  it("does not see a candle before it has closed", () => {
    const reference = new ReferenceHistory(venues({ mexc: [0.0810], hashkey: [0.0820], lbank: [0.0812] }));
    assert.equal(reference.quoteAt(T0, 0), undefined, "at its opening time the candle is still to come");
    assert.equal(reference.quoteAt(T0 + 600, 0), undefined, "one candle later it is no longer the newest");
  });

  it("ignores a venue whose candle had no trade, and needs two venues", () => {
    const two = new ReferenceHistory(venues({ mexc: [0.0810], hashkey: [0.0900, 0], lbank: [0.0812] }));
    assert.deepEqual(two.quoteAt(T0 + 300, 0)!.sources, ["mexc", "lbank"]);
    assert.ok(Math.abs(two.quoteAt(T0 + 300, 0)!.mid - 0.0811) < 1e-9);

    const one = new ReferenceHistory(venues({ mexc: [0.0810], hashkey: [0.0900, 0] }));
    assert.equal(one.quoteAt(T0 + 300, 0), undefined);
  });

  it("applies the sensitivity shift to every venue", () => {
    const base = new ReferenceHistory(venues({ mexc: [0.0810], lbank: [0.0812] })).quoteAt(T0 + 300, 0)!;
    const shifted = new ReferenceHistory(venues({ mexc: [0.0810], lbank: [0.0812] }), -10).quoteAt(T0 + 300, 0)!;
    assert.ok(Math.abs(shifted.mid / base.mid - 0.999) < 1e-9);
  });
});

describe("trend from candles", () => {
  const series = (count: number, price: (i: number) => number): Record<Venue, Candle[]> => ({
    mexc: Array.from({ length: count }, (_, i) => candle(T0 + i * 300, price(i))),
    hashkey: [],
    lbank: [],
  });

  it("needs 60 closed candles", () => {
    const reference = new ReferenceHistory(series(200, () => 0.08));
    assert.equal(reference.trendAt(T0 + 59 * 300), undefined);
    assert.ok(reference.trendAt(T0 + 60 * 300));
  });

  it("uses only candles closed by then, and is stamped with the newest one's close", () => {
    // Flat for 100 candles, then a jump.
    const reference = new ReferenceHistory(series(200, (i) => (i < 100 ? 0.08 : 0.09)));
    const before = reference.trendAt(T0 + 100 * 300)!;
    assert.equal(before.trendBps, 0, "the jump candle opens at this moment and has not closed");
    assert.equal(before.asOf, (T0 + 100 * 300) * 1000);

    const after = reference.trendAt(T0 + 101 * 300)!;
    assert.ok(after.trendBps > 0);
    assert.ok(after.ret1hBps > 1_000);
  });
});
