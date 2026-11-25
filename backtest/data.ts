// File formats of the committed history, and the loaders that check each file against the
// hash recorded when it was fetched.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { DATA_DIR, VENUES, type Venue } from "./config.ts";

export type PoolEvent =
  | { kind: "init"; block: number; index: number; sqrtPriceX96: bigint; tick: number }
  | {
      kind: "swap";
      block: number;
      index: number;
      /** Pool price, in-range liquidity and tick after this swap. */
      sqrtPriceX96: bigint;
      liquidity: bigint;
      tick: number;
      /** Pool balance changes: positive is paid in, negative is paid out. */
      amount0: bigint;
      amount1: bigint;
    }
  | { kind: "mint" | "burn"; block: number; index: number; tickLower: number; tickUpper: number; amount: bigint }
  /** Someone paid to enlarge the pool's price history to `next` observations. */
  | { kind: "cardinality"; block: number; index: number; next: number };

/** A candle as the exchange sent it: opening time in seconds, prices and volume as text. */
export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export const poolFile = "pool-whsk.jsonl.gz";
export const candleFile = (venue: Venue) => `candles-${venue}.csv.gz`;

// One JSON array per line keeps the file small and diffable once unzipped.
export function serializePoolEvents(events: readonly PoolEvent[]): string {
  const lines = events.map((e) => {
    switch (e.kind) {
      case "init":
        return ["I", e.block, e.index, e.sqrtPriceX96.toString(), e.tick];
      case "swap":
        return ["S", e.block, e.index, e.sqrtPriceX96.toString(), e.liquidity.toString(), e.tick, e.amount0.toString(), e.amount1.toString()];
      case "mint":
      case "burn":
        return [e.kind === "mint" ? "M" : "B", e.block, e.index, e.tickLower, e.tickUpper, e.amount.toString()];
      case "cardinality":
        return ["C", e.block, e.index, e.next];
    }
  });
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export function parsePoolEvents(content: string): PoolEvent[] {
  const events: PoolEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as [string, number, number, ...Array<string | number>];
    const [code, block, index] = row;
    if (code === "I") {
      events.push({ kind: "init", block, index, sqrtPriceX96: BigInt(row[3]!), tick: Number(row[4]) });
    } else if (code === "S") {
      events.push({
        kind: "swap",
        block,
        index,
        sqrtPriceX96: BigInt(row[3]!),
        liquidity: BigInt(row[4]!),
        tick: Number(row[5]),
        amount0: BigInt(row[6]!),
        amount1: BigInt(row[7]!),
      });
    } else if (code === "M" || code === "B") {
      events.push({
        kind: code === "M" ? "mint" : "burn",
        block,
        index,
        tickLower: Number(row[3]),
        tickUpper: Number(row[4]),
        amount: BigInt(row[5]!),
      });
    } else if (code === "C") {
      events.push({ kind: "cardinality", block, index, next: Number(row[3]) });
    } else {
      throw new Error(`unknown pool event code "${code}"`);
    }
  }
  return events;
}

export function serializeCandles(candles: readonly Candle[]): string {
  return "t,o,h,l,c,v\n" + candles.map((c) => `${c.t},${c.o},${c.h},${c.l},${c.c},${c.v}`).join("\n") + "\n";
}

export function parseCandles(content: string): Candle[] {
  const candles: Candle[] = [];
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const [t, o, h, l, c, v] = line.split(",");
    candles.push({ t: Number(t), o: o!, h: h!, l: l!, c: c!, v: v! });
  }
  return candles;
}

interface Manifest {
  fetchedAt: string;
  blocks: { from: number; to: number };
  files: Record<string, { file: string; source: string; rows: number; first: string; last: string; sha256: string }>;
}

export function loadManifest(dir = DATA_DIR): Manifest {
  const target = path.join(dir, "manifest.json");
  if (!existsSync(target)) throw new Error(`No data in ${dir}. Run "npm run backtest:fetch" first.`);
  return JSON.parse(readFileSync(target, "utf8")) as Manifest;
}

/** Reads one data file and refuses it if it is not the file the manifest describes. */
function readChecked(manifest: Manifest, key: string, dir: string): string {
  const entry = manifest.files[key];
  if (!entry) throw new Error(`The manifest has no entry for "${key}". Run "npm run backtest:fetch".`);
  const content = gunzipSync(readFileSync(path.join(dir, entry.file))).toString("utf8");
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  if (hash !== entry.sha256) throw new Error(`${entry.file} does not match the hash in the manifest; fetch the data again.`);
  return content;
}

export interface History {
  manifest: Manifest;
  events: PoolEvent[];
  candles: Record<Venue, Candle[]>;
}

export function loadHistory(dir = DATA_DIR): History {
  const manifest = loadManifest(dir);
  const candles = {} as Record<Venue, Candle[]>;
  for (const venue of VENUES) candles[venue] = parseCandles(readChecked(manifest, venue, dir));
  return { manifest, events: parsePoolEvents(readChecked(manifest, "pool", dir)), candles };
}
