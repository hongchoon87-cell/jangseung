import type { Address, PublicClient } from "viem";

import { agentVaultAbi } from "./abi/agentVault.ts";
import { erc20Abi } from "./chain.ts";
import { assetByAddress, BASE } from "./config.ts";
import type { Policy, Portfolio, PositionState } from "./types.ts";

/** Reads the vault's full state. The calls are batched into one Multicall3 request. */
export async function readPortfolio(client: PublicClient, vault: Address): Promise<Portfolio> {
  const read = { address: vault, abi: agentVaultAbi } as const;

  const [
    block,
    owner,
    agent,
    nav,
    idleBase,
    pricePerShare,
    highWaterMark,
    drawdownBps,
    halted,
    buysToday,
    currentDay,
    lastBuyAt,
    policy,
    positions,
  ] = await Promise.all([
    client.getBlock(),
    client.readContract({ ...read, functionName: "owner" }),
    client.readContract({ ...read, functionName: "agent" }),
    client.readContract({ ...read, functionName: "nav" }),
    client.readContract({ address: BASE.address, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    client.readContract({ ...read, functionName: "pricePerShare" }),
    client.readContract({ ...read, functionName: "highWaterMark" }),
    client.readContract({ ...read, functionName: "drawdownBps" }),
    client.readContract({ ...read, functionName: "halted" }),
    client.readContract({ ...read, functionName: "buysToday" }),
    client.readContract({ ...read, functionName: "currentDay" }),
    client.readContract({ ...read, functionName: "lastBuyAt" }),
    client.readContract({ ...read, functionName: "policy" }),
    client.readContract({ ...read, functionName: "positions" }),
  ]);

  const stops = await Promise.all(
    positions.map((p) => client.readContract({ ...read, functionName: "stopLossReached", args: [p.asset] })),
  );

  const blockTimestamp = Number(block.timestamp);
  const known: PositionState[] = [];
  positions.forEach((p, i) => {
    const info = assetByAddress(p.asset);
    // An asset the agent has no market data for is left to the owner.
    if (!info) return;
    known.push({
      symbol: info.symbol,
      address: p.asset,
      enabled: p.enabled,
      balance: p.balance,
      value: p.value,
      cost: p.cost,
      lockedUntil: Number(p.lockedUntil),
      stopLossReached: stops[i]!,
    });
  });

  const policyState: Policy = {
    maxTradeBps: policy.maxTradeBps,
    maxPositionBps: policy.maxPositionBps,
    maxExposureBps: policy.maxExposureBps,
    maxSlippageBps: policy.maxSlippageBps,
    stopLossBps: policy.stopLossBps,
    maxDrawdownBps: policy.maxDrawdownBps,
    maxTradesPerDay: policy.maxTradesPerDay,
    cooldown: policy.cooldown,
    twapWindow: policy.twapWindow,
    reentryLockout: policy.reentryLockout,
  };

  // The vault resets its counter lazily, on the first buy of a new UTC day.
  const today = Math.floor(blockTimestamp / 86_400);
  return {
    vault,
    blockNumber: block.number,
    blockTimestamp,
    owner,
    agent,
    nav,
    idleBase,
    pricePerShare,
    highWaterMark,
    drawdownBps: Number(drawdownBps),
    halted,
    buysToday: Number(currentDay) === today ? buysToday : 0,
    lastBuyAt: Number(lastBuyAt),
    policy: policyState,
    positions: known,
  };
}

/** Pool address of every listed asset, keyed by symbol. */
export async function readPools(client: PublicClient, vault: Address): Promise<Map<string, Address>> {
  const read = { address: vault, abi: agentVaultAbi } as const;
  const list = await client.readContract({ ...read, functionName: "assetList" });
  const configs = await Promise.all(
    list.map((asset) => client.readContract({ ...read, functionName: "assets", args: [asset] })),
  );
  const pools = new Map<string, Address>();
  list.forEach((asset, i) => {
    const info = assetByAddress(asset);
    if (info) pools.set(info.symbol, configs[i]![3]);
  });
  return pools;
}
