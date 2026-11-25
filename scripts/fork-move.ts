// Plays the outside market on the local fork, so the agent has something to react to.
//
//   MOVE=dump AMOUNT=300000 npm run fork:move    sell 300,000 WHSK into the pool (price falls)
//   MOVE=pump AMOUNT=20000  npm run fork:move    buy WHSK with 20,000 USDT (price rises)
//   MOVE=wait SECONDS=300   npm run fork:move    advance the fork's clock, e.g. past the TWAP window
//
// A third test account does the trading. Local fork only.
import { network } from "hardhat";
import { parseAbi, parseEther, parseUnits } from "viem";

import { ADDRESSES, ASSETS } from "../agent/src/config.ts";
import { dealErc20 } from "./lib/fork.ts";

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const wrapped = parseAbi(["function deposit() payable"]);
const router = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const pool = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"]);
const WHSK_POOL = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC";

const connection = await network.create();
if (connection.networkName !== "localhost") throw new Error("fork-move only runs against the local fork node.");
const { viem } = connection;
const publicClient = await viem.getPublicClient();
const testClient = await viem.getTestClient();
const trader = (await viem.getWalletClients())[2];
if (!trader) throw new Error("The fork node did not expose a third test account.");

const whsk = ASSETS.find((a) => a.symbol === "WHSK")!;
const wait = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });

/** USDT per WHSK at the pool's current price. WHSK is token0 with 18 decimals, USDT has 6. */
async function price(): Promise<number> {
  const [sqrtPriceX96] = await publicClient.readContract({ address: WHSK_POOL, abi: pool, functionName: "slot0" });
  return (Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** 30n) / (1n << 192n)) / 1e30) * 1e12;
}

async function swap(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint): Promise<void> {
  await wait(await trader!.writeContract({ address: tokenIn, abi: erc20, functionName: "approve", args: [ADDRESSES.router, amountIn] }));
  await wait(
    await trader!.writeContract({
      address: ADDRESSES.router,
      abi: router,
      functionName: "exactInputSingle",
      args: [{ tokenIn, tokenOut, fee: whsk.fee, recipient: trader!.account.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    }),
  );
}

const move = process.env.MOVE ?? "dump";
const before = await price();

if (move === "wait") {
  const seconds = Number(process.env.SECONDS ?? 300);
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
  console.log(`Advanced the fork clock by ${seconds}s.`);
} else if (move === "dump") {
  const amount = parseEther(process.env.AMOUNT ?? "300000");
  await testClient.setBalance({ address: trader.account.address, value: amount + parseEther("100") });
  await wait(await trader.writeContract({ address: whsk.address, abi: wrapped, functionName: "deposit", value: amount }));
  await swap(whsk.address, ADDRESSES.usdt, amount);
  console.log(`Sold ${process.env.AMOUNT ?? "300000"} WHSK into the pool.`);
} else if (move === "pump") {
  const amount = parseUnits(process.env.AMOUNT ?? "20000", 6);
  await dealErc20(testClient, publicClient, ADDRESSES.usdt, trader.account.address, amount);
  await swap(ADDRESSES.usdt, whsk.address, amount);
  console.log(`Bought WHSK with ${process.env.AMOUNT ?? "20000"} USDT.`);
} else {
  throw new Error(`Unknown MOVE "${move}". Use dump, pump or wait.`);
}

const after = await price();
console.log(`WHSK/USDT ${before.toFixed(6)} -> ${after.toFixed(6)} (${((after / before - 1) * 100).toFixed(2)}%)`);
