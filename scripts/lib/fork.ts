import { encodeAbiParameters, keccak256, numberToHex, parseAbi, type Address, type PublicClient, type TestClient } from "viem";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * Gives `to` a token balance on a local fork by writing the token's storage directly.
 * It looks for the balance mapping among the first storage slots and checks the result
 * through balanceOf, restoring any slot that turned out not to be the balance.
 */
export async function dealErc20(
  testClient: TestClient,
  publicClient: PublicClient,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  const balanceOf = () => publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [to] });

  for (let slot = 0n; slot < 16n; slot++) {
    const index = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, slot]));
    const previous = (await publicClient.getStorageAt({ address: token, slot: index })) ?? numberToHex(0n, { size: 32 });
    await testClient.setStorageAt({ address: token, index, value: numberToHex(amount, { size: 32 }) });
    if ((await balanceOf()) === amount) return;
    await testClient.setStorageAt({ address: token, index, value: previous });
  }
  throw new Error(`Could not find the balance slot of token ${token}.`);
}
