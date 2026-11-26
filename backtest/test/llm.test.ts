import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { JudgeInput } from "../../agent/src/strategist.ts";
import type { Candidate, GateVerdict, Judgment } from "../../agent/src/types.ts";
import { portfolio, settings, snapshot, USDT, whskMarket } from "../../agent/test/fixtures.ts";

// No test here may reach the API: every call goes through the fake `ask` below.
process.env.LLM_MODE = "off";
const { BudgetExceeded, ClaudeUnavailable, claudeJudge, emptyStats } = await import("../llm.ts");

const candidate = (kind: Candidate["kind"], side: Candidate["side"] = "buy"): Candidate => ({
  id: "c1",
  kind,
  side,
  symbol: "WHSK",
  amountIn: 50n * USDT,
  trigger: "test trigger",
});
const gate: GateVerdict = { ok: true, checks: [], netEdgeBps: 120, quotedOut: 625n * 10n ** 18n };
const input = (kind: Candidate["kind"] = "basis-entry", netEdgeBps = 120): JudgeInput => ({
  candidate: candidate(kind, kind === "basis-entry" ? "buy" : "sell"),
  gate: { ...gate, netEdgeBps },
  market: whskMarket(),
  snapshot: snapshot(),
  portfolio: portfolio(),
  settings: settings(),
  recent: [],
});

const answer = (action: Judgment["action"] = "reduce"): Judgment => ({
  source: "llm",
  action,
  sizeFraction: action === "veto" ? 0 : action === "reduce" ? 0.4 : 1,
  confidence: 0.7,
  rationale: "test rationale",
  riskFlags: [],
  model: "claude-opus-5-5",
  latencyMs: 5000,
  usage: { inputTokens: 3000, outputTokens: 450 },
});
const failure = (fallbackReason: string): Judgment => ({ ...answer("approve"), source: "rule-fallback", fallbackReason, usage: undefined });

function setup(ask: (input: JudgeInput) => Promise<Judgment>, capUsd = 10) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "llm-test-")), "judgments.jsonl");
  const budget = { capUsd, spentUsd: 0, reservedUsd: 0 };
  const stats = emptyStats();
  const judge = claudeJudge({ file, repeat: 1, budget, stats, ask, sleep: async () => {} });
  return { file, budget, stats, judge };
}

describe("Claude in the backtest", () => {
  it("asks once per situation and replays the stored answer afterwards", async () => {
    let asked = 0;
    const first = setup(async () => (asked++, answer("reduce")));
    const j = await first.judge(input());
    assert.equal(j.action, "reduce");
    assert.equal(asked, 1);
    assert.equal(first.stats.calls, 1);
    assert.ok(first.budget.spentUsd > 0.02 && first.budget.spentUsd < 0.025, `spent ${first.budget.spentUsd}`);

    // A new run over the same file answers from it, at no cost.
    const again = claudeJudge({ file: first.file, repeat: 1, budget: { capUsd: 10, spentUsd: 0, reservedUsd: 0 }, stats: emptyStats(), ask: async () => assert.fail("asked again") });
    assert.equal((await again(input())).action, "reduce");
  });

  it("asks again for a different situation or a different repeat", async () => {
    let asked = 0;
    const run = setup(async () => (asked++, answer()));
    await run.judge(input("basis-entry", 120));
    await run.judge(input("basis-entry", 121));
    const repeat2 = claudeJudge({ file: run.file, repeat: 2, budget: run.budget, stats: run.stats, ask: async () => (asked++, answer()), sleep: async () => {} });
    await repeat2(input("basis-entry", 120));
    assert.equal(asked, 3);
  });

  it("never asks about a stop", async () => {
    const run = setup(async () => assert.fail("a stop was put to the model"));
    const j = await run.judge(input("soft-stop"));
    assert.equal(j.source, "rule");
  });

  it("stops before the spending cap is passed", async () => {
    const run = setup(async () => answer(), 0.05);
    await assert.rejects(run.judge(input()), BudgetExceeded);
  });

  it("gives up at once when the API refuses the credentials or the request", async () => {
    await assert.rejects(setup(async () => failure("credentials were rejected")).judge(input()), ClaudeUnavailable);
    await assert.rejects(setup(async () => failure("API error 400")).judge(input()), ClaudeUnavailable);
  });

  it("tries again after a passing failure, then counts a fallback only if every attempt fails", async () => {
    let asked = 0;
    const flaky = setup(async () => (++asked < 3 ? failure("rate limited") : answer("veto")));
    assert.equal((await flaky.judge(input())).action, "veto");
    assert.equal(flaky.stats.retries, 2);
    assert.equal(flaky.stats.fallbacks, 0);

    const down = setup(async () => failure("could not reach the API"));
    const j = await down.judge(input());
    assert.equal(j.source, "rule-fallback");
    assert.equal(down.stats.fallbacks, 1);
    assert.deepEqual(down.stats.fallbackReasons, { "could not reach the API": 1 });
    // The fallback is stored too, so a replay of the run takes the same path.
    assert.equal(readFileSync(down.file, "utf8").trim().split("\n").length, 1);
  });

  it("does not ask again after a refusal, which the server-side fallback already handled", async () => {
    let asked = 0;
    const run = setup(async () => (asked++, failure("model returned no usable judgment (stop reason: refusal)")));
    await run.judge(input());
    assert.equal(asked, 1);
    assert.equal(run.stats.fallbacks, 1);
  });
});
