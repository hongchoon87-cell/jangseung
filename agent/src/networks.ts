import { getAddress, type Address } from "viem";

export type NetworkName = "mainnet" | "testnet";

/** One HSK Chain network: how to reach it and where HSKSwap, a Uniswap V3 deployment, lives on it. */
export interface NetworkInfo {
  name: NetworkName;
  chainId: number;
  label: string;
  rpcUrl: string;
  explorerUrl: string;
  factory: Address;
  router: Address;
  quoter: Address;
  /** HSKSwap's NonfungiblePositionManager. Only the testnet demo market uses it, to add liquidity. */
  positionManager: Address;
  multicall3: Address;
}

export const NETWORKS: Record<NetworkName, NetworkInfo> = {
  // Chain id 177. Verified on-chain and against the HSKSwap app bundle.
  mainnet: {
    name: "mainnet",
    chainId: 177,
    label: "HSK Chain",
    rpcUrl: "https://mainnet.hsk.xyz",
    explorerUrl: "https://hsk.blockscout.com",
    factory: getAddress("0x972cA9D1662F5e029cD18327D29026532E84c742"),
    router: getAddress("0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3"),
    quoter: getAddress("0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD"),
    positionManager: getAddress("0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5"),
    multicall3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  },
  // Chain id 133. The addresses are the ones the developer page of app.hskswap.com lists
  // for the testnet (read 2026-11-25). On-chain the router, the quoter and the position
  // manager all name this factory.
  testnet: {
    name: "testnet",
    chainId: 133,
    label: "HSK Chain Testnet",
    rpcUrl: "https://testnet.hsk.xyz",
    explorerUrl: "https://testnet-explorer.hskchain.net",
    factory: getAddress("0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0"),
    router: getAddress("0xa6914E66690c6794244B5f66a09eAEbf66254237"),
    quoter: getAddress("0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC"),
    positionManager: getAddress("0x73dEc6bfa6751509b08480bd97f54b874E3b20e8"),
    multicall3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  },
};

/** The WHSK/USDT pool of HSKSwap on mainnet (fee 0.3%). The testnet demo pool follows its price. */
export const MAINNET_WHSK_POOL = getAddress("0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC");
