import type { Address } from "viem";

import type { ChainClients } from "./chain.ts";
import { config } from "./config.ts";
import { executeTrade, runSafetyCall } from "./executor.ts";
import { chainQuoter, verify } from "./gate.ts";
import { collectMarket } from "./market.ts";
import { runTick, type Ports } from "./pipeline.ts";
import { readPools, readPortfolio } from "./portfolio.ts";
import { applySettings, DEFAULT_SETTINGS, type SettingsChange } from "./settings.ts";
import { appendLine, loadJson, readLines, saveJson } from "./store.ts";
import { judge } from "./strategist.ts";
import type { DecisionRecord, MarketSnapshot, Portfolio, Settings } from "./types.ts";

const MAX_DECISIONS = 200;
const MAX_NAV_POINTS = 2_000;
const POOL_REFRESH_MS = 10 * 60 * 1000;

export interface NavPoint {
  t: number;
  nav: number;
  pps: number;
}

export interface EngineState {
  startedAt: number;
  chainId: number;
  vault: Address;
  mode: "live" | "dry-run";
  operator?: Address;
  llm: { enabled: boolean; model: string };
  settings: Settings;
  portfolio?: Portfolio;
  market?: MarketSnapshot;
  decisions: DecisionRecord[];
  navHistory: NavPoint[];
  status: { ticks: number; lastTickAt?: number; lastTickMs?: number; lastError?: string; warnings: string[] };
}

export interface Engine {
  state: EngineState;
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  updateSettings(patch: Partial<Settings>): SettingsChange;
  onUpdate(listener: () => void): () => void;
}

export function createEngine(clients: ChainClients, vault: Address): Engine {
  const state: EngineState = {
    startedAt: Date.now(),
    chainId: clients.chain.id,
    vault,
    mode: config.dryRun ? "dry-run" : "live",
    operator: clients.account?.address,
    llm: { enabled: config.llm.enabled, model: config.llm.model },
    settings: { ...DEFAULT_SETTINGS, ...loadJson<Partial<Settings>>("settings.json", {}) },
    decisions: readLines<DecisionRecord>("decisions.jsonl", MAX_DECISIONS),
    navHistory: readLines<NavPoint>("nav.jsonl", MAX_NAV_POINTS),
    status: { ticks: 0, warnings: [] },
  };

  const listeners = new Set<() => void>();
  const quiet = new Map<string, { at: number; reason: string }>();
  const quoter = chainQuoter(clients.publicClient);
  let pools: Map<string, Address> | undefined;
  let poolsReadAt = 0;
  /** The account trades are simulated and sent from; known once the vault has been read. */
  let operator: Address | undefined;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const notify = () => listeners.forEach((listener) => listener());

  function record(decision: DecisionRecord): void {
    state.decisions.push(decision);
    if (state.decisions.length > MAX_DECISIONS) state.decisions.shift();
    appendLine("decisions.jsonl", decision);
  }

  /** The pipeline's view of the outside world, wired to the chain, the exchanges and Claude. */
  const ports: Ports = {
    async readPortfolio() {
      const portfolio = await readPortfolio(clients.publicClient, vault);
      operator = clients.account?.address ?? portfolio.agent;
      return portfolio;
    },
    async collectMarket(twapWindow) {
      if (!pools || Date.now() - poolsReadAt > POOL_REFRESH_MS) {
        pools = await readPools(clients.publicClient, vault);
        poolsReadAt = Date.now();
      }
      return collectMarket(clients, pools, twapWindow);
    },
    verify: (candidate, context) => verify(candidate, { ...context, quoter }),
    judge,
    executeTrade: (candidate, amountIn, gate, memo) => executeTrade(clients, vault, operator!, candidate, amountIn, gate, memo),
    runSafetyCall: (call) => runSafetyCall(clients, vault, operator!, call),
  };

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const { portfolio, snapshot } = await runTick(ports, state.settings, { quiet, decisions: state.decisions }, record);

      const warnings = [...snapshot.warnings];
      if (clients.account && clients.account.address !== portfolio.agent && clients.account.address !== portfolio.owner) {
        warnings.push("The configured key is neither the vault's agent nor its owner, so its trades will be rejected.");
      }

      state.portfolio = portfolio;
      state.market = snapshot;
      state.status.warnings = warnings;
      state.status.lastError = undefined;

      const point: NavPoint = { t: started, nav: Number(portfolio.nav) / 1e6, pps: Number(portfolio.pricePerShare) / 1e18 };
      state.navHistory.push(point);
      if (state.navHistory.length > MAX_NAV_POINTS) state.navHistory.shift();
      appendLine("nav.jsonl", point);
    } catch (error) {
      state.status.lastError = (error as Error).message.split("\n")[0];
      console.error(`[tick] ${state.status.lastError}`);
    } finally {
      state.status.ticks += 1;
      state.status.lastTickAt = Date.now();
      state.status.lastTickMs = Date.now() - started;
      running = false;
      notify();
    }
  }

  return {
    state,
    tick,
    start() {
      void tick();
      timer = setInterval(() => void tick(), config.tickSeconds * 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    updateSettings(patch) {
      if (!state.portfolio) throw new Error("The vault has not been read yet; try again in a moment.");
      const change = applySettings(state.settings, patch, state.portfolio.policy);
      state.settings = change.settings;
      saveJson("settings.json", change.settings);
      notify();
      return change;
    },
    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
