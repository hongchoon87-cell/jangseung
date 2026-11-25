// Puts test USDT into the testnet vault: the market key mints it to the vault's owner, and
// the owner deposits it. Safe to run again; it tops the vault up to the target and no further.
//
//   npm run testnet:fund           HSK Chain testnet
//   npm run testnet:fork:fund      a local fork of the testnet
//
// TESTNET_DEPOSIT_USDT sets the target (default 1000, the size the backtest used).
import hre, { network } from "hardhat";
import { formatUnits, getAddress, isAddressEqual, parseUnits, type Address } from "viem";

import { TESTNET_ENV, TESTNET_FORK_ENV, testTokenAbi } from "./lib/testnet.ts";
import { ensure, retry } from "./lib/tx.ts";

const isLocal = hre.globalOptions.network === "localhost";
if (!isLocal && hre.globalOptions.network !== "hskTestnet") {
  throw new Error('Run this with "--network hskTestnet" or, for a rehearsal, "--network localhost".');
}
// The agent's settings are read when its config module loads, so name the testnet file first.
process.env.ENV_FILE = isLocal ? TESTNET_FORK_ENV : TESTNET_ENV;
const { BASE, config, NETWORK } = await import("../agent/src/config.ts");

if (NETWORK.name !== "testnet") throw new Error("Test USDT exists on the testnet only.");
if (!config.vault) throw new Error(`VAULT_ADDRESS is missing from ${process.env.ENV_FILE}. Run "npm run testnet:deploy" first.`);
const vaultAddress = config.vault;
const target = parseUnits(process.env.TESTNET_DEPOSIT_USDT || "1000", BASE.decimals);

const { viem } = await network.create();
// Building a client asks the node for its chain id, and the public RPC drops a connection now and then.
const publicClient = await retry(() => viem.getPublicClient());
const wallets = await retry(() => viem.getWalletClients());
// A local node offers its test accounts: owner, agent, market. The testnet has the owner
// and market keys of .env.testnet.
const owner = wallets[0];
const market = isLocal ? wallets[2] : wallets[1];
if (!owner || !market) throw new Error('The accounts for this network are missing. Run "npm run testnet:keys" first.');
if ((await retry(() => publicClient.getChainId())) !== NETWORK.chainId) throw new Error(`This is not ${NETWORK.label}.`);
const ownerAddress = getAddress(owner.account.address);

const vault = await retry(() => viem.getContractAt("AgentVault", vaultAddress));
const vaultOwner = (await retry(() => vault.read.owner())) as Address;
if (!isAddressEqual(vaultOwner, ownerAddress)) throw new Error(`The owner key is ${ownerAddress} but the vault's owner is ${vaultOwner}.`);

const read = <T>(functionName: "balanceOf" | "allowance", args: readonly Address[]) =>
  retry(() => publicClient.readContract({ address: BASE.address, abi: testTokenAbi, functionName, args: args as never })) as Promise<T>;
const nav = async () => (await retry(() => vault.read.nav())) as bigint;
const show = (amount: bigint) => formatUnits(amount, BASE.decimals);

const before = await nav();
if (before >= target) {
  console.log(`The vault already holds ${show(before)} test USDT in value (target ${show(target)}). Nothing to do.`);
} else {
  const missing = target - before;
  console.log(`Vault ${vaultAddress}: ${show(before)} test USDT in value, adding ${show(missing)}`);
  // Each step is recognised by its effect, so an interrupted run carries on where it stopped.
  await ensure(
    publicClient,
    `mint ${show(missing)} test USDT to the owner`,
    async () => (await read<bigint>("balanceOf", [ownerAddress])) >= missing || (await nav()) >= target,
    () => market.writeContract({ address: BASE.address, abi: testTokenAbi, functionName: "mint", args: [ownerAddress, missing] }),
  );
  await ensure(
    publicClient,
    "let the vault take the owner's test USDT",
    async () => (await read<bigint>("allowance", [ownerAddress, vaultAddress])) >= missing || (await nav()) >= target,
    () => owner.writeContract({ address: BASE.address, abi: testTokenAbi, functionName: "approve", args: [vaultAddress, missing] }),
  );
  await ensure(
    publicClient,
    "deposit into the vault",
    async () => (await nav()) >= target,
    () => vault.write.deposit([missing]),
  );
  console.log(`The vault now holds ${show(await nav())} test USDT in value.`);
}
