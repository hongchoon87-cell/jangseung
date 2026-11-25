// Sets up the testnet demo market: two valueless tokens and a pool on the official testnet
// HSKSwap that starts at the price and depth of the real WHSK/USDT pool on mainnet.
//
//   npm run testnet:market          HSK Chain testnet, keys from .env.testnet (npm run testnet:keys)
//   npm run testnet:fork:market     a local fork of the testnet (npm run testnet:fork)
//
// Safe to run again after an interruption: every step first looks at what is on-chain.
// Why a market of our own: see scripts/lib/testnet.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import hre, { network } from "hardhat";
import { createPublicClient, formatEther, formatUnits, getAddress, getContractAddress, http, isAddress, maxUint256, parseEther, parseUnits, type Address } from "viem";

import { MAINNET_WHSK_POOL, NETWORKS } from "../agent/src/networks.ts";
import { amount0Delta, amount1Delta, sqrtRatioAtTick } from "../backtest/math.ts";
import { setEnvValue } from "./lib/env-file.ts";
import { policyFromEnv } from "./lib/policy.ts";
import {
  demoPoolAbi,
  factoryAbi,
  FULL_RANGE,
  loadEnv,
  LOCAL_AGENT_KEY,
  LOCAL_MARKET_KEY,
  POOL_FEE,
  positionManagerAbi,
  TEST_TOKENS,
  TESTNET_ENV,
  TESTNET_FORK_ENV,
  testTokenAbi,
  usdtPerWhsk,
  type TestTokenKind,
} from "./lib/testnet.ts";
import { ensure, retry } from "./lib/tx.ts";

const isLocal = hre.globalOptions.network === "localhost";
if (!isLocal && hre.globalOptions.network !== "hskTestnet") {
  throw new Error('Run this with "--network hskTestnet" or, for a rehearsal, "--network localhost".');
}
const envFile = isLocal ? TESTNET_FORK_ENV : TESTNET_ENV;
// The testnet keys are read from this file when the connection is made.
loadEnv(envFile);

const testnet = NETWORKS.testnet;
// The faucet's button says 1 HSK, but one request brought 0.1 (2026-11-25), so the amounts
// below are sized to fit in that. At the testnet's 1 gwei the owner needs about 0.005 HSK
// to deploy and list, and a trade by the agent costs about 0.0003.
/** Gas each of the other two keys should hold, and what the market key sends when one is short. */
const MIN_GAS = parseEther("0.01");
const TOP_UP = parseEther("0.02");
/** What the market key keeps for its own transactions: setting the market up takes about 0.011 HSK. */
const MARKET_RESERVE = parseEther("0.03");
/** Test tokens the market key holds beyond the pool's liquidity, to move the price with. */
const WHSK_SUPPLY = parseEther("100000000");
const USDT_SUPPLY = parseUnits("10000000", 6);

const connection = await network.create();
const { viem } = connection;
// Building a client asks the node for its chain id, and the public RPC drops a connection now and then.
const publicClient = await retry(() => viem.getPublicClient());
const wallets = await retry(() => viem.getWalletClients());

const chainId = await retry(() => publicClient.getChainId());
if (chainId !== testnet.chainId) throw new Error(`This is chain ${chainId}. The demo market belongs on the HSK Chain testnet (${testnet.chainId}) only.`);

// A local node offers its test accounts: owner, agent, market. The testnet has the owner
// and market keys of .env.testnet, and the agent only as an address.
const market = isLocal ? wallets[2] : wallets[1];
const ownerWallet = wallets[0];
if (!market || !ownerWallet) throw new Error(`The accounts for this network are missing. Run "npm run testnet:keys" first.`);
const marketAddress = getAddress(market.account.address);
const ownerAddress = getAddress(ownerWallet.account.address);
const agentRaw = isLocal ? wallets[1]?.account.address : process.env.AGENT_ADDRESS;
if (!agentRaw || !isAddress(agentRaw)) throw new Error(`AGENT_ADDRESS is missing from ${envFile}. Run "npm run testnet:keys" first.`);
const agentAddress = getAddress(agentRaw);

mkdirSync("deployments", { recursive: true });
const stateFile = `deployments/${isLocal ? "testnet-fork" : chainId}-market.json`;
interface MarketState {
  chainId: number;
  market: Address;
  whsk?: Address;
  usdt?: Address;
  pool?: Address;
  seeded?: { sqrtPriceX96: string; liquidity: string; usdtPerWhsk: number; mainnetBlock: string };
  oracleSlots?: number;
  updatedAt?: string;
}
const saved: MarketState | undefined = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as MarketState) : undefined;
if (saved && saved.market !== marketAddress) {
  throw new Error(`${stateFile} records a market run by ${saved.market}, not ${marketAddress}. Move that file away to start a new one.`);
}
const state: MarketState = saved ?? { chainId, market: marketAddress };
const save = () => writeFileSync(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");

const hasCode = async (address: Address) => {
  const code = await retry(() => publicClient.getCode({ address }));
  return code !== undefined && code !== "0x";
};
const balanceOf = (token: Address, holder: Address) => retry(() => publicClient.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [holder] }));
const allowance = (token: Address, spender: Address) =>
  retry(() => publicClient.readContract({ address: token, abi: testTokenAbi, functionName: "allowance", args: [marketAddress, spender] }));

console.log(`Demo market on chain ${chainId}${isLocal ? " (local fork)" : ""}`);
console.log(`  market  ${marketAddress}`);
console.log(`  owner   ${ownerAddress}`);
console.log(`  agent   ${agentAddress}`);

// ------------------------------------------------------------------- gas

if (!isLocal) {
  const [marketBalance, ownerBalance, agentBalance] = await Promise.all(
    [marketAddress, ownerAddress, agentAddress].map((address) => retry(() => publicClient.getBalance({ address }))),
  );
  const short = [
    { label: "owner", address: ownerAddress, balance: ownerBalance! },
    { label: "agent", address: agentAddress, balance: agentBalance! },
  ].filter((account) => account.balance < MIN_GAS);
  const needed = MARKET_RESERVE + TOP_UP * BigInt(short.length);
  if (marketBalance! < needed) {
    throw new Error(
      `The market address holds ${formatEther(marketBalance!)} test HSK and this needs ${formatEther(needed)}. ` +
        `Request test HSK for ${marketAddress} at https://faucet.hskchain.net/faucet and run this again.`,
    );
  }
  for (const account of short) {
    await ensure(
      publicClient,
      `send ${formatEther(TOP_UP)} test HSK to the ${account.label} for gas`,
      async () => (await publicClient.getBalance({ address: account.address })) >= MIN_GAS,
      () => market.sendTransaction({ to: account.address, value: TOP_UP }),
    );
  }
}

// ------------------------------------------------- the mainnet pool to copy

const mainnet = createPublicClient({
  transport: http(process.env.MAINNET_RPC_URL || NETWORKS.mainnet.rpcUrl, { retryCount: 8, retryDelay: 800, timeout: 20_000 }),
});
if ((await retry(() => mainnet.getChainId())) !== NETWORKS.mainnet.chainId) throw new Error("MAINNET_RPC_URL does not lead to HSK Chain mainnet.");
const [mainSlot0, mainLiquidity, mainBlock] = await Promise.all([
  retry(() => mainnet.readContract({ address: MAINNET_WHSK_POOL, abi: demoPoolAbi, functionName: "slot0" })),
  retry(() => mainnet.readContract({ address: MAINNET_WHSK_POOL, abi: demoPoolAbi, functionName: "liquidity" })),
  retry(() => mainnet.getBlockNumber()),
]);
const mainSqrtPrice = mainSlot0[0];
console.log(
  `  mainnet pool at block ${mainBlock}: ${usdtPerWhsk(mainSqrtPrice).toFixed(6)} USDT per WHSK, ` +
    `about ${Math.round(Number((mainLiquidity * mainSqrtPrice) >> 96n) / 1e6).toLocaleString("en-US")} USDT a side`,
);

// ---------------------------------------------------------------- tokens

const TOKENS = TEST_TOKENS;
type TokenKind = TestTokenKind;

const pendingNonce = async () => BigInt(await retry(() => publicClient.getTransactionCount({ address: marketAddress, blockTag: "pending" })));
/** A contract created by an account at a nonce can only be at one address, known beforehand. */
const addressAt = (nonce: bigint) => getContractAddress({ from: marketAddress, nonce });

async function deployToken(kind: TokenKind): Promise<Address> {
  const [name, symbol, decimals] = TOKENS[kind];
  const expected = addressAt(await pendingNonce());
  await ensure(
    publicClient,
    `deploy ${symbol}`,
    () => hasCode(expected),
    async () => (await viem.sendDeploymentTransaction("TestToken", [name, symbol, decimals], { client: { wallet: market } })).deploymentTransaction.hash,
  );
  state[kind] = expected;
  save();
  return expected;
}

// On mainnet WHSK is token0 of the pool, which means its address is the lower of the two.
// Keeping that order makes the demo pool's price the very number the mainnet pool reports.
// The two addresses are known before anything is deployed, so the lower one is given to WHSK.
const exists = { whsk: state.whsk !== undefined && (await hasCode(state.whsk)), usdt: state.usdt !== undefined && (await hasCode(state.usdt)) };
if (!(exists.whsk && exists.usdt)) {
  const next = addressAt(await pendingNonce());
  if (exists.whsk && BigInt(next) > BigInt(state.whsk!)) {
    await deployToken("usdt");
  } else if (exists.usdt && BigInt(next) < BigInt(state.usdt!)) {
    await deployToken("whsk");
  } else {
    const after = addressAt((await pendingNonce()) + 1n);
    const order: TokenKind[] = BigInt(next) < BigInt(after) ? ["whsk", "usdt"] : ["usdt", "whsk"];
    delete state.whsk;
    delete state.usdt;
    for (const kind of order) await deployToken(kind);
  }
}
const whsk = state.whsk!;
const usdt = state.usdt!;
if (BigInt(whsk) >= BigInt(usdt)) throw new Error(`The test WHSK ${whsk} does not sort below the test USDT ${usdt}. Move ${stateFile} away and run this again.`);
console.log(`  test WHSK ${whsk}`);
console.log(`  test USDT ${usdt}`);

// ------------------------------------------------------------------ pool

const getPool = () => retry(() => publicClient.readContract({ address: testnet.factory, abi: factoryAbi, functionName: "getPool", args: [whsk, usdt, POOL_FEE] }));
await ensure(
  publicClient,
  "create the pool",
  async () => BigInt(await getPool()) !== 0n,
  () => market.writeContract({ address: testnet.factory, abi: factoryAbi, functionName: "createPool", args: [whsk, usdt, POOL_FEE] }),
);
const pool = getAddress(await getPool());
state.pool = pool;
save();

const slot0 = () => retry(() => publicClient.readContract({ address: pool, abi: demoPoolAbi, functionName: "slot0" }));
const liquidity = () => retry(() => publicClient.readContract({ address: pool, abi: demoPoolAbi, functionName: "liquidity" }));

await ensure(
  publicClient,
  "start the pool at the mainnet price",
  async () => (await slot0())[0] !== 0n,
  () => market.writeContract({ address: pool, abi: demoPoolAbi, functionName: "initialize", args: [mainSqrtPrice] }),
);

// The vault prices everything by the pool's time-weighted average, which needs the pool to
// remember its recent prices. A new pool remembers one. The vault would enlarge that when
// the asset is listed; doing it now lets history build up from the first block.
const neededSlots = Math.floor(policyFromEnv().twapWindow / 2) + 1;
await ensure(
  publicClient,
  `let the pool remember ${neededSlots} prices`,
  async () => (await slot0())[4] >= neededSlots,
  () => market.writeContract({ address: pool, abi: demoPoolAbi, functionName: "increaseObservationCardinalityNext", args: [neededSlots] }),
);
state.oracleSlots = neededSlots;

// ------------------------------------------------------------- liquidity

if ((await liquidity()) === 0n) {
  // One position over the whole price range, with the liquidity the mainnet pool has at its
  // current price. Near that price a trade then moves the demo pool as it would the real one.
  const sqrtPrice = (await slot0())[0];
  const amount0 = amount0Delta(sqrtPrice, sqrtRatioAtTick(FULL_RANGE.tickUpper), mainLiquidity, true);
  const amount1 = amount1Delta(sqrtRatioAtTick(FULL_RANGE.tickLower), sqrtPrice, mainLiquidity, true);
  const mintWhsk = amount0 * 5n > WHSK_SUPPLY ? amount0 * 5n : WHSK_SUPPLY;
  const mintUsdt = amount1 * 5n > USDT_SUPPLY ? amount1 * 5n : USDT_SUPPLY;

  await ensure(
    publicClient,
    `mint ${formatEther(mintWhsk)} test WHSK`,
    async () => (await balanceOf(whsk, marketAddress)) >= amount0,
    () => market.writeContract({ address: whsk, abi: testTokenAbi, functionName: "mint", args: [marketAddress, mintWhsk] }),
  );
  await ensure(
    publicClient,
    `mint ${formatUnits(mintUsdt, 6)} test USDT`,
    async () => (await balanceOf(usdt, marketAddress)) >= amount1,
    () => market.writeContract({ address: usdt, abi: testTokenAbi, functionName: "mint", args: [marketAddress, mintUsdt] }),
  );
  for (const [symbol, token, amount] of [["WHSK", whsk, amount0], ["USDT", usdt, amount1]] as const) {
    await ensure(
      publicClient,
      `let the position manager take test ${symbol}`,
      async () => (await allowance(token, testnet.positionManager)) >= amount,
      () => market.writeContract({ address: token, abi: testTokenAbi, functionName: "approve", args: [testnet.positionManager, maxUint256] }),
    );
  }
  const deadline = (await retry(() => publicClient.getBlock())).timestamp + 3_600n;
  await ensure(
    publicClient,
    "add liquidity",
    async () => (await liquidity()) > 0n,
    () =>
      market.writeContract({
        address: testnet.positionManager,
        abi: positionManagerAbi,
        functionName: "mint",
        args: [{ token0: whsk, token1: usdt, fee: POOL_FEE, ...FULL_RANGE, amount0Desired: amount0, amount1Desired: amount1, amount0Min: 0n, amount1Min: 0n, recipient: marketAddress, deadline }],
      }),
  );
  state.seeded = { sqrtPriceX96: sqrtPrice.toString(), liquidity: mainLiquidity.toString(), usdtPerWhsk: usdtPerWhsk(sqrtPrice), mainnetBlock: mainBlock.toString() };
  save();
} else {
  console.log("  add liquidity: already done");
}

// The price keeper swaps through the router, which pulls the tokens from the market key.
for (const [symbol, token] of [["WHSK", whsk], ["USDT", usdt]] as const) {
  await ensure(
    publicClient,
    `let the router take test ${symbol}`,
    async () => (await allowance(token, testnet.router)) >= maxUint256 / 2n,
    () => market.writeContract({ address: token, abi: testTokenAbi, functionName: "approve", args: [testnet.router, maxUint256] }),
  );
}
save();

// ----------------------------------------------------------------- result

setEnvValue(envFile, "TEST_WHSK_ADDRESS", whsk);
setEnvValue(envFile, "TEST_USDT_ADDRESS", usdt);
if (isLocal) {
  // Everything a rehearsal on the fork needs. The two keys are Hardhat's public test keys.
  for (const [key, value] of [
    ["ENV_FILE", TESTNET_FORK_ENV],
    ["HSK_NETWORK", "testnet"],
    ["HSK_RPC_URL", "http://127.0.0.1:8545"],
    ["AGENT_PRIVATE_KEY", LOCAL_AGENT_KEY],
    ["TESTNET_MARKET_KEY", LOCAL_MARKET_KEY],
    ["VAULT_ASSETS", "WHSK"],
    ["ALLOW_STALE_CHAIN", "1"],
    ["DATA_DIR", "data/testnet-fork"],
    ["PORT", "8788"],
    ["ASSUME_GAS_PRICE_GWEI", "500"],
  ] as const) {
    setEnvValue(envFile, key, value);
  }
}

const [finalSlot0, finalLiquidity, token0] = await Promise.all([
  slot0(),
  liquidity(),
  retry(() => publicClient.readContract({ address: pool, abi: demoPoolAbi, functionName: "token0" })),
]);
if (getAddress(token0) !== whsk) throw new Error("The pool's token0 is not the test WHSK. This should be impossible.");
console.log(`\nDemo pool ${isLocal ? pool : `${testnet.explorerUrl}/address/${pool}`}`);
console.log(
  `  ${usdtPerWhsk(finalSlot0[0]).toFixed(6)} test USDT per test WHSK, about ` +
    `${Math.round(Number((finalLiquidity * finalSlot0[0]) >> 96n) / 1e6).toLocaleString("en-US")} test USDT a side, ` +
    `remembers up to ${finalSlot0[4]} prices`,
);
console.log(`  saved ${stateFile}; token addresses written to ${envFile}`);
console.log(`\nThe vault can list this pool once it is ${policyFromEnv().twapWindow} seconds old. The deployment waits for that by itself.`);
