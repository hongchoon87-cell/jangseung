import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Importing the executor loads the configuration; keep the model out of it.
process.env.LLM_MODE = "off";
const { gasLimitFor } = await import("../src/executor.ts");

describe("gas limit", () => {
  it("covers a TWAP lookup that costs more in the block the call lands in", () => {
    // HSK testnet, 2026-11-25: a sale was estimated at 193,359 gas and needed 221,303 in
    // its block, because the price-history search was not needed at the estimate's time.
    const limit = gasLimitFor(193_359n);
    assert.ok(limit >= 221_303n, `limit ${limit} is under what the block needed`);
    // Two such lookups can flip in one call.
    assert.ok(limit >= 193_359n + 2n * 28_000n);
  });

  it("is never below the estimate", () => {
    for (const estimate of [0n, 21_000n, 300_000n, 5_000_000n]) {
      assert.ok(gasLimitFor(estimate) >= estimate);
    }
  });
});
