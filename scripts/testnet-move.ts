// Stages a move of the testnet demo pool's price, to show how the agent and the vault react.
// Stop the keeper first, or it brings the price back at the next mainnet trade.
//
//   npm run testnet:move -- dump 10         the price falls 10%
//   npm run testnet:move -- pump 3          the price rises 3%
//   npm run testnet:fork:move -- wait 300   local fork only: advance the clock, e.g. past the TWAP window
//
// The market key does the trading with test tokens. Testnet only.
import { createTestClient, http } from "viem";

import { config } from "../agent/src/config.ts";
import { connectDemoMarket, demoSqrtPrice, moveTo } from "./lib/demo-market.ts";
import { usdtPerWhsk } from "./lib/testnet.ts";

const [move = "dump", amount] = process.argv.slice(2);
const market = await connectDemoMarket();

if (move === "wait") {
  if (!market.isLocal) throw new Error("Only a local fork's clock can be advanced. On the testnet, wait.");
  const seconds = Number(amount || 300);
  if (!(seconds > 0)) throw new Error(`The number of seconds must be positive, got "${amount}"`);
  const testClient = createTestClient({ mode: "hardhat", transport: http(config.rpcUrl) });
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
  console.log(`Advanced the fork clock by ${seconds}s.`);
} else if (move === "dump" || move === "pump") {
  const percent = Number(amount || 10);
  if (!(percent > 0 && percent < 90)) throw new Error(`The percentage must be between 0 and 90, got "${amount}"`);
  const factor = move === "dump" ? 1 - percent / 100 : 1 + percent / 100;
  // The pool stores the square root of the price, so scale by the square root of the factor.
  const current = await demoSqrtPrice(market);
  const target = (current * BigInt(Math.round(Math.sqrt(factor) * 1e12))) / 10n ** 12n;
  const done = await moveTo(market, target);
  if (!done) throw new Error("The pool is already at that price.");
  console.log(`Test WHSK/USDT ${done.from.toFixed(6)} -> ${done.to.toFixed(6)} (${((done.to / done.from - 1) * 100).toFixed(2)}%), tx ${done.txHash}`);
} else {
  throw new Error(`Unknown move "${move}". Use dump, pump or wait.`);
}
console.log(`Demo pool now at ${usdtPerWhsk(await demoSqrtPrice(market)).toFixed(6)} test USDT per test WHSK.`);
