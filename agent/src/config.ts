import { getAddress, isAddress, type Address, type Hex } from "viem";

import { NETWORKS, type NetworkInfo } from "./networks.ts";

// Load the env file if present (ENV_FILE picks another one, e.g. .env.fork). Variables
// already set in the environment win.
try {
  process.loadEnvFile(process.env.ENV_FILE ?? ".env");
} catch {
  // No env file: rely on the process environment.
}

const env = process.env;

export type AssetSymbol = "WHSK" | "WETH" | "WBTC";

export interface AssetInfo {
  symbol: AssetSymbol;
  address: Address;
  decimals: number;
  /** HSKSwap pool fee tier, in hundredths of a bip. */
  fee: number;
  /** Ticker of the asset on centralised exchanges, quoted there against USDT. */
  ticker: string;
  /** APRO price feed (Chainlink-compatible), when one exists. */
  oracle?: Address;
}

/** The network named by HSK_NETWORK. Mainnet when it is not set. */
export function networkFromEnv(source: NodeJS.ProcessEnv): NetworkInfo {
  const name = source.HSK_NETWORK || "mainnet";
  if (name !== "mainnet" && name !== "testnet") throw new Error(`HSK_NETWORK must be "mainnet" or "testnet", got "${name}"`);
  return NETWORKS[name];
}

/** HSK Chain mainnet tokens. Verified on-chain and against the HSKSwap app bundle. */
const MAINNET_USDT = getAddress("0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029");

const MAINNET_ASSETS: readonly AssetInfo[] = [
  {
    symbol: "WHSK",
    address: getAddress("0xB210D2120d57b758EE163cFfb43e73728c471Cf1"),
    decimals: 18,
    fee: 3000,
    ticker: "HSK",
    oracle: getAddress("0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b"),
  },
  {
    symbol: "WETH",
    address: getAddress("0xefd4bC9afD210517803f293ABABd701CaeeCdfd0"),
    decimals: 18,
    fee: 3000,
    ticker: "ETH",
  },
  {
    symbol: "WBTC",
    address: getAddress("0x6119CA49a79f5825C8B345F8d7aC36B272565b14"),
    decimals: 8,
    fee: 3000,
    ticker: "BTC",
    oracle: getAddress("0x204ED500ab56A2E19B051561258E3A45c850360F"),
  },
];

/**
 * The tokens traded on a network. Mainnet has the real ones. The testnet pools of HSKSwap
 * trade at prices unrelated to the market, so the testnet demo uses two valueless tokens of
 * its own in a pool that follows the mainnet price. "npm run testnet:market" deploys them
 * and writes their addresses to .env.testnet. They keep the decimals of the real tokens.
 */
export function tokensFromEnv(network: NetworkInfo, source: NodeJS.ProcessEnv): { usdt: Address; assets: readonly AssetInfo[] } {
  if (network.name === "mainnet") return { usdt: MAINNET_USDT, assets: MAINNET_ASSETS };

  const token = (key: string): Address => {
    const raw = source[key];
    if (!raw || !isAddress(raw)) {
      throw new Error(`${key} is not set. "npm run testnet:market" deploys the test tokens and writes their addresses to .env.testnet.`);
    }
    return getAddress(raw);
  };
  return {
    usdt: token("TEST_USDT_ADDRESS"),
    assets: [{ symbol: "WHSK", address: token("TEST_WHSK_ADDRESS"), decimals: 18, fee: 3000, ticker: "HSK" }],
  };
}

export const NETWORK = networkFromEnv(env);
const tokens = tokensFromEnv(NETWORK, env);

export const ADDRESSES = {
  usdt: tokens.usdt,
  factory: NETWORK.factory,
  router: NETWORK.router,
  quoter: NETWORK.quoter,
  multicall3: NETWORK.multicall3,
} as const;

export const BASE = { symbol: "USDT", address: ADDRESSES.usdt, decimals: 6 } as const;

export const ASSETS: readonly AssetInfo[] = tokens.assets;

export function assetBySymbol(symbol: string): AssetInfo | undefined {
  return ASSETS.find((a) => a.symbol === symbol);
}

export function assetByAddress(address: string): AssetInfo | undefined {
  const lower = address.toLowerCase();
  return ASSETS.find((a) => a.address.toLowerCase() === lower);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

type LlmMode = "auto" | "on" | "off";

function llmEnabled(): boolean {
  const mode = (env.LLM_MODE ?? "auto") as LlmMode;
  if (mode === "off") return false;
  if (mode === "on") return true;
  // The SDK also reads stored login profiles; "auto" only checks the explicit variables.
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}

const agentKey = env.AGENT_PRIVATE_KEY as Hex | undefined;

/** A gas price in gwei to assume instead of the chain's own, as wei. */
function assumedGasPrice(): bigint | undefined {
  const gwei = numberFromEnv("ASSUME_GAS_PRICE_GWEI", 0);
  if (gwei < 0) throw new Error(`ASSUME_GAS_PRICE_GWEI must not be negative, got ${gwei}`);
  return gwei > 0 ? BigInt(Math.round(gwei * 1e9)) : undefined;
}

export const config = {
  rpcUrl: env.HSK_RPC_URL || NETWORK.rpcUrl,
  explorerUrl: env.EXPLORER_URL || NETWORK.explorerUrl,
  vault: env.VAULT_ADDRESS ? getAddress(env.VAULT_ADDRESS) : undefined,
  agentKey,
  /** Without a key, or with DRY_RUN=1, the agent decides but never sends a transaction. */
  dryRun: env.DRY_RUN === "1" || !agentKey,
  tickSeconds: numberFromEnv("TICK_SECONDS", 30),
  port: numberFromEnv("PORT", 8787),
  dataDir: env.DATA_DIR ?? "data",
  cexBaseUrl: env.CEX_BASE_URL ?? "https://api-glb.hashkey.com",
  /**
   * A local fork keeps the block time of the forked block, so chain data looks old next
   * to live exchange prices. Set ALLOW_STALE_CHAIN=1 only for fork demos.
   */
  allowStaleChain: env.ALLOW_STALE_CHAIN === "1",
  /**
   * Gas on the testnet costs 1 gwei where mainnet costs 500. With ASSUME_GAS_PRICE_GWEI set,
   * the agent weighs trades as if gas cost that much, so a testnet run decides the way a
   * mainnet run would. Transactions still pay the chain's real price.
   */
  assumedGasPriceWei: assumedGasPrice(),
  llm: {
    enabled: llmEnabled(),
    model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    effort: (env.LLM_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",
    /** After this long the decision falls back to the rule-based path. */
    timeoutMs: numberFromEnv("LLM_TIMEOUT_MS", 40_000),
  },
} as const;

export type Config = typeof config;
