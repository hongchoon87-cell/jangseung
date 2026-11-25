/** Reads the vault policy from environment variables, with careful defaults for a small vault. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
    return value;
  };

  return {
    maxTradeBps: number("POLICY_MAX_TRADE_BPS", 1000), // one buy: at most 10% of NAV
    maxPositionBps: number("POLICY_MAX_POSITION_BPS", 3000), // one asset: at most 30% of NAV
    maxExposureBps: number("POLICY_MAX_EXPOSURE_BPS", 6000), // all assets: at most 60% of NAV
    maxSlippageBps: number("POLICY_MAX_SLIPPAGE_BPS", 100), // fill at most 1% worse than the TWAP
    stopLossBps: number("POLICY_STOP_LOSS_BPS", 500), // close a position 5% under its cost
    maxDrawdownBps: number("POLICY_MAX_DRAWDOWN_BPS", 1000), // halt buying 10% under the peak
    maxTradesPerDay: number("POLICY_MAX_TRADES_PER_DAY", 12),
    cooldown: number("POLICY_COOLDOWN_SECONDS", 300),
    twapWindow: number("POLICY_TWAP_WINDOW_SECONDS", 300),
    reentryLockout: number("POLICY_REENTRY_LOCKOUT_SECONDS", 3600),
  };
}
