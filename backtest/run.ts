// Runs the backtest experiments for one period and writes the results.
//
//   npm run backtest -- development              every experiment on the development period
//   npm run backtest -- report                   the same on the report period
//   npm run backtest -- development sizing rule  only the named experiments
//   npm run backtest -- --code-hash              print the hash of the code a result depends on
//
// Each experiment changes one thing against the one it is compared with. Results land in
// backtest/results/<period>/, with the hashes of the data and the code that produced them.
//
// The experiments with Claude as the judgment step cost money and never run unless named.
// They go through backtest/with-claude.ts, which supplies the API key:
//   npm run backtest:claude -- report llm basis-only-llm --cap-usd 15 [--repeats 3]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Policy, Settings } from "../agent/src/types.ts";
import { policyFromEnv } from "../scripts/lib/policy.ts";
import { analyseGate, analyseTrips } from "./analysis.ts";
import { ASSUMED_ORACLE_SLOTS, CANDLE_SECONDS, COSTS, PERIODS, RESULTS_DIR, TIMING, type PeriodName } from "./config.ts";
import { loadHistory } from "./data.ts";
import { runBacktest, type Arm, type RunResult } from "./engine.ts";
import { BudgetExceeded, ClaudeUnavailable, claudeJudge, emptyStats, summarizeStats, type Budget, type LlmStats } from "./llm.ts";
import { holdBaseline, summarize, type RoundTrip, type Summary } from "./metrics.ts";
import { PoolReplay } from "./pool.ts";
import { ReferenceHistory } from "./reference.ts";

interface Experiment {
  id: string;
  /** What this run changes, and against which other run it should be read. */
  note: string;
  arm: Arm;
  settings?: Partial<Settings>;
  depositUsdt?: number;
  /** Bps added to every exchange price, to see how much the result leans on the reference. */
  referenceShiftBps?: number;
  /** Price our trades as if they left no mark on the pool. */
  ignoreOwnImpact?: boolean;
  /** The owner clears a tripped drawdown breaker this many hours after it trips. */
  resumeAfterHours?: number;
}

/** The vault policy a fresh deployment gets, from the same function the deploy script uses. */
const POLICY: Policy = policyFromEnv({});
const DEPOSIT_USDT = 1_000;

/**
 * Owner preferences every experiment starts from, written out so that a later change to
 * the live agent's defaults cannot silently change what an experiment means.
 */
const BASE_SETTINGS: Settings = {
  paused: false,
  riskAppetite: "balanced",
  positionSizeBps: 500,
  maxTradesPerDay: 4,
  minMinutesBetweenTrades: 15,
  targetAssets: ["WHSK"],
  strategies: ["basis", "trend"],
};

/**
 * The first three are the comparison the plan asks for: rule alone, then the gate added,
 * then the sizing step added. `sizing` is the agent as first built, without an LLM, and
 * every experiment after it changes one thing against it.
 *
 * `basis-only` is the configuration chosen on the development period, for the reasons in
 * docs/백테스트_결과.md; `basis-only-resume` differs from it only if the breaker trips.
 */
const EXPERIMENTS: Experiment[] = [
  { id: "rule", note: "Rule candidates traded in full, limits only. Baseline for the gate.", arm: "rule" },
  { id: "gate", note: "Adds the verification gate to `rule`.", arm: "gate" },
  { id: "sizing", note: "Adds rule-based sizing to `gate`. The agent as first built, without an LLM.", arm: "gate+sizing" },
  { id: "basis-only", note: "`sizing` with the trend rules switched off. Chosen on the development period.", arm: "gate+sizing", settings: { strategies: ["basis"] } },
  {
    id: "basis-only-resume",
    note: "`basis-only` with the owner clearing a tripped breaker after 24 hours.",
    arm: "gate+sizing",
    settings: { strategies: ["basis"] },
    resumeAfterHours: 24,
  },
  { id: "trend-only", note: "`sizing` with the gap rules switched off.", arm: "gate+sizing", settings: { strategies: ["trend"] } },
  { id: "conservative", note: "`sizing` with the conservative thresholds.", arm: "gate+sizing", settings: { riskAppetite: "conservative" } },
  { id: "aggressive", note: "`sizing` with the aggressive thresholds.", arm: "gate+sizing", settings: { riskAppetite: "aggressive" } },
  { id: "nav-100", note: "`sizing` with a 100 USDT vault: gas weighs ten times more.", arm: "gate+sizing", depositUsdt: 100 },
  { id: "nav-10000", note: "`sizing` with a 10,000 USDT vault: price impact weighs ten times more.", arm: "gate+sizing", depositUsdt: 10_000 },
  { id: "ref-minus-10", note: "`sizing` with every exchange price 10 bps lower.", arm: "gate+sizing", referenceShiftBps: -10 },
  { id: "ref-plus-10", note: "`sizing` with every exchange price 10 bps higher.", arm: "gate+sizing", referenceShiftBps: 10 },
  {
    id: "price-taker",
    note: "`sizing` simulated as if our own trades never moved the pool. Shows what that common shortcut would have claimed.",
    arm: "gate+sizing",
    ignoreOwnImpact: true,
  },
  // With Claude as the judgment step. Read each against the experiment it replaces the sizing
  // step of. Run on the report period only, under backtest/results/freeze-llm.json.
  { id: "llm", note: "`sizing` with Claude as the judgment step in place of the rule-based sizing. The live agent's defaults with an API key.", arm: "gate+llm" },
  { id: "basis-only-llm", note: "`basis-only` with Claude as the judgment step in place of the rule-based sizing.", arm: "gate+llm", settings: { strategies: ["basis"] } },
];

/** Written before Claude's judgment was first run on the report period; see main(). */
const LLM_FREEZE = path.join(RESULTS_DIR, "freeze-llm.json");

const MODEL_OVERLAP =
  "The model's training data runs to June 2026 and overlaps the development period (2026-04-22 to 2026-08-31), " +
  "so its judgment there may draw on knowing how HSK moved. Run Claude on the report period, or pass --allow-overlap " +
  "to run it on development anyway and read the result with that in mind.";

const toJson = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Backtest modules a result depends on. The fetcher, the checks and the tests do not change a result. */
const RESULT_MODULES = ["analysis", "config", "data", "engine", "llm", "math", "metrics", "pool", "reference", "run", "vault"];

/** Hash of every source file a result depends on, so a result can be tied to the code that made it. */
function codeHash(): string {
  const hash = createHash("sha256");
  const add = (file: string) => hash.update(`${file.replaceAll("\\", "/")}\n`).update(readFileSync(file));
  for (const dir of [path.join("agent", "src"), path.join("agent", "src", "abi")]) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts")).sort()) add(path.join(dir, file));
  }
  // The vault policy every run starts from. Other deployment helpers in that folder do not touch a result.
  add(path.join("scripts", "lib", "policy.ts"));
  for (const name of RESULT_MODULES) add(path.join("backtest", `${name}.ts`));
  return hash.digest("hex");
}

function csv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]!);
  const cell = (value: unknown) => (value === undefined ? "" : Array.isArray(value) ? value.join(" ") : String(value));
  return [columns.join(","), ...rows.map((row) => columns.map((c) => cell(row[c])).join(","))].join("\n") + "\n";
}

function tripRows(trips: readonly RoundTrip[]) {
  return trips.map((t) => ({
    opened: iso(t.openedAt),
    closed: iso(t.closedAt),
    entry: t.entryKind,
    exit: t.exitKind,
    buys: t.buys,
    sells: t.sells,
    cost_usdt: t.costUsdt.toFixed(6),
    proceeds_usdt: t.proceedsUsdt.toFixed(6),
    pnl_usdt: t.pnlUsdt.toFixed(6),
    pnl_bps: t.pnlBps.toFixed(1),
    hold_hours: t.holdHours.toFixed(2),
    entry_gap_bps: t.entryBasisBps?.toFixed(1),
    entry_net_edge_bps: t.entryNetEdgeBps?.toFixed(1),
    gate_failures: t.entryGateFailures,
    exchange_move_bps: t.referenceMoveBps?.toFixed(1),
    dex_move_bps: t.dexMoveBps.toFixed(1),
  }));
}

/** One point an hour is enough to draw the curve; the metrics use every tick. */
function equityRows(result: RunResult) {
  const rows = [];
  let lastHour = -1;
  for (const point of result.equity) {
    const hour = Math.floor(point.t / 3600);
    if (hour === lastHour) continue;
    lastHour = hour;
    rows.push({
      time: iso(point.t),
      nav_usdt: point.nav.toFixed(4),
      sold_now_usdt: point.liquid.toFixed(4),
      gas_usdt: point.gas.toFixed(4),
      exposure: point.exposure.toFixed(4),
      dex_price: point.dexSpot.toPrecision(7),
      exchange_price: point.cexMid?.toPrecision(7),
    });
  }
  return rows;
}

function line(summary: Summary): string {
  const r = summary.roundTrips;
  return [
    summary.label.padEnd(13),
    `${summary.returnPct.toFixed(2).padStart(7)}%`,
    `dd ${summary.maxDrawdownPct.toFixed(2).padStart(5)}%`,
    `trips ${String(r.count).padStart(4)}`,
    `win ${r.count ? ((r.wins / r.count) * 100).toFixed(0).padStart(3) : "  -"}%`,
    `mean ${r.meanBps.toFixed(0).padStart(5)} bps`,
    `fees ${summary.poolFeesUsdt.toFixed(2).padStart(7)}`,
    `gas ${summary.gasUsdt.toFixed(2).padStart(6)}`,
    `in market ${summary.timeInMarketPct.toFixed(0).padStart(3)}%`,
    summary.halted ? "HALTED" : "",
  ].join("  ");
}

interface Flags {
  /** Runs of each experiment with Claude; repeats differ only in what the model answers. */
  repeats: number;
  /** Spending cap in USD for all calls to Claude made by this invocation. */
  capUsd: number;
  allowOverlap: boolean;
}

function parseArgs(argv: readonly string[]): { positional: string[]; flags: Flags; printHash: boolean } {
  const positional: string[] = [];
  const flags: Flags = { repeats: 1, capUsd: 0, allowOverlap: false };
  let printHash = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--repeats") flags.repeats = Number(argv[++i]);
    else if (arg === "--cap-usd") flags.capUsd = Number(argv[++i]);
    else if (arg === "--allow-overlap") flags.allowOverlap = true;
    else if (arg === "--code-hash") printHash = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (!Number.isInteger(flags.repeats) || flags.repeats < 1) throw new Error("--repeats takes a whole number from 1.");
  if (!(flags.capUsd >= 0)) throw new Error("--cap-usd takes an amount in dollars.");
  return { positional, flags, printHash };
}

/** Runs with Claude on the report period use exactly the code recorded before the first of them. */
function checkLlmFreeze(): void {
  if (!existsSync(LLM_FREEZE)) {
    throw new Error(`Write ${LLM_FREEZE} before running Claude on the report period: what is run, and what is expected, before any result exists.`);
  }
  const frozen = JSON.parse(readFileSync(LLM_FREEZE, "utf8")) as { codeSha256: string };
  const now = codeHash();
  if (frozen.codeSha256 !== now) {
    throw new Error(`The code changed since ${LLM_FREEZE} was written (${frozen.codeSha256.slice(0, 8)} then, ${now.slice(0, 8)} now).`);
  }
}

function llmLine(stats: LlmStats): string {
  const judged = Object.entries(stats.byKind)
    .map(([kind, actions]) => `${kind} ${Object.entries(actions).map(([a, n]) => `${a} ${n}`).join("/")}`)
    .join("; ");
  return `claude: ${stats.calls} calls, ${stats.replayed} replayed, ${stats.retries} retries, ${stats.fallbacks} fallbacks, $${stats.costUsd.toFixed(2)} | ${judged}`;
}

async function main(): Promise<void> {
  const { positional, flags, printHash } = parseArgs(process.argv.slice(2));
  if (printHash) {
    console.log(codeHash());
    return;
  }
  const periodName = (positional[0] ?? "development") as PeriodName;
  const period = PERIODS[periodName];
  if (!period) throw new Error(`Unknown period "${periodName}". Use one of: ${Object.keys(PERIODS).join(", ")}.`);
  const wanted = positional.slice(1);
  // Experiments with Claude cost money: they run only when named.
  const experiments = wanted.length ? EXPERIMENTS.filter((e) => wanted.includes(e.id)) : EXPERIMENTS.filter((e) => e.arm !== "gate+llm");
  if (experiments.length === 0) throw new Error(`No experiment matches ${wanted.join(", ")}.`);
  const withClaude = experiments.filter((e) => e.arm === "gate+llm");
  if (withClaude.length > 0) {
    if (periodName === "development" && !flags.allowOverlap) throw new Error(MODEL_OVERLAP);
    if (!(flags.capUsd > 0)) throw new Error("Experiments with Claude cost money: give a spending cap with --cap-usd.");
    if (periodName === "report") checkLlmFreeze();
  }
  const budget: Budget = { capUsd: flags.capUsd, spentUsd: 0, reservedUsd: 0 };

  const history = loadHistory();
  const pool = new PoolReplay(history.events, { oracleSlots: ASSUMED_ORACLE_SLOTS });
  const outDir = path.join(RESULTS_DIR, periodName);
  mkdirSync(outDir, { recursive: true });

  // What holding would have done, from the exchange reference price alone.
  const plain = new ReferenceHistory(history.candles);
  const prices: Array<{ t: number; price: number }> = [];
  for (let close = Math.ceil(period.from / CANDLE_SECONDS) * CANDLE_SECONDS; close < period.to; close += CANDLE_SECONDS) {
    const quote = plain.quoteAt(close, 0);
    if (quote) prices.push({ t: close, price: quote.mid });
  }
  const baselines = [
    holdBaseline("hold USDT", prices, 0),
    holdBaseline(`hold HSK, ${POLICY.maxPositionBps / 100}% of the vault (the position cap)`, prices, POLICY.maxPositionBps / 10_000),
    holdBaseline("hold HSK, whole vault", prices, 1),
  ];

  console.log(`period ${periodName}: ${iso(period.from)} to ${iso(period.to)}`);
  for (const baseline of baselines) {
    console.log(`${baseline.label.padEnd(48)} ${baseline.returnPct.toFixed(2).padStart(7)}%  dd ${baseline.maxDrawdownPct.toFixed(2)}%`);
  }

  const summaries: Summary[] = [];
  const code = withClaude.length > 0 ? codeHash() : undefined;

  async function runOne(experiment: Experiment, repeat: number): Promise<void> {
    const id = repeat === 1 ? experiment.id : `${experiment.id}-r${repeat}`;
    const dir = path.join(outDir, id);
    mkdirSync(dir, { recursive: true });
    const reference = experiment.referenceShiftBps ? new ReferenceHistory(history.candles, experiment.referenceShiftBps) : plain;
    const stats = emptyStats();
    const judge = experiment.arm === "gate+llm" ? claudeJudge({ file: path.join(dir, "judgments.jsonl"), repeat, budget, stats }) : undefined;
    const started = Date.now();
    const result = await runBacktest(pool, reference, {
      label: id,
      from: period.from,
      to: period.to,
      arm: experiment.arm,
      policy: POLICY,
      settings: { ...BASE_SETTINGS, ...experiment.settings },
      depositUsdt: experiment.depositUsdt ?? DEPOSIT_USDT,
      ignoreOwnImpact: experiment.ignoreOwnImpact,
      resumeAfterHours: experiment.resumeAfterHours,
      judge,
    });
    const { summary, trips } = summarize(result);
    summaries.push(summary);

    writeFileSync(
      path.join(dir, "summary.json"),
      toJson({
        experiment,
        ...(judge ? { repeat, codeSha256: code, llm: summarizeStats(stats) } : {}),
        summary,
        trips: analyseTrips(trips),
        gate: analyseGate(result, pool, plain),
      }),
    );
    writeFileSync(path.join(dir, "trades.csv"), csv(tripRows(trips)));
    writeFileSync(path.join(dir, "equity.csv"), csv(equityRows(result)));
    console.log(`${line(summary)}  (${((Date.now() - started) / 1000).toFixed(1)}s)${judge ? `\n  ${llmLine(stats)}` : ""}`);
  }

  for (const experiment of experiments.filter((e) => e.arm !== "gate+llm")) await runOne(experiment, 1);

  // Runs with Claude spend their time waiting for answers, so they go side by side.
  const jobs = withClaude.flatMap((experiment) => Array.from({ length: flags.repeats }, (_, i) => ({ experiment, repeat: i + 1 })));
  const outcomes = await Promise.allSettled(jobs.map(({ experiment, repeat }) => runOne(experiment, repeat)));
  let failed = false;
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") return;
    const { experiment, repeat } = jobs[i]!;
    const reason = outcome.reason as Error;
    const known = reason instanceof BudgetExceeded || reason instanceof ClaudeUnavailable;
    console.error(`${experiment.id} (repeat ${repeat}) stopped: ${known ? reason.message : reason.stack ?? reason}`);
    failed = true;
  });
  if (withClaude.length > 0) {
    console.log(`claude spending in this invocation: $${budget.spentUsd.toFixed(2)} of a $${budget.capUsd} cap. Answers are kept in each run's judgments.jsonl.`);
  }
  if (failed) process.exitCode = 1;

  // A partial run must not replace the index of a full one.
  if (wanted.length === 0) {
    writeFileSync(
      path.join(outDir, "index.json"),
      toJson({
        period: { name: periodName, from: iso(period.from), to: iso(period.to) },
        generatedAt: new Date().toISOString(),
        data: Object.fromEntries(Object.entries(history.manifest.files).map(([key, entry]) => [key, entry.sha256])),
        codeSha256: codeHash(),
        policy: POLICY,
        settings: BASE_SETTINGS,
        depositUsdt: DEPOSIT_USDT,
        costs: COSTS,
        timing: TIMING,
        assumedOracleSlots: ASSUMED_ORACLE_SLOTS,
        experiments: EXPERIMENTS,
        baselines,
        summaries,
      }),
    );
    console.log(`wrote ${path.join(outDir, "index.json")}`);
  }
}

await main();
