// Claude as the judgment step of the backtest.
//
// Calls the same judge() the live agent uses, with the same prompt and the same input. Every
// answer is kept in the run's results folder, so a run can be replayed without the API and
// gives the same result. Calls stop before a spending cap is passed, and a call that fails
// for a passing reason (rate limit, overload, timeout) is tried again instead of quietly
// letting the rule decide, which would blur the comparison.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { config } from "../agent/src/config.ts";
import { describeSituation, judge, ruleJudgment, type JudgeInput } from "../agent/src/strategist.ts";
import type { Judgment } from "../agent/src/types.ts";

/** USD per token, from the published prices. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4 / 1e6, output: 20 / 1e6 },
  "claude-sonnet-5-5": { input: 2 / 1e6, output: 10 / 1e6 },
};
/** Charged against the cap for a call that may have reached the model but reported no usage. */
const UNREPORTED_CALL_USD = 0.04;
/** Set aside for each call in flight, so runs going at the same time cannot pass the cap together. */
const RESERVE_USD = 0.06;
const MAX_ATTEMPTS = 7;

export class BudgetExceeded extends Error {}
export class ClaudeUnavailable extends Error {}

/** Shared by every run of one invocation. */
export interface Budget {
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
}

export interface LlmStats {
  /** Answered by the API during this run. */
  calls: number;
  /** Answered from the judgments stored by an earlier run. */
  replayed: number;
  /** Attempts repeated after a passing failure. */
  retries: number;
  /** Decisions the rule made because Claude could not, after every attempt. */
  fallbacks: number;
  fallbackReasons: Record<string, number>;
  /** Judgments by candidate kind and action. */
  byKind: Record<string, Record<string, number>>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number[];
}

export function emptyStats(): LlmStats {
  return { calls: 0, replayed: 0, retries: 0, fallbacks: 0, fallbackReasons: {}, byKind: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: [] };
}

export interface ClaudeJudgeOptions {
  /** JSON-lines file of stored judgments for this run; read first, appended to. */
  file: string;
  /** Repeats of the same run differ only in this number, which is part of every key. */
  repeat: number;
  budget: Budget;
  stats: LlmStats;
  /** The call to the model; tests replace it. */
  ask?: (input: JudgeInput) => Promise<Judgment>;
  /** Waits between attempts; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
}

/** Hash of the prompt's source, so a changed prompt never replays an old answer. */
const STRATEGIST_SOURCE = createHash("sha256")
  .update(readFileSync(path.join("agent", "src", "strategist.ts")))
  .digest("hex");

function keyFor(input: JudgeInput, repeat: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        model: config.llm.model,
        effort: config.llm.effort,
        prompt: STRATEGIST_SOURCE,
        repeat,
        kind: input.candidate.kind,
        side: input.candidate.side,
        situation: describeSituation(input),
      }),
    )
    .digest("hex");
}

/** A failure that no number of attempts will fix: bad credentials, no credit, a malformed request. */
function isPermanent(reason: string): boolean {
  return reason === "credentials were rejected" || /^API error 4\d\d$/.test(reason);
}

/** A failure after which the model may still have been billed. */
function mayHaveBeenBilled(reason: string): boolean {
  return reason.startsWith("no answer within") || reason.startsWith("model returned no usable judgment");
}

export function claudeJudge(options: ClaudeJudgeOptions): (input: JudgeInput) => Promise<Judgment> {
  const { file, repeat, budget, stats } = options;
  const ask = options.ask ?? judge;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!options.ask) {
    if (!config.llm.enabled) throw new ClaudeUnavailable("Claude is not configured. Run the backtest through backtest/with-claude.ts.");
    if (!PRICES[config.llm.model]) throw new ClaudeUnavailable(`No price on record for ${config.llm.model}; add it to PRICES in backtest/llm.ts.`);
  }
  const price = PRICES[config.llm.model] ?? { input: 0, output: 0 };

  const stored = new Map<string, Judgment>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { key: string; judgment: Judgment };
      stored.set(row.key, row.judgment);
    }
  }

  const tally = (input: JudgeInput, judgment: Judgment) => {
    const kind = (stats.byKind[input.candidate.kind] ??= {});
    const label = judgment.source === "llm" ? judgment.action : `${judgment.action} (rule)`;
    kind[label] = (kind[label] ?? 0) + 1;
  };

  const keep = (key: string, input: JudgeInput, judgment: Judgment, costUsd: number) => {
    const at = new Date(input.snapshot.takenAt).toISOString();
    appendFileSync(file, JSON.stringify({ key, at, kind: input.candidate.kind, side: input.candidate.side, costUsd: +costUsd.toFixed(5), judgment }) + "\n");
    stored.set(key, judgment);
  };

  return async (input: JudgeInput): Promise<Judgment> => {
    // Stops are not put to the model, in the backtest as live.
    if (input.candidate.kind === "soft-stop") return ruleJudgment(input);

    const key = keyFor(input, repeat);
    const replay = stored.get(key);
    if (replay) {
      stats.replayed += 1;
      tally(input, replay);
      return replay;
    }

    let last: Judgment | undefined;
    let unreported = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (budget.spentUsd + budget.reservedUsd + RESERVE_USD > budget.capUsd) {
        throw new BudgetExceeded(`spending cap of $${budget.capUsd} reached ($${budget.spentUsd.toFixed(2)} spent)`);
      }
      budget.reservedUsd += RESERVE_USD;
      let judgment: Judgment;
      try {
        judgment = await ask(input);
      } finally {
        budget.reservedUsd -= RESERVE_USD;
      }

      if (judgment.source === "llm") {
        const cost = (judgment.usage?.inputTokens ?? 0) * price.input + (judgment.usage?.outputTokens ?? 0) * price.output;
        budget.spentUsd += cost;
        stats.costUsd += cost + unreported;
        stats.calls += 1;
        stats.inputTokens += judgment.usage?.inputTokens ?? 0;
        stats.outputTokens += judgment.usage?.outputTokens ?? 0;
        if (judgment.latencyMs !== undefined) stats.latencyMs.push(judgment.latencyMs);
        keep(key, input, judgment, cost);
        tally(input, judgment);
        return judgment;
      }

      const reason = judgment.fallbackReason ?? "unknown";
      if (isPermanent(reason)) throw new ClaudeUnavailable(reason);
      if (mayHaveBeenBilled(reason)) {
        budget.spentUsd += UNREPORTED_CALL_USD;
        unreported += UNREPORTED_CALL_USD;
      }
      last = judgment;
      // A refusal already went through the server-side fallback; asking again will not help.
      if (reason.startsWith("model returned no usable judgment")) break;
      stats.retries += 1;
      await sleep(Math.min(60_000, 3_000 * 2 ** attempt));
    }

    const fallback = last ?? ruleJudgment(input, "rule-fallback");
    const reason = fallback.fallbackReason ?? "unknown";
    stats.fallbacks += 1;
    stats.costUsd += unreported;
    stats.fallbackReasons[reason] = (stats.fallbackReasons[reason] ?? 0) + 1;
    keep(key, input, fallback, unreported);
    tally(input, fallback);
    return fallback;
  };
}

/** The numbers worth keeping in a run's summary. */
export function summarizeStats(stats: LlmStats) {
  const sorted = [...stats.latencyMs].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : undefined);
  return {
    model: config.llm.model,
    effort: config.llm.effort,
    timeoutMs: config.llm.timeoutMs,
    calls: stats.calls,
    replayed: stats.replayed,
    retries: stats.retries,
    fallbacks: stats.fallbacks,
    fallbackReasons: stats.fallbackReasons,
    byKind: stats.byKind,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    costUsd: +stats.costUsd.toFixed(4),
    latencyMs: { median: at(0.5), p90: at(0.9), max: sorted.at(-1) },
  };
}
