import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

const HSK_MAINNET_RPC = process.env.HSK_RPC_URL ?? "https://mainnet.hsk.xyz";
const HSK_TESTNET_RPC = process.env.HSK_TESTNET_RPC_URL ?? "https://testnet.hsk.xyz";

// Fork tests pin this block so results are reproducible and RPC responses are cached.
const FORK_BLOCK = 30_581_400;

// Tests and deployments use the same compiler settings, so the bytecode that is
// tested is the bytecode that ships. Cancun is the newest EVM version we rely on;
// HSK Chain (OP Stack) activated it long before the pinned block.
const compiler = {
  version: "0.8.28",
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
  },
};

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: compiler,
      production: compiler,
    },
  },
  chainDescriptors: {
    177: {
      name: "HSK Chain",
      chainType: "op",
      blockExplorers: {
        blockscout: {
          name: "HSK Chain Blockscout",
          url: "https://hsk.blockscout.com",
          apiUrl: "https://hsk.blockscout.com/api",
        },
      },
    },
    133: {
      name: "HSK Chain Testnet",
      chainType: "op",
      // Hardhat's simulator carries the upgrade history of HSK Chain mainnet but not of the
      // testnet, and will not fork a chain without one. The testnet is only ever forked at
      // its current head, where the newest upgrade the simulator supports applies, so that
      // one is declared active from the first block. This fork must not be used to replay
      // old testnet blocks.
      hardforkHistory: { isthmus: { blockNumber: 0 } },
      blockExplorers: {
        // Some pages name testnet-explorer.hsk.xyz, which had no DNS record on 2026-11-25.
        blockscout: {
          name: "HSK Chain Testnet Explorer",
          url: "https://testnet-explorer.hskchain.net",
          apiUrl: "https://testnet-explorer.hskchain.net/api",
        },
      },
    },
  },
  networks: {
    // In-process simulation of HSK Chain mainnet state at FORK_BLOCK.
    hskFork: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 177,
      forking: {
        url: HSK_MAINNET_RPC,
        // FORK_LATEST=1 forks the current head, for demos that compare against live prices.
        ...(process.env.FORK_LATEST === "1" ? {} : { blockNumber: FORK_BLOCK }),
      },
    },
    // In-process simulation of the HSK Chain testnet at its current head, to rehearse the
    // testnet demo market (npm run testnet:fork).
    hskTestnetFork: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 133,
      forking: { url: HSK_TESTNET_RPC },
    },
    // A fork node started with `npx hardhat node --network hskFork` (or hskTestnetFork).
    localhost: {
      type: "http",
      chainType: "op",
      url: "http://127.0.0.1:8545",
    },
    hsk: {
      type: "http",
      chainType: "op",
      chainId: 177,
      url: HSK_MAINNET_RPC,
      accounts: [configVariable("HSK_DEPLOYER_KEY")],
    },
    // Mainnet without a key, for tasks that only read, such as source verification. Using
    // it never asks for the keystore password.
    hskRead: {
      type: "http",
      chainType: "op",
      chainId: 177,
      url: HSK_MAINNET_RPC,
    },
    // The testnet never sees the mainnet owner key. Its two keys are made for the testnet
    // only and live in .env.testnet (npm run testnet:keys): the vault's owner, and the
    // operator of the demo market.
    hskTestnet: {
      type: "http",
      chainType: "op",
      chainId: 133,
      url: HSK_TESTNET_RPC,
      accounts: [configVariable("TESTNET_OWNER_KEY"), configVariable("TESTNET_MARKET_KEY")],
    },
    // Testnet without a key, for source verification.
    hskTestnetRead: {
      type: "http",
      chainType: "op",
      chainId: 133,
      url: HSK_TESTNET_RPC,
    },
  },
  test: {
    solidity: {
      // Lets fork tests call vm.createSelectFork("hsk", block).
      forking: {
        rpcEndpoints: { hsk: HSK_MAINNET_RPC, hskTestnet: HSK_TESTNET_RPC },
      },
      fuzz: { runs: 128 },
    },
  },
});
