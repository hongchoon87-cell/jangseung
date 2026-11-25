import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { ADDRESSES, config, NETWORK } from "./config.ts";

export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function token0() view returns (address)",
]);

export const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

export interface ChainClients {
  chain: Chain;
  /** Reads are batched through Multicall3. */
  publicClient: PublicClient;
  /** Reads go out one by one, for contracts that refuse calls coming from another contract. */
  directClient: PublicClient;
  walletClient?: WalletClient;
  account?: PrivateKeyAccount;
}

/** Connects to the RPC and builds a chain definition from the chain id it reports. */
export async function connect(): Promise<ChainClients> {
  const probe = createPublicClient({ transport: http(config.rpcUrl) });
  const chainId = await probe.getChainId();
  // A local fork keeps the id of the chain it forked, so this also holds for fork runs. It
  // stops testnet settings from being pointed at mainnet, and the other way round.
  if (chainId !== NETWORK.chainId) {
    throw new Error(`${config.rpcUrl} is chain ${chainId}, but HSK_NETWORK=${NETWORK.name} expects chain ${NETWORK.chainId}.`);
  }

  const chain = defineChain({
    id: chainId,
    name: NETWORK.label,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: config.explorerUrl } },
    contracts: { multicall3: { address: ADDRESSES.multicall3 } },
  });

  // The public RPC rate-limits bursts, so retry with backoff and batch through Multicall3.
  const transport = http(config.rpcUrl, { retryCount: 5, retryDelay: 800, timeout: 30_000 });
  const publicClient = createPublicClient({ chain, transport, batch: { multicall: { wait: 20 } } });
  const directClient = createPublicClient({ chain, transport });

  if (!config.agentKey) return { chain, publicClient, directClient };

  const account = privateKeyToAccount(config.agentKey);
  const walletClient = createWalletClient({ account, chain, transport });
  return { chain, publicClient, directClient, walletClient, account };
}
