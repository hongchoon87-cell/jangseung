import { keccak256, parseEventLogs, toBytes, type Address, type Hex } from "viem";

import { agentVaultAbi } from "./abi/agentVault.ts";
import type { ChainClients } from "./chain.ts";
import { assetBySymbol, config } from "./config.ts";
import { quote, type Quote } from "./gate.ts";
import { canonicalJson } from "./store.ts";
import type { Candidate, DecisionRecord, Execution, GateVerdict } from "./types.ts";

/** How far the price may drift between the gate's quote and the transaction. */
export const DRIFT_TOLERANCE_BPS = 30;

/**
 * The vault's permissionless safety functions. The amount passed to `triggerStopLoss` is
 * how much of the asset to sell; 0 lets the vault sell as much as the pool can take.
 */
export type SafetyCall = { functionName: "triggerStopLoss"; args: [Address, bigint] } | { functionName: "checkpoint"; args: [] };

/**
 * Compares a fresh quote with the one the gate saw. Gives the least output the transaction
 * should accept, or the reason to skip it when the price has moved against the trade.
 */
export function guardAgainstDrift(
  side: "buy" | "sell",
  gatePrice: number | undefined,
  fresh: Quote,
): { minOut: bigint } | { skip: string } {
  if (gatePrice) {
    const drift = (side === "buy" ? fresh.effectivePrice / gatePrice - 1 : 1 - fresh.effectivePrice / gatePrice) * 10_000;
    if (drift > DRIFT_TOLERANCE_BPS) {
      return { skip: `price moved ${drift.toFixed(0)} bps against the trade since the gate's quote` };
    }
  }
  return { minOut: (fresh.amountOut * BigInt(10_000 - DRIFT_TOLERANCE_BPS)) / 10_000n };
}

/** Hash that ties a transaction to the decision record kept off-chain. */
export function memoFor(record: Omit<DecisionRecord, "memo" | "execution">): Hex {
  return keccak256(toBytes(canonicalJson(record)));
}

/** One line describing a failure, naming the vault's custom error and its arguments when there is one. */
function firstLine(error: unknown): string {
  const e = error as {
    shortMessage?: string;
    message?: string;
    walk?: (fn: (inner: unknown) => boolean) => unknown;
  };
  const decoded = e.walk?.((inner) => (inner as { data?: { errorName?: string } }).data?.errorName !== undefined) as
    | { data: { errorName: string; args?: readonly unknown[] } }
    | undefined;
  if (decoded) {
    const args = (decoded.data.args ?? []).map(String).join(", ");
    return `vault rejected the call: ${decoded.data.errorName}(${args})`;
  }
  const reason = (error as { cause?: { reason?: string } }).cause?.reason;
  if (reason) return `reverted: ${reason}`;
  return (e.shortMessage ?? e.message ?? String(error)).split("\n")[0]!;
}

/**
 * Stage 4 of the pipeline. Takes a fresh quote for the final size, refuses if the price
 * moved since the gate looked, then sends the trade through the vault, which applies its
 * own limits. Without a key, or in dry-run mode, the call is only simulated.
 */
export async function executeTrade(
  clients: ChainClients,
  vault: Address,
  operator: Address,
  candidate: Candidate,
  amountIn: bigint,
  gate: GateVerdict,
  memo: Hex,
): Promise<Execution> {
  const asset = assetBySymbol(candidate.symbol);
  if (!asset) return { status: "failed", error: `unknown asset ${candidate.symbol}` };

  let fresh;
  try {
    fresh = await quote(clients.publicClient, asset, candidate.side, amountIn);
  } catch (error) {
    return { status: "failed", error: `re-quote failed: ${firstLine(error)}` };
  }

  const guard = guardAgainstDrift(candidate.side, gate.effectivePrice, fresh);
  if ("skip" in guard) return { status: "skipped", error: guard.skip };
  const { minOut } = guard;

  const call = {
    address: vault,
    abi: agentVaultAbi,
    functionName: candidate.side,
    args: [asset.address, amountIn, minOut, memo],
  } as const;

  try {
    const { request, result } = await clients.publicClient.simulateContract({
      ...call,
      account: clients.account ?? operator,
    });

    if (config.dryRun || !clients.walletClient) {
      return candidate.side === "buy"
        ? { status: "dry-run", baseAmount: amountIn, assetAmount: result }
        : { status: "dry-run", baseAmount: result, assetAmount: amountIn };
    }

    const txHash = await clients.walletClient.writeContract(request);
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") {
      return { status: "failed", txHash, blockNumber: receipt.blockNumber, error: "transaction reverted" };
    }

    const [trade] = parseEventLogs({ abi: agentVaultAbi, logs: receipt.logs, eventName: "Trade" });
    return {
      status: "sent",
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      // A buy that returns no Trade event latched the drawdown breaker instead of trading.
      baseAmount: trade?.args.baseAmount ?? 0n,
      assetAmount: trade?.args.assetAmount ?? 0n,
      realizedPnl: trade?.args.realizedPnl,
    };
  } catch (error) {
    return { status: "failed", error: firstLine(error) };
  }
}

/** Calls one of the vault's permissionless safety functions. */
export async function runSafetyCall(
  clients: ChainClients,
  vault: Address,
  operator: Address,
  call: SafetyCall,
): Promise<Execution> {
  try {
    const { request } = await clients.publicClient.simulateContract({
      address: vault,
      abi: agentVaultAbi,
      ...call,
      account: clients.account ?? operator,
    });
    if (config.dryRun || !clients.walletClient) return { status: "dry-run" };

    const txHash = await clients.walletClient.writeContract(request);
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") return { status: "failed", txHash, error: "transaction reverted" };

    const [trade] = parseEventLogs({ abi: agentVaultAbi, logs: receipt.logs, eventName: "Trade" });
    return {
      status: "sent",
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      baseAmount: trade?.args.baseAmount,
      assetAmount: trade?.args.assetAmount,
      realizedPnl: trade?.args.realizedPnl,
    };
  } catch (error) {
    return { status: "failed", error: firstLine(error) };
  }
}
