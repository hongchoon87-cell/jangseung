// The market key's view of the testnet demo pool, for the scripts that move its price:
// the keeper, which follows mainnet, and the mover, which stages a rise or a fall.
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ADDRESSES, ASSETS, BASE, config, NETWORK } from "../../agent/src/config.ts";
import { MAINNET_WHSK_POOL, NETWORKS } from "../../agent/src/networks.ts";
import { demoPoolAbi, factoryAbi, POOL_FEE, swapRouterAbi, testTokenAbi, usdtPerWhsk } from "./testnet.ts";
import { retry } from "./tx.ts";

/** Below these the market key mints itself more test tokens before it trades. */
const LOW_WHSK = 2_000_000n * 10n ** 18n;
const LOW_USDT = 200_000n * 10n ** 6n;
const REFILL_WHSK = 50_000_000n * 10n ** 18n;
const REFILL_USDT = 5_000_000n * 10n ** 6n;

export type DemoMarket = Awaited<ReturnType<typeof connectDemoMarket>>;

/** Connects as the market key. Refuses anything but the testnet, where the tokens are worthless. */
export async function connectDemoMarket() {
  if (NETWORK.name !== "testnet") throw new Error("The demo market exists on the HSK Chain testnet only. Run this with the testnet settings.");
  const key = process.env.TESTNET_MARKET_KEY as Hex | undefined;
  if (!key) throw new Error('TESTNET_MARKET_KEY is not set. "npm run testnet:keys" creates it in .env.testnet.');

  const transport = http(config.rpcUrl, { retryCount: 5, retryDelay: 800, timeout: 30_000 });
  const chainId = await retry(() => createPublicClient({ transport }).getChainId());
  if (chainId !== NETWORK.chainId) throw new Error(`${config.rpcUrl} is chain ${chainId}, not ${NETWORK.label} (${NETWORK.chainId}).`);
  const chain = defineChain({
    id: chainId,
    name: NETWORK.label,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const whsk = ASSETS.find((asset) => asset.symbol === "WHSK")!.address;
  const usdt = BASE.address;
  const pool = getAddress(await retry(() => publicClient.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: "getPool", args: [whsk, usdt, POOL_FEE] })));
  if (BigInt(pool) === 0n) throw new Error('The demo pool does not exist yet. Run "npm run testnet:market" first.');
  // Every price below is read as USDT per WHSK with WHSK as token0, the order the mainnet pool has.
  const token0 = await retry(() => publicClient.readContract({ address: pool, abi: demoPoolAbi, functionName: "token0" }));
  if (getAddress(token0) !== whsk) throw new Error("The demo pool's token0 is not the test WHSK.");

  const mainnet = createPublicClient({
    transport: http(process.env.MAINNET_RPC_URL || NETWORKS.mainnet.rpcUrl, { retryCount: 5, retryDelay: 800, timeout: 20_000 }),
  });

  return { publicClient, walletClient, account, mainnet, pool, whsk, usdt, isLocal: /\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.rpcUrl) };
}

/** The demo pool's price as the pool stores it. */
export async function demoSqrtPrice(market: DemoMarket): Promise<bigint> {
  const slot0 = await retry(() => market.publicClient.readContract({ address: market.pool, abi: demoPoolAbi, functionName: "slot0" }));
  return slot0[0];
}

/** Price and in-range liquidity of the real WHSK/USDT pool on mainnet. */
export async function mainnetPool(market: DemoMarket): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> {
  const [slot0, liquidity] = await Promise.all([
    retry(() => market.mainnet.readContract({ address: MAINNET_WHSK_POOL, abi: demoPoolAbi, functionName: "slot0" })),
    retry(() => market.mainnet.readContract({ address: MAINNET_WHSK_POOL, abi: demoPoolAbi, functionName: "liquidity" })),
  ]);
  return { sqrtPriceX96: slot0[0], liquidity };
}

export interface Move {
  from: number;
  to: number;
  txHash: Hex;
  gasUsed: bigint;
}

/**
 * Trades on the demo pool until its price is `target`. The swap carries `target` as its
 * price limit, so the pool stops there and takes only as many tokens as that needs.
 * Returns undefined when the pool is already at the target.
 */
export async function moveTo(market: DemoMarket, target: bigint): Promise<Move | undefined> {
  const { publicClient, walletClient, account, pool, whsk, usdt } = market;
  const current = await demoSqrtPrice(market);
  if (current === target) return undefined;

  // The pool's price is USDT per WHSK. To lower it, sell WHSK; to raise it, sell USDT.
  const selling = target < current ? { token: whsk, low: LOW_WHSK, refill: REFILL_WHSK } : { token: usdt, low: LOW_USDT, refill: REFILL_USDT };
  const buying: Address = target < current ? usdt : whsk;
  const balanceOf = () => retry(() => publicClient.readContract({ address: selling.token, abi: testTokenAbi, functionName: "balanceOf", args: [account.address] }));

  let balance = await balanceOf();
  if (balance < selling.low) {
    const hash = await walletClient.writeContract({ address: selling.token, abi: testTokenAbi, functionName: "mint", args: [account.address, selling.refill] });
    await retry(() => publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }));
    balance = await balanceOf();
  }

  const { request } = await publicClient.simulateContract({
    account,
    address: ADDRESSES.router,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [{ tokenIn: selling.token, tokenOut: buying, fee: POOL_FEE, recipient: account.address, amountIn: balance, amountOutMinimum: 0n, sqrtPriceLimitX96: target }],
  });
  const txHash = await walletClient.writeContract(request);
  const receipt = await retry(() => publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 }));
  if (receipt.status !== "success") throw new Error(`the swap ${txHash} reverted`);

  // Read back rather than assume: the agent may have traded in the same block.
  return { from: usdtPerWhsk(current), to: usdtPerWhsk(await demoSqrtPrice(market)), txHash, gasUsed: receipt.gasUsed };
}
