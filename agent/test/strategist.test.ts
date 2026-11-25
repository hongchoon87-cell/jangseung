import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Candidate, GateVerdict } from "../src/types.ts";
import { portfolio, settings, snapshot, USDT, whskMarket } from "./fixtures.ts";

// The model must stay out of these tests: they cover the path taken when it is unavailable.
process.env.LLM_MODE = "off";
const { describeSituation, judge, ruleJudgment } = await import("../src/strategist.ts");
const { memoFor } = await import("../src/executor.ts");

const candidate = (kind: Candidate["kind"], side: Candidate["side"] = "buy"): Candidate => ({
  id: "c1",
  kind,
  side,
  symbol: "WHSK",
  amountIn: 50n * USDT,
  trigger: "test trigger",
});
const gate = (netEdgeBps?: number): GateVerdict => ({ ok: true, checks: [], netEdgeBps, quotedOut: 625n * 10n ** 18n });
const input = (c: Candidate, g: GateVerdict, s = settings()) => ({
  candidate: c,
  gate: g,
  market: whskMarket(),
  snapshot: snapshot(),
  portfolio: portfolio(),
  settings: s,
  recent: [],
});

describe("rule judgment", () => {
  it("sizes a gap buy by how far the edge clears the bar", () => {
    // Balanced profile requires 25 bps; full size from 50 bps.
    assert.equal(ruleJudgment(input(candidate("basis-entry"), gate(25))).sizeFraction, 0.5);
    assert.equal(ruleJudgment(input(candidate("basis-entry"), gate(40))).sizeFraction, 0.8);
    const full = ruleJudgment(input(candidate("basis-entry"), gate(90)));
    assert.deepEqual([full.action, full.sizeFraction], ["approve", 1]);
  });

  it("sizes a trend buy by risk appetite", () => {
    const at = (riskAppetite: "conservative" | "balanced" | "aggressive") =>
      ruleJudgment(input(candidate("trend-entry"), gate(), settings({ riskAppetite }))).sizeFraction;
    assert.deepEqual([at("conservative"), at("balanced"), at("aggressive")], [0.5, 0.75, 1]);
  });

  it("always sells in full", () => {
    const j = ruleJudgment(input(candidate("take-profit", "sell"), gate()));
    assert.deepEqual([j.action, j.sizeFraction], ["approve", 1]);
  });
});

describe("judge without a model", () => {
  it("returns the rule judgment and labels it as such", async () => {
    const j = await judge(input(candidate("basis-entry"), gate(60)));
    assert.equal(j.source, "rule");
    assert.equal(j.action, "approve");
  });
});

describe("what the model is told", () => {
  it("describes the situation in plain numbers without raw token units", () => {
    const situation = describeSituation(input(candidate("basis-entry"), gate(60)));
    assert.equal(situation.candidate.size_usdt, 50);
    assert.equal(situation.portfolio.nav_usdt, 1000);
    assert.equal(situation.gate.net_edge_bps, 60);
    assert.doesNotThrow(() => JSON.stringify(situation), "no bigint may reach the request body");
  });
});

describe("on-chain memo", () => {
  it("changes when any part of the decision changes", () => {
    const base = { id: "d1", at: 1, candidate: candidate("basis-entry"), market: { symbol: "WHSK" as const, dexSpot: 0.08, dexTwap: 0.08 }, gate: gate(60) };
    const memo = memoFor(base);
    assert.match(memo, /^0x[0-9a-f]{64}$/);
    assert.equal(memoFor({ ...base }), memo);
    assert.notEqual(memoFor({ ...base, gate: gate(61) }), memo);
    assert.notEqual(memoFor({ ...base, candidate: { ...base.candidate, amountIn: 51n * USDT } }), memo);
  });
});
