import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
// The SDK's helper is typed against Zod's v4 API, which zod 3.25+ ships under this path.
import * as z from "zod/v4";

import { config } from "./config.ts";
import { unrealizedBps } from "./signals.ts";
import { thresholdsFor } from "./settings.ts";
import type {
  AssetMarket,
  Candidate,
  DecisionRecord,
  GateVerdict,
  Judgment,
  MarketSnapshot,
  Portfolio,
  Settings,
} from "./types.ts";

export interface JudgeInput {
  candidate: Candidate;
  gate: GateVerdict;
  market: AssetMarket;
  snapshot: MarketSnapshot;
  portfolio: Portfolio;
  settings: Settings;
  recent: readonly DecisionRecord[];
}

const JudgmentSchema = z.object({
  action: z.enum(["approve", "reduce", "veto"]),
  size_fraction: z.number().describe("Share of the proposed size to trade, between 0 and 1."),
  confidence: z.number().describe("How confident you are in this judgment, between 0 and 1."),
  rationale: z.string().describe("Two or three plain sentences for the vault owner."),
  risk_flags: z.array(z.string()).describe("Short labels for risks you see; empty if none."),
});

const SYSTEM_PROMPT = `You are the judgment step of an automated trading agent that manages one person's funds in a smart-contract vault on HSK Chain. It trades WHSK, WETH and WBTC against USDT on HSKSwap, a Uniswap V3 style exchange with a 0.3% pool fee.

How the agent works, so you know where you sit:
1. Fixed rules propose a trade when a price pattern appears (the "candidate").
2. A verification gate has already checked the candidate against live quotes: data freshness, the vault's size and frequency limits, the real execution price, and whether the expected gain survives fees, price impact and gas. Only candidates that passed reach you.
3. You decide whether the trade should go ahead as proposed, at a smaller size, or not at all.
4. The vault contract enforces its limits again on-chain whatever you decide. You cannot raise the size above what was proposed, and nothing you say can move funds outside the vault's policy.

What you add is the judgment the rules lack. The rules look at one asset and one pattern at a time. Look at the whole picture instead: whether the signals agree with each other, whether the same setup lost money in the recent decisions, whether the portfolio is already near its drawdown limit or heavily exposed, whether the data carries warnings, and whether the size suits the conviction. A spread between the DEX and the exchange only pays if the DEX price moves toward the exchange; if the exchange itself is falling fast, the gap can close the wrong way. A trend entry pays two pool fees before it earns anything.

Vetoing is a normal, useful outcome. A small edge with a clear risk attached is not worth taking, and the owner would rather miss a trade than take a poor one. Approving is equally fine when the picture is clean. Do not approve or veto by habit: weigh this case.

For exits, lean toward reducing risk. Veto an exit only when you have a specific reason to expect the position to recover.

Answer with:
- action: "approve" for the full proposed size, "reduce" for part of it, "veto" for no trade.
- size_fraction: 1 for approve, between 0.1 and 0.9 for reduce, 0 for veto.
- confidence: between 0 and 1.
- rationale: two or three plain sentences naming the facts that decided it. The owner reads this next to the trade, and its hash is stored on-chain with the transaction, so state what you actually weighed.
- risk_flags: short labels such as "exchange falling", "near drawdown limit", "repeat of losing setup".

All amounts are in USDT. Figures in bps are hundredths of a percent. The input is a JSON object describing the candidate, the gate's measurements, the market, the portfolio, the limits in force and the most recent decisions.`;

function usdt(units: bigint): number {
  return Number(units) / 1e6;
}

function round(value: number | undefined, digits = 1): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/** The facts handed to the model. Also used by the chat, so both see the same picture. */
export function describeSituation(input: JudgeInput) {
  const { candidate, gate, market, snapshot, portfolio, settings, recent } = input;
  const exposure = portfolio.positions.reduce((sum, p) => sum + p.value, 0n);
  const now = snapshot.takenAt;

  return {
    candidate: {
      kind: candidate.kind,
      side: candidate.side,
      asset: candidate.symbol,
      size_usdt: round(candidate.side === "buy" ? usdt(candidate.amountIn) : usdt(gate.quotedOut ?? 0n), 2),
      rule_trigger: candidate.trigger,
    },
    gate: {
      net_edge_bps: round(gate.netEdgeBps),
      slippage_vs_twap_bps: round(gate.slippageVsTwapBps),
      price_impact_bps: round(gate.impactBps),
      gas_bps: round(gate.gasBps, 2),
      checks: gate.checks.map((c) => c.detail),
    },
    asset_market: {
      dex_spot: market.dexSpot,
      dex_twap: market.dexTwap,
      exchange_bid: market.cex?.bid,
      exchange_ask: market.cex?.ask,
      exchange_sources: market.cex?.sources,
      exchanges_apart_bps: round(market.cex?.dispersionBps),
      dex_vs_exchange_bps: round(market.basisBps),
      trend_bps: round(market.trend?.trendBps),
      return_1h_bps: round(market.trend?.ret1hBps),
      volatility_1h_bps: round(market.trend?.vol1hBps),
      rsi_14: round(market.trend?.rsi14),
      oracle: market.oracle
        ? { price: market.oracle.price, age_hours: round(market.oracle.ageSeconds / 3600) }
        : undefined,
    },
    other_assets: snapshot.assets
      .filter((a) => a.symbol !== candidate.symbol)
      .map((a) => ({
        asset: a.symbol,
        dex_vs_exchange_bps: round(a.basisBps),
        trend_bps: round(a.trend?.trendBps),
        return_1h_bps: round(a.trend?.ret1hBps),
      })),
    data_warnings: snapshot.warnings,
    portfolio: {
      nav_usdt: round(usdt(portfolio.nav), 2),
      performance_since_start_pct: round((Number(portfolio.pricePerShare) / 1e18 - 1) * 100, 2),
      drawdown_bps: portfolio.drawdownBps,
      exposure_pct: round(portfolio.nav === 0n ? 0 : (Number(exposure) / Number(portfolio.nav)) * 100),
      buys_today: portfolio.buysToday,
      positions: portfolio.positions
        .filter((p) => p.balance > 0n)
        .map((p) => ({
          asset: p.symbol,
          value_usdt: round(usdt(p.value), 2),
          cost_usdt: round(usdt(p.cost), 2),
          unrealized_bps: round(unrealizedBps(p)),
        })),
    },
    limits: {
      on_chain: portfolio.policy,
      owner_preferences: settings,
      thresholds_bps: thresholdsFor(settings.riskAppetite),
    },
    recent_decisions: recent.slice(-6).map((d) => ({
      minutes_ago: Math.round((now - d.at) / 60_000),
      kind: d.candidate.kind,
      asset: d.candidate.symbol,
      outcome: d.execution?.status ?? (d.gate.ok ? d.judgment?.action : "rejected by gate"),
      realized_pnl_usdt: d.execution?.realizedPnl !== undefined ? round(usdt(d.execution.realizedPnl), 2) : undefined,
      rationale: d.judgment?.rationale,
    })),
  };
}

/** Deterministic judgment, used without an LLM and whenever the LLM cannot answer in time. */
export function ruleJudgment(input: JudgeInput, source: "rule" | "rule-fallback" = "rule"): Judgment {
  const { candidate, gate, settings } = input;
  const t = thresholdsFor(settings.riskAppetite);

  if (candidate.side === "sell") {
    return {
      source,
      action: "approve",
      sizeFraction: 1,
      confidence: 0.7,
      rationale: `Rule exit: ${candidate.trigger}`,
      riskFlags: [],
    };
  }

  if (candidate.kind === "basis-entry") {
    // Scale with how far the edge clears the bar: full size at twice the required edge.
    const edge = gate.netEdgeBps ?? 0;
    const fraction = Math.min(1, Math.max(0.5, edge / (2 * t.minNetEdgeBps)));
    return {
      source,
      action: fraction < 1 ? "reduce" : "approve",
      sizeFraction: fraction,
      confidence: Math.min(0.9, 0.5 + edge / 200),
      rationale: `Rule entry: net edge ${edge.toFixed(0)} bps against a required ${t.minNetEdgeBps} bps. ${candidate.trigger}`,
      riskFlags: [],
    };
  }

  const fraction = { conservative: 0.5, balanced: 0.75, aggressive: 1 }[settings.riskAppetite];
  return {
    source,
    action: fraction < 1 ? "reduce" : "approve",
    sizeFraction: fraction,
    confidence: 0.5,
    rationale: `Rule entry on trend at ${Math.round(fraction * 100)}% size for a ${settings.riskAppetite} profile. ${candidate.trigger}`,
    riskFlags: [],
  };
}

function normalize(raw: z.infer<typeof JudgmentSchema>): Pick<Judgment, "action" | "sizeFraction" | "confidence"> {
  const confidence = Math.min(1, Math.max(0, raw.confidence));
  if (raw.action === "veto" || raw.size_fraction <= 0) return { action: "veto", sizeFraction: 0, confidence };
  // The model may never trade more than the gated size.
  const fraction = Math.min(1, raw.size_fraction);
  if (raw.action === "approve" || fraction >= 1) return { action: "approve", sizeFraction: 1, confidence };
  return { action: "reduce", sizeFraction: Math.max(0.1, fraction), confidence };
}

let client: Anthropic | undefined;

function describeError(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return `no answer within ${config.llm.timeoutMs} ms`;
  if (error instanceof Anthropic.AuthenticationError) return "credentials were rejected";
  if (error instanceof Anthropic.RateLimitError) return "rate limited";
  if (error instanceof Anthropic.APIConnectionError) return "could not reach the API";
  if (error instanceof Anthropic.APIError) return `API error ${error.status}`;
  return (error as Error).message ?? "unknown error";
}

/**
 * Stage 3 of the pipeline. Asks Claude for a judgment and falls back to the rule when the
 * model is switched off, slow, unreachable or declines. A stalled model must never stall
 * trading, and it must never be able to hold a risk exit open.
 */
export async function judge(input: JudgeInput): Promise<Judgment> {
  // Stops are not up for discussion.
  if (input.candidate.kind === "soft-stop") return ruleJudgment(input);
  if (!config.llm.enabled) return ruleJudgment(input);

  const started = Date.now();
  try {
    client ??= new Anthropic();
    const response = await client.beta.messages.parse(
      {
        model: config.llm.model,
        max_tokens: 16000,
        // If the model declines, the API reruns the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: config.llm.effort, format: betaZodOutputFormat(JudgmentSchema) },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(describeSituation(input)) }],
      },
      { timeout: config.llm.timeoutMs, maxRetries: 0 },
    );

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return {
        ...ruleJudgment(input, "rule-fallback"),
        fallbackReason: `model returned no usable judgment (stop reason: ${response.stop_reason})`,
      };
    }

    const raw = response.parsed_output;
    return {
      source: "llm",
      ...normalize(raw),
      rationale: raw.rationale.trim(),
      riskFlags: raw.risk_flags,
      model: response.model,
      latencyMs: Date.now() - started,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  } catch (error) {
    return { ...ruleJudgment(input, "rule-fallback"), fallbackReason: describeError(error), latencyMs: Date.now() - started };
  }
}
