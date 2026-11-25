import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networkFromEnv, tokensFromEnv } from "../src/config.ts";
import { NETWORKS } from "../src/networks.ts";

describe("network settings", () => {
  // The two test tokens a rehearsal on a fork of the testnet deployed.
  const testTokens = {
    TEST_WHSK_ADDRESS: "0x07a24459bCdF38339d04a1685ca7eC5e0b4277f7",
    TEST_USDT_ADDRESS: "0xa3e785b24859393BaE92E10a837A4c7fD2bD467a",
  };

  it("is mainnet with the real tokens unless told otherwise", () => {
    assert.equal(networkFromEnv({}).name, "mainnet");
    assert.equal(networkFromEnv({ HSK_NETWORK: "" }).chainId, 177);

    const tokens = tokensFromEnv(NETWORKS.mainnet, testTokens);
    assert.equal(tokens.usdt, "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029");
    assert.deepEqual(tokens.assets.map((asset) => asset.symbol), ["WHSK", "WETH", "WBTC"]);
    assert.equal(tokens.assets[0]!.address, "0xB210D2120d57b758EE163cFfb43e73728c471Cf1");
  });

  it("uses the testnet's own exchange and the test tokens named in the environment", () => {
    const network = networkFromEnv({ HSK_NETWORK: "testnet" });
    assert.equal(network.chainId, 133);
    assert.equal(network.factory, "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0");

    const tokens = tokensFromEnv(network, testTokens);
    assert.equal(tokens.usdt, testTokens.TEST_USDT_ADDRESS);
    // One asset, shaped like the real WHSK so every price formula stays the same.
    assert.deepEqual(tokens.assets, [{ symbol: "WHSK", address: testTokens.TEST_WHSK_ADDRESS, decimals: 18, fee: 3000, ticker: "HSK" }]);
  });

  it("refuses a testnet run that has no test tokens yet", () => {
    assert.throws(() => tokensFromEnv(NETWORKS.testnet, {}), /TEST_USDT_ADDRESS is not set/);
    assert.throws(() => tokensFromEnv(NETWORKS.testnet, { TEST_USDT_ADDRESS: testTokens.TEST_USDT_ADDRESS }), /TEST_WHSK_ADDRESS is not set/);
    assert.throws(() => tokensFromEnv(NETWORKS.testnet, { ...testTokens, TEST_WHSK_ADDRESS: "0x1234" }), /TEST_WHSK_ADDRESS is not set/);
  });

  it("refuses a network it does not know", () => {
    assert.throws(() => networkFromEnv({ HSK_NETWORK: "sepolia" }), /must be "mainnet" or "testnet"/);
  });

  it("keeps the two networks' exchange contracts apart", () => {
    for (const key of ["factory", "router", "quoter", "positionManager"] as const) {
      assert.notEqual(NETWORKS.mainnet[key], NETWORKS.testnet[key], key);
    }
    assert.notEqual(NETWORKS.mainnet.chainId, NETWORKS.testnet.chainId);
  });
});
