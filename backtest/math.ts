// Integer maths of a Uniswap V3 pool and of the vault's TwapLib, ported line for line so
// the backtest gets the same wei the chain would. Sources: @uniswap/v3-core TickMath,
// SqrtPriceMath and SwapMath, and contracts/libraries/TwapLib.sol. The tests check these
// against numbers measured on a mainnet fork and against the pool's own swap history.

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const Q192 = 1n << 192n;
const MAX_UINT128 = Q128 - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_TICK = 887_272;

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  return product / denominator + (product % denominator === 0n ? 0n : 1n);
}

function divRoundingUp(a: bigint, b: bigint): bigint {
  return a / b + (a % b === 0n ? 0n : 1n);
}

const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** TickMath.getSqrtRatioAtTick: sqrt(1.0001^tick) as a Q64.96 number. */
export function sqrtRatioAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (!Number.isInteger(tick) || absTick > MAX_TICK) throw new Error(`tick ${tick} out of range`);

  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  for (const [bit, factor] of TICK_FACTORS) {
    if ((absTick & bit) !== 0) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** TickMath.getTickAtSqrtRatio: the greatest tick whose price is not above `sqrtPriceX96`. */
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  // A floating-point estimate, then corrected against the exact tick prices on either side.
  let tick = Math.floor((2 * Math.log(Number(sqrtPriceX96) / 2 ** 96)) / Math.log(1.0001));
  while (sqrtRatioAtTick(tick) > sqrtPriceX96) tick -= 1;
  while (sqrtRatioAtTick(tick + 1) <= sqrtPriceX96) tick += 1;
  return tick;
}

/**
 * TwapLib.quoteAtTick: what `amountIn` is worth at `tick`, before fees.
 * @param zeroForOne true when the input is the pool's token0 (the asset, in every pool used here).
 */
export function quoteAtTick(tick: number, amountIn: bigint, zeroForOne: boolean): bigint {
  const sqrtRatio = sqrtRatioAtTick(tick);
  if (sqrtRatio <= MAX_UINT128) {
    const ratioX192 = sqrtRatio * sqrtRatio;
    return zeroForOne ? mulDiv(ratioX192, amountIn, Q192) : mulDiv(Q192, amountIn, ratioX192);
  }
  const ratioX128 = mulDiv(sqrtRatio, sqrtRatio, 1n << 64n);
  return zeroForOne ? mulDiv(ratioX128, amountIn, Q128) : mulDiv(Q128, amountIn, ratioX128);
}

/** Arithmetic mean of two cumulative tick readings `window` seconds apart, rounded toward minus infinity. */
export function meanTickOf(cumulativeThen: bigint, cumulativeNow: bigint, window: number): number {
  const delta = cumulativeNow - cumulativeThen;
  const span = BigInt(window);
  let tick = delta / span;
  if (delta < 0n && delta % span !== 0n) tick -= 1n;
  return Number(tick);
}

function nextSqrtPriceFromAmount0RoundingUp(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  const numerator = liquidity << 96n;
  const product = amount * sqrtPrice;
  // Solidity takes the precise path only when neither step overflows 256 bits.
  if (product <= MAX_UINT256 && numerator + product <= MAX_UINT256) {
    return mulDivRoundingUp(numerator, sqrtPrice, numerator + product);
  }
  return divRoundingUp(numerator, numerator / sqrtPrice + amount);
}

const MIN_SQRT_RATIO = 4295128739n;

/**
 * TwapLib.maxInputAboveFloor: the most one exact-input swap can sell while its output
 * stays at or above `keepBps` of what the input is worth at `referenceTick`. Same steps
 * and same rounding as the contract, so the simulated vault sizes a stop-loss sale to the
 * same wei.
 * @param zeroForOne true when the token sold is the pool's token0.
 */
export function maxInputAboveFloor(
  sqrtPrice: bigint,
  liquidity: bigint,
  referenceTick: number,
  zeroForOne: boolean,
  feePips: number,
  keepBps: bigint,
): bigint {
  if (liquidity === 0n) return 0n;
  let sqrtRef = sqrtRatioAtTick(referenceTick);
  const keep = keepBps * 1_000_000n;
  const afterFee = 10_000n * BigInt(1_000_000 - feePips);
  let net: bigint;

  if (zeroForOne) {
    if (sqrtRef >= sqrtPrice * 2n) return 0n;
    let sqrtMin = mulDivRoundingUp(mulDivRoundingUp(sqrtRef, sqrtRef, sqrtPrice), keep, afterFee);
    if (sqrtMin >= sqrtPrice) return 0n;
    if (sqrtMin < MIN_SQRT_RATIO) sqrtMin = MIN_SQRT_RATIO;
    net = mulDiv(liquidity << 96n, sqrtPrice - sqrtMin, sqrtPrice) / sqrtMin;
  } else {
    if (sqrtRef > sqrtPrice * 2n) sqrtRef = sqrtPrice * 2n;
    const sqrtMax = mulDiv(mulDiv(sqrtRef, sqrtRef, sqrtPrice), afterFee, keep);
    if (sqrtMax <= sqrtPrice) return 0n;
    net = mulDiv(liquidity, sqrtMax - sqrtPrice, Q96);
  }
  return mulDiv(net, 1_000_000n, BigInt(1_000_000 - feePips));
}

/** SqrtPriceMath.getAmount0Delta: token0 between two prices at constant liquidity. */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [low, high] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  const numerator = liquidity << 96n;
  return roundUp ? divRoundingUp(mulDivRoundingUp(numerator, high - low, high), low) : mulDiv(numerator, high - low, high) / low;
}

/** SqrtPriceMath.getAmount1Delta: token1 between two prices at constant liquidity. */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [low, high] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  return roundUp ? mulDivRoundingUp(liquidity, high - low, Q96) : mulDiv(liquidity, high - low, Q96);
}

/** Fee the pool adds on top of a net input when the swap was specified by its output or stopped at a price limit. */
export function feeOnNetInput(netInput: bigint, feePips: number): bigint {
  return mulDivRoundingUp(netInput, BigInt(feePips), BigInt(1_000_000 - feePips));
}

export interface SwapResult {
  amountOut: bigint;
  sqrtPriceAfter: bigint;
  /** Input kept by the pool as its fee. */
  feeAmount: bigint;
}

/**
 * SwapMath.computeSwapStep for an exact-input swap that stays inside the current
 * liquidity range. A swap large enough to cross an initialised tick would meet a different
 * liquidity past it; the backtest's trades are far too small for that (see the checks).
 * @param zeroForOne true to sell token0 for token1 (price falls), false for the reverse.
 * @param feePips pool fee in hundredths of a bip, e.g. 3000 for 0.3%.
 */
export function swapExactInput(
  sqrtPrice: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
  feePips: number,
): SwapResult {
  if (liquidity <= 0n) throw new Error("the pool has no liquidity in range");
  if (amountIn <= 0n) return { amountOut: 0n, sqrtPriceAfter: sqrtPrice, feeAmount: 0n };

  const amountLessFee = mulDiv(amountIn, BigInt(1_000_000 - feePips), 1_000_000n);
  // What the curve takes is rounded up and what it pays is rounded down; the rest of the input is the fee.
  if (zeroForOne) {
    const next = nextSqrtPriceFromAmount0RoundingUp(sqrtPrice, liquidity, amountLessFee);
    return {
      amountOut: amount1Delta(next, sqrtPrice, liquidity, false),
      sqrtPriceAfter: next,
      feeAmount: amountIn - amount0Delta(next, sqrtPrice, liquidity, true),
    };
  }
  const next = sqrtPrice + (amountLessFee << 96n) / liquidity;
  return {
    amountOut: amount0Delta(sqrtPrice, next, liquidity, false),
    sqrtPriceAfter: next,
    feeAmount: amountIn - amount1Delta(sqrtPrice, next, liquidity, true),
  };
}
