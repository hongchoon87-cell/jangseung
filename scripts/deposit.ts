// Deposits USDT into the vault as its owner.
//
//   AMOUNT_USDT=50 npm run deposit:hsk
//
// Uses the same key as the deployment (Hardhat keystore entry HSK_DEPLOYER_KEY), which
// must be the vault's owner. VAULT_ADDRESS is read from the environment or .env.
import { network } from "hardhat";
import { formatUnits, getAddress, isAddressEqual, parseAbi, parseUnits } from "viem";

import { ADDRESSES, BASE, config } from "../agent/src/config.ts";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

if (!config.vault) throw new Error("Set VAULT_ADDRESS to the deployed vault.");
const amountText = process.env.AMOUNT_USDT;
if (!amountText || !(Number(amountText) > 0)) throw new Error("Set AMOUNT_USDT to the amount to deposit, e.g. AMOUNT_USDT=50.");
const amount = parseUnits(amountText, BASE.decimals);

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner] = await viem.getWalletClients();
if (!owner) throw new Error("No account is configured for this network.");

const vault = await viem.getContractAt("AgentVault", config.vault);
const vaultOwner = (await vault.read.owner()) as `0x${string}`;
if (!isAddressEqual(vaultOwner, owner.account.address)) {
  throw new Error(`This key is ${getAddress(owner.account.address)} but the vault's owner is ${vaultOwner}.`);
}

const balance = await publicClient.readContract({ address: ADDRESSES.usdt, abi: erc20, functionName: "balanceOf", args: [owner.account.address] });
if (balance < amount) throw new Error(`The owner holds ${formatUnits(balance, BASE.decimals)} USDT, less than the ${amountText} requested.`);

const wait = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });
await wait(await owner.writeContract({ address: ADDRESSES.usdt, abi: erc20, functionName: "approve", args: [config.vault, amount] }));
await wait(await vault.write.deposit([amount]));

console.log(`Deposited ${amountText} USDT. Vault NAV is now ${formatUnits((await vault.read.nav()) as bigint, BASE.decimals)} USDT.`);
