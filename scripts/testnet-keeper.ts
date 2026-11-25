// Keeps the testnet demo pool at the price of the real WHSK/USDT pool on mainnet, so the
// agent on the testnet meets the market it would meet on mainnet.
//
//   npm run testnet:keeper              follow mainnet until stopped (Ctrl+C)
//   npm run testnet:keeper -- --once    bring the pool to the mainnet price once and exit
//
// It acts only when the mainnet pool has traded since the last look. In between, whatever
// the agent's own trades did to the demo pool stays, which is the assumption the backtest
// makes: our price impact lasts until the next trade of someone else.
//
// KEEPER_SECONDS   seconds between looks (default 20)
// KEEPER_MIN_BPS   smallest gap worth a transaction, in bps (default 1)
// MAINNET_RPC_URL  where to read the mainnet pool (default https://mainnet.hsk.xyz)
import { connectDemoMarket, demoSqrtPrice, mainnetPool, moveTo } from "./lib/demo-market.ts";
import { usdtPerWhsk } from "./lib/testnet.ts";
import { firstLine, sleep } from "./lib/tx.ts";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.KEEPER_SECONDS || 20) * 1_000;
const minBps = Number(process.env.KEEPER_MIN_BPS || 1);
if (!(intervalMs >= 1_000) || !(minBps >= 0)) throw new Error("KEEPER_SECONDS must be at least 1 and KEEPER_MIN_BPS must not be negative.");

const market = await connectDemoMarket();
const stamp = () => new Date().toISOString().slice(11, 19);
console.log(`Keeper ${market.account.address} on the demo pool ${market.pool}`);

/** The mainnet price the demo pool was last brought to. */
let followed: bigint | undefined;
let failures = 0;

async function look(): Promise<void> {
  const { sqrtPriceX96: target, liquidity } = await mainnetPool(market);
  if (target === followed) return;

  const current = await demoSqrtPrice(market);
  const gapBps = (usdtPerWhsk(current) / usdtPerWhsk(target) - 1) * 10_000;
  if (Math.abs(gapBps) < minBps) {
    // Say so on the first look, so a quiet terminal is known to be a working one.
    if (once || followed === undefined) console.log(`${stamp()} already at the mainnet price ${usdtPerWhsk(target).toFixed(6)} (gap ${gapBps.toFixed(2)} bps)`);
    followed = target;
    return;
  }
  const move = await moveTo(market, target);
  followed = target;
  if (move) {
    console.log(
      `${stamp()} followed mainnet: ${move.from.toFixed(6)} -> ${move.to.toFixed(6)} USDT per WHSK (${(-gapBps).toFixed(1)} bps), ` +
        `mainnet depth about ${Math.round(Number((liquidity * target) >> 96n) / 1e6).toLocaleString("en-US")} USDT a side, tx ${move.txHash}`,
    );
  }
}

do {
  try {
    await look();
    failures = 0;
  } catch (error) {
    failures += 1;
    // One failed look is routine on a public RPC. Say so once, then only now and then.
    if (once) throw error;
    if (failures === 1 || failures % 30 === 0) console.warn(`${stamp()} could not follow (${failures} in a row): ${firstLine(error)}`);
  }
  if (!once) await sleep(intervalMs);
} while (!once);
