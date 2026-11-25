// Publishes the source code of what this project deployed, so that explorers can show it.
//
//   npm run testnet:verify   the vault and the two test tokens on the HSK Chain testnet
//   npm run verify:hsk       the vault on HSK Chain mainnet
//
// Sourcify comes first, then the chain's Blockscout explorer. The testnet explorer refuses
// requests over 102,400 bytes (measured 2026-11-25; the mainnet explorer took 1.5 MB), and
// the vault with the libraries it imports is 190 KB of source, so on the testnet only the
// small test tokens get through here. docs/기획서.md, section 8, records how the vault was
// then put on the testnet explorer. The command line of hardhat-verify 3.1.5 also ignores
// --constructor-args-path for Sourcify, which is why this script calls the plugin itself.
// Publishing cannot be undone.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";

import { TEST_TOKENS } from "./lib/testnet.ts";
import { firstLine, sleep } from "./lib/tx.ts";

const NETWORKS: Record<string, string> = { hskRead: "177", hskTestnetRead: "133" };
const id = NETWORKS[hre.globalOptions.network ?? ""];
if (!id) throw new Error('Run this with "--network hskRead" (mainnet) or "--network hskTestnetRead" (testnet). Neither needs a key.');

interface Target {
  label: string;
  address: string;
  contract: string;
  constructorArgs: unknown[];
}
const targets: Target[] = [];

const vaultFile = `deployments/${id}.json`;
if (!existsSync(vaultFile)) throw new Error(`${vaultFile} is missing: nothing has been deployed on this network yet.`);
const vault = JSON.parse(readFileSync(vaultFile, "utf8")) as { vault: string };
const args = (await import(pathToFileURL(path.resolve(`deployments/${id}-args.js`)).href)) as { default: unknown[] };
targets.push({ label: "AgentVault", address: vault.vault, contract: "contracts/AgentVault.sol:AgentVault", constructorArgs: args.default });

const marketFile = `deployments/${id}-market.json`;
if (existsSync(marketFile)) {
  const market = JSON.parse(readFileSync(marketFile, "utf8")) as { whsk: string; usdt: string };
  for (const kind of ["whsk", "usdt"] as const) {
    targets.push({ label: `TestToken ${TEST_TOKENS[kind][1]}`, address: market[kind], contract: "contracts/testnet/TestToken.sol:TestToken", constructorArgs: [...TEST_TOKENS[kind]] });
  }
}

/** One explorer, with a few tries for the connections these hosts drop now and then. */
async function publish(target: Target, provider: "sourcify" | "blockscout"): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      await verifyContract({ address: target.address, contract: target.contract, constructorArgs: target.constructorArgs, provider }, hre);
      return "published";
    } catch (error) {
      const message = firstLine(error);
      const dropped = /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN/.test(message);
      if (!dropped || attempt >= 5) return `failed: ${message}`;
      await sleep(2_000 * attempt);
    }
  }
}

let unpublished = 0;
for (const target of targets) {
  console.log(`${target.label} ${target.address}`);
  const results: string[] = [];
  for (const provider of ["sourcify", "blockscout"] as const) {
    const result = await publish(target, provider);
    results.push(result);
    console.log(`  ${provider.padEnd(10)} ${result}`);
  }
  if (!results.includes("published")) unpublished += 1;
}
if (unpublished > 0) {
  console.log(`\n${unpublished} of ${targets.length} could not be published anywhere. See the messages above.`);
  process.exitCode = 1;
}
