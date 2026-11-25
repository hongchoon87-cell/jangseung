import { config } from "./config.ts";
import type { EngineState } from "./engine.ts";
import { effectiveLimits, thresholdsFor } from "./settings.ts";
import { unrealizedBps } from "./signals.ts";
import type { DecisionRecord } from "./types.ts";

const usdt = (units: bigint | string | undefined): number | undefined =>
  units === undefined ? undefined : Number(units) / 1e6;

function round(value: number | undefined, digits = 2): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

function decisionView(d: DecisionRecord) {
  const failed = d.gate.checks.find((c) => !c.ok);
  const outcome = d.execution?.status ?? (!d.gate.ok ? "rejected" : d.judgment?.action === "veto" ? "vetoed" : "pending");
  return {
    id: d.id,
    at: d.at,
    kind: d.candidate.kind,
    side: d.candidate.side,
    asset: d.candidate.symbol,
    trigger: d.candidate.trigger,
    outcome,
    gate: {
      ok: d.gate.ok,
      failed: failed ? { name: failed.name, detail: failed.detail } : undefined,
      checks: d.gate.checks,
      netEdgeBps: round(d.gate.netEdgeBps, 1),
      slippageVsTwapBps: round(d.gate.slippageVsTwapBps, 1),
      impactBps: round(d.gate.impactBps, 1),
    },
    judgment: d.judgment && {
      source: d.judgment.source,
      action: d.judgment.action,
      sizeFraction: d.judgment.sizeFraction,
      confidence: round(d.judgment.confidence),
      rationale: d.judgment.rationale,
      riskFlags: d.judgment.riskFlags,
      model: d.judgment.model,
      latencyMs: d.judgment.latencyMs,
      fallbackReason: d.judgment.fallbackReason,
    },
    memo: d.memo,
    execution: d.execution && {
      status: d.execution.status,
      txHash: d.execution.txHash,
      baseUsdt: round(usdt(d.execution.baseAmount)),
      realizedPnlUsdt: round(usdt(d.execution.realizedPnl), 4),
      gasUsed: d.execution.gasUsed?.toString(),
      error: d.execution.error,
    },
  };
}

/** Thins a series to at most `max` points, always keeping the newest. */
function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const step = points.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * The agent's state as plain JSON numbers and strings. The dashboard renders it and the
 * chat hands it to the model, so both always describe the same facts.
 */
export function publicState(state: EngineState) {
  const p = state.portfolio;
  const exposure = p?.positions.reduce((sum, pos) => sum + pos.value, 0n) ?? 0n;

  return {
    now: Date.now(),
    startedAt: state.startedAt,
    chainId: state.chainId,
    vault: state.vault,
    explorerUrl: config.explorerUrl,
    mode: state.mode,
    operator: state.operator,
    llm: state.llm,
    status: state.status,
    settings: state.settings,
    thresholds: thresholdsFor(state.settings.riskAppetite),
    portfolio: p && {
      blockNumber: p.blockNumber.toString(),
      blockTimestamp: p.blockTimestamp,
      owner: p.owner,
      agent: p.agent,
      navUsdt: round(usdt(p.nav)),
      idleUsdt: round(usdt(p.idleBase)),
      exposurePct: round(p.nav === 0n ? 0 : (Number(exposure) / Number(p.nav)) * 100, 1),
      performancePct: round((Number(p.pricePerShare) / 1e18 - 1) * 100, 3),
      pricePerShare: round(Number(p.pricePerShare) / 1e18, 6),
      highWaterMark: round(Number(p.highWaterMark) / 1e18, 6),
      drawdownBps: p.drawdownBps,
      halted: p.halted,
      buysToday: p.buysToday,
      lastBuyAt: p.lastBuyAt,
      policy: p.policy,
      effective: effectiveLimits(state.settings, p.policy),
      positions: p.positions.map((pos) => ({
        asset: pos.symbol,
        enabled: pos.enabled,
        balance: pos.balance.toString(),
        valueUsdt: round(usdt(pos.value)),
        costUsdt: round(usdt(pos.cost)),
        unrealizedBps: pos.balance === 0n ? undefined : round(unrealizedBps(pos), 0),
        lockedUntil: pos.lockedUntil,
        stopLossReached: pos.stopLossReached,
      })),
    },
    market: state.market && {
      takenAt: state.market.takenAt,
      blockNumber: state.market.blockNumber.toString(),
      gasPriceGwei: round(Number(state.market.gasPriceWei) / 1e9, 1),
      assets: state.market.assets.map((a) => ({
        asset: a.symbol,
        dexSpot: a.dexSpot,
        dexTwap: a.dexTwap,
        cexBid: a.cex?.bid,
        cexAsk: a.cex?.ask,
        cexMid: a.cex?.mid,
        cexSources: a.cex?.sources,
        cexDispersionBps: round(a.cex?.dispersionBps, 0),
        basisBps: round(a.basisBps, 1),
        trendBps: round(a.trend?.trendBps, 1),
        ret1hBps: round(a.trend?.ret1hBps, 1),
        vol1hBps: round(a.trend?.vol1hBps, 1),
        rsi14: round(a.trend?.rsi14, 0),
        oraclePrice: a.oracle?.price,
        oracleAgeHours: round(a.oracle ? a.oracle.ageSeconds / 3600 : undefined, 1),
      })),
    },
    decisions: state.decisions.slice(-60).reverse().map(decisionView),
    navHistory: thin(state.navHistory, 300),
  };
}

export type PublicState = ReturnType<typeof publicState>;
