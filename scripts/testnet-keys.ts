// Creates the keys of the testnet demo and stores them in .env.testnet. Only addresses are
// printed; the private keys never appear on screen.
//
//   npm run testnet:keys
//
// Three keys, all for the HSK Chain testnet only:
//   market  deploys the two test tokens and the demo pool, and keeps the pool at the mainnet price
//   owner   owns the testnet vault
//   agent   trades inside the vault's limits
//
// Test tokens have no value, so these keys sit in a plain file. The mainnet owner key is not
// one of them: it stays in the encrypted Hardhat keystore and is never used on the testnet.
import { existsSync, writeFileSync } from "node:fs";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { readEnvValue, setEnvValue } from "./lib/env-file.ts";
import { TESTNET_ENV } from "./lib/testnet.ts";

const HEADER = `# HSK Chain testnet demo. Written by "npm run testnet:keys" and "npm run testnet:market".
# The keys below are for the testnet only. Never send real funds to their addresses and
# never use them on mainnet. Never commit this file.

# Keeps a testnet run from also loading .env, which holds the mainnet settings.
ENV_FILE=${TESTNET_ENV}
HSK_NETWORK=testnet
VAULT_ASSETS=WHSK
DATA_DIR=data/testnet
PORT=8788
# Weigh trades as if gas cost what it costs on mainnet. The testnet charges 1 gwei.
ASSUME_GAS_PRICE_GWEI=500
`;

if (!existsSync(TESTNET_ENV)) writeFileSync(TESTNET_ENV, HEADER);

/** Makes sure `keyName` holds a key and `addressName` its address. Returns the address. */
function ensureKey(keyName: string, addressName: string): { address: string; created: boolean } {
  const existing = readEnvValue(TESTNET_ENV, keyName);
  const key = (existing ?? generatePrivateKey()) as `0x${string}`;
  const address = privateKeyToAccount(key).address;
  if (!existing) setEnvValue(TESTNET_ENV, keyName, key);
  setEnvValue(TESTNET_ENV, addressName, address);
  return { address, created: !existing };
}

const market = ensureKey("TESTNET_MARKET_KEY", "TESTNET_MARKET_ADDRESS");
const owner = ensureKey("TESTNET_OWNER_KEY", "TESTNET_OWNER_ADDRESS");
const agent = ensureKey("AGENT_PRIVATE_KEY", "AGENT_ADDRESS");

const note = (created: boolean) => (created ? "new" : "kept");
console.log(`Testnet keys are in ${TESTNET_ENV}. Addresses:`);
console.log(`  market  ${market.address}  (${note(market.created)})`);
console.log(`  owner   ${owner.address}  (${note(owner.created)})`);
console.log(`  agent   ${agent.address}  (${note(agent.created)})`);
console.log("\nNext: request test HSK for the market address at https://faucet.hskchain.net/faucet");
console.log('(one request a day brings 0.1 HSK; the demo needs about 0.015). Then run "npm run testnet:setup".');
console.log("The market key passes a little gas on to the owner and the agent.");
