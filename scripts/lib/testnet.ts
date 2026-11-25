// Shared pieces of the testnet demo scripts.
//
// The testnet pools of HSKSwap trade at prices unrelated to the real market (WHSK cost 54
// test USDT in one and 78 in another on 2026-11-25, against 0.08 USDT on mainnet), so the
// agent's price checks cannot be tried on them. The demo therefore runs on two valueless
// tokens of its own, in a pool on the official testnet HSKSwap contracts that follows the
// price of the real WHSK/USDT pool on mainnet.
import { existsSync } from "node:fs";

import { parseAbi } from "viem";

/** Env file of the real testnet. Its keys are for the testnet only. */
export const TESTNET_ENV = ".env.testnet";
/** Env file of a local fork of the testnet, for rehearsals. */
export const TESTNET_FORK_ENV = ".env.testnet-fork";

/**
 * Hardhat's well-known test keys #1 and #2, which a local node funds. They are public:
 * never fund them on a real network.
 */
export const LOCAL_AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const LOCAL_MARKET_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

/** Constructor arguments of the two test tokens: name, symbol, decimals. */
export const TEST_TOKENS = {
  whsk: ["Test WHSK (AgentVault demo)", "tWHSK", 18],
  usdt: ["Test USDT (AgentVault demo)", "tUSDT", 6],
} as const;
export type TestTokenKind = keyof typeof TEST_TOKENS;

/** Fee tier and tick spacing of the demo pool, the same as the mainnet WHSK/USDT pool. */
export const POOL_FEE = 3000;
export const TICK_SPACING = 60;
/** The widest range a pool with this tick spacing allows. */
export const FULL_RANGE = { tickLower: -887_220, tickUpper: 887_220 } as const;

/** Loads `file` into the environment when it exists. Variables already set win. */
export function loadEnv(file: string): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export const testTokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function owner() view returns (address)",
  "function decimals() view returns (uint8)",
]);

export const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
]);

export const demoPoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function initialize(uint160 sqrtPriceX96)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

export const positionManagerAbi = parseAbi([
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

export const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/** USDT per WHSK for a pool price, when WHSK (18 decimals) is token0 and USDT (6 decimals) token1. */
export function usdtPerWhsk(sqrtPriceX96: bigint): number {
  return (Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** 30n) / (1n << 192n)) / 1e30) * 1e12;
}
