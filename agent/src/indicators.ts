/** Exponential moving average of the whole series, seeded with the first value. */
export function ema(values: readonly number[], period: number): number {
  if (values.length === 0) throw new Error("ema needs at least one value");
  const k = 2 / (period + 1);
  let result = values[0]!;
  for (let i = 1; i < values.length; i++) result = values[i]! * k + result * (1 - k);
  return result;
}

/** Wilder's RSI over the last `period` changes. Returns 50 when there is too little data. */
export function rsi(values: readonly number[], period = 14): number {
  if (values.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Standard deviation of log returns, scaled to `barsPerHorizon` bars, in bps. */
export function realizedVolBps(values: readonly number[], barsPerHorizon: number): number {
  if (values.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) returns.push(Math.log(values[i]! / values[i - 1]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * barsPerHorizon) * 10_000;
}

/** Relative difference of `a` over `b`, in bps. */
export function bps(a: number, b: number): number {
  return (a / b - 1) * 10_000;
}
