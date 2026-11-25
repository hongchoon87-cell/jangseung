import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "./config.ts";

/** JSON has no bigint; token amounts are written as decimal strings. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), space);
}

/** Stable serialisation: object keys sorted, bigints as strings. Used for hashing. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as object).sort()) {
        const child = (v as Record<string, unknown>)[key];
        if (child !== undefined) out[key] = normalize(child);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

function file(name: string): string {
  mkdirSync(config.dataDir, { recursive: true });
  return path.join(config.dataDir, name);
}

export function appendLine(name: string, record: unknown): void {
  appendFileSync(file(name), toJson(record) + "\n", "utf8");
}

/** Last `limit` records of a JSON-lines file, oldest first. Unreadable lines are skipped. */
export function readLines<T>(name: string, limit: number): T[] {
  const target = file(name);
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, "utf8").split("\n").filter(Boolean).slice(-limit);
  const records: T[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // A torn final line after a crash is not worth failing the start-up for.
    }
  }
  return records;
}

export function loadJson<T>(name: string, fallback: T): T {
  const target = file(name);
  if (!existsSync(target)) return fallback;
  try {
    return JSON.parse(readFileSync(target, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(name: string, value: unknown): void {
  writeFileSync(file(name), toJson(value, 2), "utf8");
}
