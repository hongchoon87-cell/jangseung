// Deploys the vault on the HSK Chain testnet against the demo market, with the testnet-only
// owner key of .env.testnet. The work is done by scripts/deploy.ts; this only points it at
// the testnet settings before that script reads them.
//
//   npm run testnet:deploy         HSK Chain testnet
//   npm run testnet:fork:deploy    a local fork of the testnet (npm run testnet:fork)
import hre from "hardhat";

import { TESTNET_ENV, TESTNET_FORK_ENV } from "./lib/testnet.ts";

const name = hre.globalOptions.network;
if (name !== "hskTestnet" && name !== "localhost") {
  throw new Error('Run this with "--network hskTestnet" or, for a rehearsal, "--network localhost".');
}
process.env.ENV_FILE = name === "localhost" ? TESTNET_FORK_ENV : TESTNET_ENV;
await import("./deploy.ts");
