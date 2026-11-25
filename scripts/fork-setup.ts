// Prepares a local fork for a full run of the agent: deploys a vault, gives the owner test
// USDT, deposits it, and writes .env.fork for the agent.
//
//   npm run fork            (terminal 1: fork node on 127.0.0.1:8545)
//   npm run fork:setup      (terminal 2)
//   npm run agent:fork      (terminal 2, then open the dashboard)
//
// Everything here uses Hardhat's public test accounts on a local fork. Nothing touches mainnet.
import { writeFileSync } from "node:fs";

import { network } from "hardhat";
import { formatUnits, isAddressEqual, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ADDRESSES, ASSETS } from "../agent/src/config.ts";
import { dealErc20 } from "./lib/fork.ts";
import { policyFromEnv } from "./lib/policy.ts";

// Hardhat's well-known test key #1. It is public: never fund it on a real network.
const TEST_AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const connection = await network.create();
if (connection.networkName !== "localhost") {
  throw new Error(`fork-setup only runs against the local fork node, not "${connection.networkName}".`);
}
const { viem } = connection;
const publicClient = await viem.getPublicClient();
const testClient = await viem.getTestClient();
const [owner, agent] = await viem.getWalletClients();
if (!owner || !agent) throw new Error("The fork node did not expose two test accounts.");
if (!isAddressEqual(privateKeyToAccount(TEST_AGENT_KEY).address, agent.account.address)) {
  throw new Error("The fork node's second account is not Hardhat's standard test account.");
}

const wait = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });

const vault = await viem.deployContract("AgentVault", [
  owner.account.address,
  agent.account.address,
  ADDRESSES.usdt,
  ADDRESSES.router,
  ADDRESSES.factory,
  // No cooldown on the fork, so a demo does not have to wait between trades.
  { ...policyFromEnv(), cooldown: 0 },
]);
for (const asset of ASSETS) await wait(await vault.write.configureAsset([asset.address, asset.fee, true]));
console.log(`Vault ${vault.address} (owner ${owner.account.address}, agent ${agent.account.address})`);

// Give the owner test USDT by writing the token's storage, so the pool price is left as it
// is on mainnet. Buying it through the pool would move the price the agent is about to read.
const usdt = parseUnits(process.env.FORK_DEPOSIT_USDT ?? "500", 6);
await dealErc20(testClient, publicClient, ADDRESSES.usdt, owner.account.address, usdt);
await wait(await owner.writeContract({ address: ADDRESSES.usdt, abi: erc20, functionName: "approve", args: [vault.address, usdt] }));
await wait(await vault.write.deposit([usdt]));
console.log(`Deposited ${formatUnits((await vault.read.nav()) as bigint, 6)} USDT into the vault`);

writeFileSync(
  ".env.fork",
  [
    "# Written by scripts/fork-setup.ts. Local fork only: the key below is Hardhat's public test key.",
    // Keeps a fork run from also loading .env, which holds the mainnet settings.
    "ENV_FILE=.env.fork",
    "HSK_RPC_URL=http://127.0.0.1:8545",
    `VAULT_ADDRESS=${vault.address}`,
    `AGENT_PRIVATE_KEY=${TEST_AGENT_KEY}`,
    "ALLOW_STALE_CHAIN=1",
    "DATA_DIR=data/fork",
    "",
  ].join("\n"),
);
console.log('Wrote .env.fork. Start the agent with "npm run agent:fork".');
