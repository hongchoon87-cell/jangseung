import { ASSETS } from "../src/config.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { AssetMarket, MarketSnapshot, Policy, Portfolio, PositionState, Settings } from "../src/types.ts";

export const NOW = 1_795_600_000_000;
export const USDT = 1_000_000n;

export const policy: Policy = {
  maxTradeBps: 1000,
  maxPositionBps: 3000,
  maxExposureBps: 6000,
  maxSlippageBps: 100,
  stopLossBps: 500,
  maxDrawdownBps: 1000,
  maxTradesPerDay: 12,
  cooldown: 300,
  twapWindow: 300,
  reentryLockout: 3600,
};

export function position(symbol: "WHSK" | "WETH" | "WBTC", overrides: Partial<PositionState> = {}): PositionState {
  const info = ASSETS.find((a) => a.symbol === symbol)!;
  return {
    symbol,
    address: info.address,
    enabled: true,
    balance: 0n,
    value: 0n,
    cost: 0n,
    lockedUntil: 0,
    stopLossReached: false,
    ...overrides,
  };
}

/** A 1,000 USDT vault holding only USDT. */
export function portfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    vault: "0x0000000000000000000000000000000000000001",
    blockNumber: 1n,
    blockTimestamp: NOW / 1000,
    owner: "0x0000000000000000000000000000000000000002",
    agent: "0x0000000000000000000000000000000000000003",
    nav: 1_000n * USDT,
    idleBase: 1_000n * USDT,
    pricePerShare: 10n ** 18n,
    highWaterMark: 10n ** 18n,
    drawdownBps: 0,
    halted: false,
    buysToday: 0,
    lastBuyAt: 0,
    policy,
    positions: [position("WHSK"), position("WETH"), position("WBTC")],
    ...overrides,
  };
}

/** WHSK at 0.08 on both venues, flat trend, fresh quotes. */
export function whskMarket(overrides: Partial<AssetMarket> = {}): AssetMarket {
  return {
    symbol: "WHSK",
    dexSpot: 0.08,
    dexTwap: 0.08,
    poolLiquidity: 10n ** 18n,
    cex: { symbol: "HSK", bid: 0.0799, ask: 0.0801, mid: 0.08, spreadBps: 25, dispersionBps: 10, sources: ["gate", "kucoin", "mexc"], fetchedAt: NOW },
    trend: { trendBps: 0, ret1hBps: 0, vol1hBps: 60, rsi14: 50, asOf: NOW - 60_000 },
    basisBps: 0,
    ...overrides,
  };
}

export function snapshot(assets: AssetMarket[] = [whskMarket()]): MarketSnapshot {
  return {
    takenAt: NOW,
    blockNumber: 1n,
    blockTimestamp: NOW / 1000,
    gasPriceWei: 500_000_000_000n,
    assets,
    warnings: [],
  };
}

export function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}
