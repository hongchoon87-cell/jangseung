// Deploys an AgentVault and lists its assets. Safe to run again after an interruption: it
// carries on from what is already on-chain instead of deploying a second vault.
//
//   npm run deploy:check     HSK Chain mainnet: show balances, cost and plan. Sends nothing.
//   npm run deploy:hsk       HSK Chain mainnet, deployer key from the Hardhat keystore
//   npm run deploy:fork      a local fork node (npm run fork)
//   npm run testnet:deploy   HSK Chain testnet, against the demo market (scripts/testnet-deploy.ts)
//
// Settings come from the environment or the env file (.env; .env.testnet on the testnet):
//   AGENT_ADDRESS   address allowed to trade (required on a real network; "npm run agent:new-key" makes one)
//   VAULT_OWNER     owner of the vault (default: the deployer)
//   VAULT_ASSETS    comma-separated symbols to list (default: every asset known on the network)
//   POLICY_*        risk limits, see scripts/lib/policy.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { network } from "hardhat";
import { encodeDeployData, formatEther, formatUnits, getAddress, getContractAddress, isAddress, parseAbi, type Abi, type Address, type Hex } from "viem";

import { poolAbi } from "../agent/src/chain.ts";
import { ADDRESSES, ASSETS, BASE, config, NETWORK } from "../agent/src/config.ts";
import { setEnvValue } from "./lib/env-file.ts";
import { policyFromEnv } from "./lib/policy.ts";

const checkOnly = process.env.DEPLOY_CHECK_ONLY === "1";
/**
 * Gas of one configureAsset call when the pool's oracle is already large enough. A fork of
 * mainnet measured 120,308 for WHSK and 103,208 for WETH; this leaves a margin.
 */
const LISTING_GAS = 150_000n;
/** Gas per observation slot the vault adds to a pool's oracle. */
const ORACLE_SLOT_GAS = 22_100n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (error: unknown) => String((error as { shortMessage?: string }).shortMessage ?? (error as Error).message ?? error).split("\n")[0];

/** The public RPC drops a connection now and then, so every read gets a few tries. */
async function retry<T>(read: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1_000 * attempt);
    }
  }
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

const connection = await network.create();
const { viem } = connection;
// Building a client asks the node for its chain id, so it gets the same few tries as a read.
const publicClient = await retry(() => viem.getPublicClient());
const [deployer, second] = await retry(() => viem.getWalletClients());
if (!deployer) throw new Error("No deployer account is configured for this network.");

const chainId = await retry(() => publicClient.getChainId());
const isLocal = connection.networkName === "localhost" || connection.networkConfig.type === "edr-simulated";
// A fork keeps the id of the chain it forked, so this holds for local runs too.
if (chainId !== NETWORK.chainId) {
  throw new Error(`This is chain ${chainId}, but the settings are for ${NETWORK.label} (chain ${NETWORK.chainId}). Check HSK_NETWORK and --network.`);
}
const onTestnet = NETWORK.name === "testnet";
/** The env file this run's settings came from, and where the vault's address goes. */
const envFile = process.env.ENV_FILE ?? ".env";

// Accounts reported by a node can be lower-case; normalise before comparing.
const deployerAddress = getAddress(deployer.account.address);
const owner = process.env.VAULT_OWNER ? getAddress(process.env.VAULT_OWNER) : deployerAddress;
const agentEnv = process.env.AGENT_ADDRESS;
if (agentEnv && !isAddress(agentEnv)) throw new Error(`AGENT_ADDRESS is not an address: ${agentEnv}`);
const agent = agentEnv ? getAddress(agentEnv) : isLocal && second ? getAddress(second.account.address) : undefined;
if (!agent) throw new Error('Set AGENT_ADDRESS to the address of the agent\'s trading key ("npm run agent:new-key" creates one).');
if (agent === owner) console.warn("Warning: the agent and the owner are the same address. Use a separate key for the agent.");

const symbols = (process.env.VAULT_ASSETS || ASSETS.map((a) => a.symbol).join(",")).split(",").map((s) => s.trim());
const assets = symbols.map((symbol) => {
  const asset = ASSETS.find((a) => a.symbol === symbol);
  if (!asset) throw new Error(`Unknown asset "${symbol}". Known: ${ASSETS.map((a) => a.symbol).join(", ")}`);
  return asset;
});
const policy = policyFromEnv();
const constructorArgs = [owner, agent, ADDRESSES.usdt, ADDRESSES.router, ADDRESSES.factory, policy] as const;

mkdirSync("deployments", { recursive: true });
const file = `deployments/${isLocal ? (onTestnet ? "testnet-fork" : "fork") : chainId}.json`;
const explorer = (address: string) => (isLocal ? address : `${config.explorerUrl}/address/${address}`);

// ------------------------------------------------------------------ the plan

const hasCode = async (address: Address) => {
  const code = await retry(() => publicClient.getCode({ address }));
  return code !== undefined && code !== "0x";
};

/** A vault from an earlier run of this script, if it is really there and is the one asked for. */
async function earlierVault(): Promise<Address | undefined> {
  if (!existsSync(file)) return undefined;
  const saved = JSON.parse(readFileSync(file, "utf8")) as { vault?: string; owner?: string; agent?: string };
  if (!saved.vault || !isAddress(saved.vault) || !(await hasCode(saved.vault))) return undefined;
  if (saved.owner !== owner || saved.agent !== agent) {
    throw new Error(`${file} records a vault for another owner or agent. Move that file away to deploy a new vault.`);
  }
  return getAddress(saved.vault);
}

const neededSlots = Math.floor(policy.twapWindow / 2) + 1;
const artifact = JSON.parse(readFileSync("artifacts/contracts/AgentVault.sol/AgentVault.json", "utf8")) as { abi: Abi; bytecode: Hex };

const [hskBalance, usdtBalance, agentBalance, gasPrice, existing] = await Promise.all([
  retry(() => publicClient.getBalance({ address: deployerAddress })),
  retry(() => publicClient.readContract({ address: ADDRESSES.usdt, abi: erc20, functionName: "balanceOf", args: [deployerAddress] })),
  retry(() => publicClient.getBalance({ address: agent })),
  retry(() => publicClient.getGasPrice()),
  earlierVault(),
]);

console.log(`AgentVault on ${NETWORK.label} (chain ${chainId})${isLocal ? ", local fork" : ""}${checkOnly ? " (check only: nothing will be sent)" : ""}`);
console.log(`  deployer  ${deployerAddress}  ${formatEther(hskBalance)} HSK, ${formatUnits(usdtBalance, BASE.decimals)} USDT`);
console.log(`  owner     ${owner}${owner === deployerAddress ? " (the deployer)" : ""}`);
console.log(`  agent     ${agent}  ${formatEther(agentBalance)} HSK${agentBalance === 0n ? "  <- needs a little HSK for gas before it can trade" : ""}`);
console.log(
  `  policy    one buy up to ${policy.maxTradeBps / 100}% of NAV, one asset up to ${policy.maxPositionBps / 100}%, all assets up to ${policy.maxExposureBps / 100}%, ` +
    `slippage ${policy.maxSlippageBps / 100}%, stop-loss ${policy.stopLossBps / 100}%, breaker ${policy.maxDrawdownBps / 100}%, ` +
    `${policy.maxTradesPerDay} buys a day ${policy.cooldown}s apart, TWAP ${policy.twapWindow}s, lockout ${policy.reentryLockout}s`,
);

/** Whether the pool can report its average price over the vault's TWAP window. */
async function hasHistory(pool: Address): Promise<boolean> {
  try {
    await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[policy.twapWindow, 0]] });
    return true;
  } catch (error) {
    // The pool answers "OLD" when its oldest price is younger than the window. Anything
    // else is a failed read, which the caller's retry deals with.
    if (/\bOLD\b/.test(String((error as Error).message))) return false;
    throw error;
  }
}

let listingGas = 0n;
/** Pools too young for the vault's TWAP. Listing has to wait for them. */
const young: { symbol: string; pool: Address }[] = [];
for (const asset of assets) {
  const pool = await retry(() => publicClient.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: "getPool", args: [asset.address, ADDRESSES.usdt, asset.fee] }));
  if (BigInt(pool) === 0n) throw new Error(`HSKSwap has no ${asset.symbol}/USDT pool at fee ${asset.fee}.`);
  const [slot0, liquidity, history] = await Promise.all([
    retry(() => publicClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" })),
    retry(() => publicClient.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" })),
    retry(() => hasHistory(pool)),
  ]);
  const slots = slot0[4];
  const missing = Math.max(0, neededSlots - slots);
  // Base token in range: liquidity times the square root of the price when the asset is
  // token0, liquidity divided by it when the base token is.
  const assetIsToken0 = BigInt(asset.address) < BigInt(ADDRESSES.usdt);
  const depth = Number(assetIsToken0 ? (liquidity * slot0[0]) >> 96n : (liquidity << 96n) / slot0[0]) / 10 ** BASE.decimals;
  listingGas += LISTING_GAS + BigInt(missing) * ORACLE_SLOT_GAS;
  if (!history) young.push({ symbol: asset.symbol, pool });
  console.log(
    `  asset     ${asset.symbol}  pool ${pool}  about ${Math.round(depth).toLocaleString("en-US")} USDT a side, ` +
      `${slots} oracle slots (${neededSlots} needed${missing ? `, the vault will add ${missing}` : ""})` +
      (history ? "" : `, price history shorter than ${policy.twapWindow}s`),
  );
}

let deployGas = 0n;
if (!existing) {
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: constructorArgs });
  // An estimate needs no funds; if the node refuses one, fall back to what a fork run measured.
  deployGas = await retry(() => publicClient.estimateGas({ account: deployerAddress, data }), 3).catch(() => 4_700_000n);
}
const cost = (deployGas + listingGas) * gasPrice;
console.log(`  gas price ${formatUnits(gasPrice, 9)} gwei`);
console.log(
  existing
    ? `  found the vault from an earlier run at ${existing}; continuing with it`
    : `  deployment about ${deployGas.toLocaleString("en-US")} gas, listing about ${listingGas.toLocaleString("en-US")} gas: about ${formatEther(cost)} HSK in all`,
);

const short = hskBalance < (cost * 12n) / 10n;
if (short) {
  const message = `The deployer holds ${formatEther(hskBalance)} HSK and this needs about ${formatEther((cost * 12n) / 10n)} with a margin. Send HSK to ${deployerAddress} on ${NETWORK.label} and run this again.`;
  if (!checkOnly && !isLocal) throw new Error(message);
  console.log(`  ! ${message}`);
}
if (young.length > 0) {
  console.log(`  the vault prices an asset by its pool's ${policy.twapWindow}s average, so listing ${young.map((y) => y.symbol).join(", ")} waits until the pool is that old`);
}

if (checkOnly) {
  console.log(short ? "\nNot ready: see the line marked with ! above." : `\nReady. Run "npm run ${onTestnet ? "testnet:deploy" : "deploy:hsk"}" to deploy.`);
} else {
  await deploy();
}

// --------------------------------------------------------------- deployment

function save(vault: Address, stage: string): void {
  writeFileSync(
    file,
    JSON.stringify({ chainId, vault, owner, agent, assets: assets.map((a) => a.symbol), policy, stage, updatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  // The verifier wants the constructor arguments as a module.
  writeFileSync(file.replace(/\.json$/, "-args.js"), `export default ${JSON.stringify(constructorArgs, null, 2)};\n`);
}

/** Sends the deployment and returns the vault's address, also when the connection drops after the transaction went out. */
async function deployVault(): Promise<Address> {
  const nonce = await retry(() => publicClient.getTransactionCount({ address: deployerAddress, blockTag: "pending" }));
  const expected = getContractAddress({ from: deployerAddress, nonce: BigInt(nonce) });
  try {
    const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction("AgentVault", [...constructorArgs]);
    console.log(`  deployment transaction ${deploymentTransaction.hash}`);
    const receipt = await retry(() => publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash, timeout: 180_000 }));
    if (receipt.status !== "success") throw new Error("the deployment transaction reverted");
    console.log(`  deployed at ${contract.address} for ${receipt.gasUsed.toLocaleString("en-US")} gas`);
    return getAddress(contract.address);
  } catch (error) {
    // The transaction may have gone out even though the answer never arrived. A contract
    // created by this account at this nonce can only be at one address, so look there.
    console.warn(`  the deployment call failed (${firstLine(error)}); checking whether it went through anyway`);
    for (let i = 0; i < 30; i++) {
      await sleep(4_000);
      if (await hasCode(expected).catch(() => false)) {
        console.log(`  it did: the vault is at ${expected}`);
        return expected;
      }
    }
    throw error;
  }
}

async function deploy(): Promise<void> {
  const address = existing ?? (await deployVault());
  save(address, "deployed");
  const vault = await retry(() => viem.getContractAt("AgentVault", address));
  const isListed = async (asset: Address) => ((await retry(() => vault.read.assets([asset]))) as readonly unknown[])[0] === true;

  if (owner !== deployerAddress) {
    console.log("The deployer is not the owner, so no assets were listed. The owner must call configureAsset.");
  } else {
    for (const asset of assets) {
      if (await isListed(asset.address)) {
        console.log(`  ${asset.symbol} is already listed`);
        continue;
      }
      const waiting = young.find((y) => y.symbol === asset.symbol);
      if (waiting) await waitForHistory(asset.symbol, waiting.pool);
      try {
        const hash = await vault.write.configureAsset([asset.address, asset.fee, true]);
        const receipt = await retry(() => publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 }));
        if (receipt.status !== "success") throw new Error(`listing ${asset.symbol} reverted`);
        console.log(`  listed ${asset.symbol} for ${receipt.gasUsed.toLocaleString("en-US")} gas`);
      } catch (error) {
        console.warn(`  listing ${asset.symbol} failed (${firstLine(error)}); checking whether it went through anyway`);
        let listed = false;
        for (let i = 0; i < 15 && !listed; i++) {
          await sleep(4_000);
          listed = await isListed(asset.address).catch(() => false);
        }
        if (!listed) throw new Error(`${asset.symbol} was not listed. Run the same command again: it continues from here.`);
        console.log(`  it did: ${asset.symbol} is listed`);
      }
    }
  }
  save(address, "listed");

  // Read back what is on-chain rather than trusting what was sent.
  const [onChainOwner, onChainAgent, listed] = await Promise.all([
    retry(() => vault.read.owner()),
    retry(() => vault.read.agent()),
    retry(() => vault.read.assetList()),
  ]);
  console.log(`\nVault ${explorer(address)}`);
  console.log(`  owner ${String(onChainOwner)}, agent ${String(onChainAgent)}, ${(listed as readonly unknown[]).length} asset(s) listed`);
  console.log(`  saved ${file}`);

  // A run on the mainnet fork leaves .env alone: scripts/fork-setup.ts writes .env.fork for
  // it. Every other run records the vault where its settings came from.
  if ((!isLocal || process.env.ENV_FILE) && existsSync(envFile)) {
    setEnvValue(envFile, "VAULT_ADDRESS", address);
    console.log(`  VAULT_ADDRESS written to ${envFile}`);
  }
  if (isLocal) return;

  console.log("\nNext:");
  if (onTestnet) {
    console.log("  deposit test USDT    npm run testnet:fund");
    console.log("  publish the source   npm run testnet:verify");
    console.log("  follow the market    npm run testnet:keeper");
    console.log("  run the agent        npm run agent:testnet");
  } else {
    console.log("  publish the source   npm run verify:hsk");
    console.log("  deposit (optional)   set AMOUNT_USDT in .env, then: npm run deposit:hsk");
    console.log("  run the agent        npm run agent");
  }
}

/** Waits until `pool` can report its average price over the vault's TWAP window. */
async function waitForHistory(symbol: string, pool: Address): Promise<void> {
  const deadline = Date.now() + (policy.twapWindow + 120) * 1_000;
  let announced = false;
  while (!(await retry(() => hasHistory(pool)))) {
    if (Date.now() > deadline) {
      throw new Error(`The ${symbol} pool still has less than ${policy.twapWindow}s of price history. Run the same command again later: it continues from here.`);
    }
    if (!announced) console.log(`  waiting for the ${symbol} pool to be ${policy.twapWindow}s old (up to ${Math.ceil(policy.twapWindow / 60)} minutes)...`);
    announced = true;
    await sleep(10_000);
  }
}
