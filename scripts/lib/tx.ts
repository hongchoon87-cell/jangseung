// Sending transactions over a public RPC that drops a connection now and then. Every step
// is described by what it changes on-chain, so a step whose answer was lost is recognised as
// done instead of being sent twice.
import type { Hex, PublicClient } from "viem";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const firstLine = (error: unknown): string =>
  String((error as { shortMessage?: string }).shortMessage ?? (error as Error).message ?? error).split("\n")[0]!;

/** Repeats a read that failed, waiting a little longer each time. */
export async function retry<T>(read: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1_000 * attempt);
    }
  }
}

/**
 * Makes `done` true by sending a transaction, unless it is true already. When the call
 * fails, the chain is watched for a while first: the transaction may have gone out even
 * though the answer never arrived. Only then is it sent again.
 */
export async function ensure(
  publicClient: PublicClient,
  label: string,
  done: () => Promise<boolean>,
  send: () => Promise<Hex>,
  attempts = 4,
): Promise<void> {
  if (await retry(done)) {
    console.log(`  ${label}: already done`);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const hash = await send();
      const receipt = await retry(() => publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }));
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      console.log(`  ${label}: done for ${receipt.gasUsed.toLocaleString("en-US")} gas`);
      return;
    } catch (error) {
      for (let i = 0; i < 8; i++) {
        await sleep(3_000);
        if (await done().catch(() => false)) {
          console.log(`  ${label}: done (the answer was lost, the chain shows it went through)`);
          return;
        }
      }
      if (attempt >= attempts) throw new Error(`${label} failed: ${firstLine(error)}`);
      console.warn(`  ${label}: ${firstLine(error)}; sending it again`);
    }
  }
}
