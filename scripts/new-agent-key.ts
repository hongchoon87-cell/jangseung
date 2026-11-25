// Creates a fresh trading key for the agent and stores it in .env. Only the address is
// printed; the private key never appears on screen.
//
//   npm run agent:new-key
//
// The agent key can swap inside the vault's limits and nothing else. It needs a little HSK
// for gas and should never hold anything more.
import { copyFileSync, existsSync } from "node:fs";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { readEnvValue, setEnvValue } from "./lib/env-file.ts";

const file = ".env";
if (!existsSync(file)) copyFileSync(".env.example", file);

const existing = readEnvValue(file, "AGENT_PRIVATE_KEY");
if (existing) {
  const address = privateKeyToAccount(existing as `0x${string}`).address;
  setEnvValue(file, "AGENT_ADDRESS", address);
  console.log(`.env already holds an agent key. Its address is ${address}. The key was left as it is.`);
} else {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  setEnvValue(file, "AGENT_PRIVATE_KEY", key);
  setEnvValue(file, "AGENT_ADDRESS", address);
  console.log(`New agent key stored in .env. Address: ${address}`);
}
console.log("Send this address a little HSK for gas before the agent trades. A buy costs about 0.16 HSK.");
