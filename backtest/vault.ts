// AgentVault.sol in TypeScript, for one asset, so the backtest runs under the same limits
// the contract enforces. Every check, its order and its rounding follow the contract;
// function names match so the two can be read side by side.
import type { Policy } from "../agent/src/types.ts";
import { maxInputAboveFloor, quoteAtTick } from "./math.ts";
import { simulateSwap, type PoolView } from "./pool.ts";

const BPS = 10_000n;
export const PPS_ONE = 10n ** 18n;

/** A call the contract would have reverted. `name` is the contract's error name. */
export class VaultRevert extends Error {
  readonly args: readonly (bigint | number)[];

  constructor(name: string, args: readonly (bigint | number)[] = []) {
    super(`vault rejected the call: ${name}(${args.join(", ")})`);
    this.name = name;
    this.args = args;
  }
}

export interface TradeReceipt {
  baseAmount: bigint;
  assetAmount: bigint;
  realizedPnl: bigint;
  navAfter: bigint;
  pricePerShareAfter: bigint;
}

interface VaultState {
  idleBase: bigint;
  balance: bigint;
  costBasis: bigint;
  lockedUntil: number;
  totalShares: bigint;
  highWaterMark: bigint;
  halted: boolean;
  lastBuyAt: number;
  currentDay: number;
  buysToday: number;
}

export class SimVault {
  readonly policy: Policy;
  private readonly pool: PoolView;
  private readonly feePips: number;
  /** The newest swap not yet collected by `takeSwap`: where it left the pool's price. */
  private lastSwap: { at: number; sqrtPriceAfter: bigint } | undefined;
  private state: VaultState = {
    idleBase: 0n,
    balance: 0n,
    costBasis: 0n,
    lockedUntil: 0,
    totalShares: 0n,
    highWaterMark: PPS_ONE,
    halted: false,
    lastBuyAt: 0,
    currentDay: 0,
    buysToday: 0,
  };

  constructor(policy: Policy, pool: PoolView, feePips: number) {
    this.policy = policy;
    this.pool = pool;
    this.feePips = feePips;
  }

  // ----------------------------------------------------------------- views

  get idleBase(): bigint {
    return this.state.idleBase;
  }
  get balance(): bigint {
    return this.state.balance;
  }
  get costBasis(): bigint {
    return this.state.costBasis;
  }
  get lockedUntil(): number {
    return this.state.lockedUntil;
  }
  get highWaterMark(): bigint {
    return this.state.highWaterMark;
  }
  get halted(): boolean {
    return this.state.halted;
  }
  get lastBuyAt(): number {
    return this.state.lastBuyAt;
  }
  get currentDay(): number {
    return this.state.currentDay;
  }
  get buysToday(): number {
    return this.state.buysToday;
  }

  /** Mean tick over the policy's window. The pool's oracle reverts when it holds no price that old. */
  private meanTick(now: number): number {
    if (!this.pool.canObserve(now, this.policy.twapWindow)) throw new VaultRevert("OLD");
    return this.pool.meanTick(now, this.policy.twapWindow);
  }

  /** What `amount` of the asset is worth in base token at the TWAP, before fees. */
  private twapValue(amount: bigint, now: number): bigint {
    return quoteAtTick(this.meanTick(now), amount, true);
  }

  /** Worth of the position at the TWAP; zero without reading the pool when nothing is held. */
  positionValue(now: number): bigint {
    return this.state.balance === 0n ? 0n : this.twapValue(this.state.balance, now);
  }

  nav(now: number): bigint {
    return this.state.idleBase + this.positionValue(now);
  }

  private pps(navNow: bigint): bigint {
    return this.state.totalShares === 0n ? PPS_ONE : (navNow * PPS_ONE) / this.state.totalShares;
  }

  pricePerShare(now: number): bigint {
    return this.pps(this.nav(now));
  }

  drawdownBps(now: number): number {
    const pps = this.pricePerShare(now);
    const peak = this.state.highWaterMark;
    return pps >= peak ? 0 : Number(((peak - pps) * BPS) / peak);
  }

  stopLossReached(now: number): boolean {
    if (this.state.balance === 0n) return false;
    return this.positionValue(now) < (this.state.costBasis * (BPS - BigInt(this.policy.stopLossBps))) / BPS;
  }

  // --------------------------------------------------------------- owner

  deposit(amount: bigint, now: number): void {
    if (amount === 0n) throw new VaultRevert("ZeroAmount");
    const navBefore = this.nav(now);
    if (this.state.totalShares !== 0n && navBefore === 0n) {
      this.state.totalShares = 0n;
      this.state.highWaterMark = PPS_ONE;
    }
    const shares = this.state.totalShares === 0n ? amount : (amount * this.state.totalShares) / navBefore;
    if (shares === 0n) throw new VaultRevert("ZeroAmount");
    this.state.totalShares += shares;
    this.state.idleBase += amount;
  }

  // ------------------------------------------------------------- trading

  /** Runs `call`; if it reverts, every state change it made is undone, as on-chain. */
  private atomically<T>(call: () => T): T {
    const before = { ...this.state };
    const swapBefore = this.lastSwap;
    try {
      return call();
    } catch (error) {
      this.state = before;
      this.lastSwap = swapBefore;
      throw error;
    }
  }

  /**
   * The price the vault's last swap left the pool at, once. The caller passes it on to
   * the pool model so later quotes start from there.
   */
  takeSwap(): { at: number; sqrtPriceAfter: bigint } | undefined {
    const swap = this.lastSwap;
    this.lastSwap = undefined;
    return swap;
  }

  /**
   * Runs `call` and then undoes it, like eth_call: the result or the revert is real, the
   * state is left untouched. The live agent simulates every transaction this way first.
   */
  preview<T>(call: () => T): T {
    const before = { ...this.state };
    const swapBefore = this.lastSwap;
    try {
      return call();
    } finally {
      this.state = before;
      this.lastSwap = swapBefore;
    }
  }

  /**
   * @returns the receipt, or `undefined` when this call tripped the drawdown breaker and
   * bought nothing (the contract returns 0 and keeps the halt).
   */
  buy(baseIn: bigint, minAssetOut: bigint, now: number): TradeReceipt | undefined {
    return this.atomically(() => {
      if (baseIn === 0n) throw new VaultRevert("ZeroAmount");
      if (now < this.state.lockedUntil) throw new VaultRevert("AssetLocked", [this.state.lockedUntil]);
      if (this.state.halted) throw new VaultRevert("Halted");

      if (this.checkBuyLimits(baseIn, now)) return undefined;
      this.consumeBuySlot(now);

      const minOut = max(minAssetOut, this.twapFloor(baseIn, false, now));
      const assetOut = this.swap("buy", baseIn, minOut, now);
      this.state.costBasis += baseIn;
      return this.recordTrade(baseIn, assetOut, 0n, now);
    });
  }

  sell(assetIn: bigint, minBaseOut: bigint, now: number): TradeReceipt {
    return this.atomically(() => {
      if (assetIn === 0n) throw new VaultRevert("ZeroAmount");
      const { baseOut, pnl } = this.sellInternal(assetIn, minBaseOut, now);
      return this.recordTrade(baseOut, assetIn, pnl, now);
    });
  }

  /**
   * @param assetIn how much to sell; more than is held means all of it, and 0 means as
   * much as the pool can take inside the slippage limit right now.
   */
  triggerStopLoss(assetIn: bigint, now: number): TradeReceipt {
    return this.atomically(() => {
      const balance = this.state.balance;
      if (balance === 0n) throw new VaultRevert("NothingToSell");

      const value = this.twapValue(balance, now);
      const threshold = (this.state.costBasis * (BPS - BigInt(this.policy.stopLossBps))) / BPS;
      if (value >= threshold) throw new VaultRevert("StopLossNotReached", [value, threshold]);

      const amount = this.saleAmount(assetIn, balance, now);
      const { baseOut, pnl } = this.sellInternal(amount, 0n, now);
      this.state.lockedUntil = now + this.policy.reentryLockout;
      return this.recordTrade(baseOut, amount, pnl, now);
    });
  }

  flatten(assetIn: bigint, now: number): TradeReceipt {
    return this.atomically(() => {
      if (!this.state.halted) throw new VaultRevert("NotHalted");
      const balance = this.state.balance;
      if (balance === 0n) throw new VaultRevert("NothingToSell");
      const amount = this.saleAmount(assetIn, balance, now);
      const { baseOut, pnl } = this.sellInternal(amount, 0n, now);
      return this.recordTrade(baseOut, amount, pnl, now);
    });
  }

  /** Largest amount one sale can put through the pool inside the slippage limit, capped at the balance. */
  maxSellNow(now: number): bigint {
    const balance = this.state.balance;
    if (balance === 0n) return 0n;
    const room = this.maxSell(now);
    return room < balance ? room : balance;
  }

  /** Raises the high-water mark or trips the breaker. Returns whether buying is halted. */
  checkpoint(now: number): boolean {
    return this.atomically(() => this.checkpointAt(this.nav(now)));
  }

  /** Owner only: clears a tripped breaker and measures drawdown from the current NAV. */
  resume(now: number): void {
    if (!this.state.halted) throw new VaultRevert("NotHalted");
    this.state.halted = false;
    this.state.highWaterMark = this.pricePerShare(now);
  }

  // ------------------------------------------------------------ internal

  /** The contract's `_maxSell`: a tenth of the slippage allowance is kept back. */
  private maxSell(now: number): bigint {
    const allowance = BigInt(this.policy.maxSlippageBps);
    const usable = allowance - allowance / 10n;
    const state = this.pool.stateAt(now);
    // The asset is the pool's token0 in every pool the backtest covers.
    return maxInputAboveFloor(state.sqrtPriceX96, state.liquidity, this.meanTick(now), true, this.feePips, BPS - usable);
  }

  /** The contract's `_saleAmount`. */
  private saleAmount(requested: bigint, balance: bigint, now: number): bigint {
    let amount = requested;
    if (amount === 0n) {
      amount = this.maxSell(now);
      if (amount === 0n) throw new VaultRevert("NoRoomToSell");
    }
    return amount > balance ? balance : amount;
  }

  private checkpointAt(navNow: bigint): boolean {
    if (this.state.halted) return true;
    if (this.state.totalShares === 0n) return false;

    const pps = this.pps(navNow);
    const peak = this.state.highWaterMark;
    if (pps > peak) {
      this.state.highWaterMark = pps;
    } else if (pps < (peak * (BPS - BigInt(this.policy.maxDrawdownBps))) / BPS) {
      this.state.halted = true;
      return true;
    }
    return false;
  }

  private checkBuyLimits(baseIn: bigint, now: number): boolean {
    const positionValue = this.positionValue(now);
    // One asset, so the position is the whole exposure.
    const exposure = positionValue;
    const navBefore = this.state.idleBase + exposure;
    if (navBefore === 0n) throw new VaultRevert("EmptyVault");
    if (this.checkpointAt(navBefore)) return true;

    let limit = (navBefore * BigInt(this.policy.maxTradeBps)) / BPS;
    if (baseIn > limit) throw new VaultRevert("TradeTooLarge", [baseIn, limit]);
    limit = (navBefore * BigInt(this.policy.maxPositionBps)) / BPS;
    if (positionValue + baseIn > limit) throw new VaultRevert("PositionTooLarge", [positionValue + baseIn, limit]);
    limit = (navBefore * BigInt(this.policy.maxExposureBps)) / BPS;
    if (exposure + baseIn > limit) throw new VaultRevert("ExposureTooLarge", [exposure + baseIn, limit]);
    return false;
  }

  /** Least acceptable output: the TWAP quote less the slippage allowance. */
  private twapFloor(amountIn: bigint, assetIn: boolean, now: number): bigint {
    return (quoteAtTick(this.meanTick(now), amountIn, assetIn) * (BPS - BigInt(this.policy.maxSlippageBps))) / BPS;
  }

  private consumeBuySlot(now: number): void {
    const { lastBuyAt } = this.state;
    if (lastBuyAt !== 0 && now < lastBuyAt + this.policy.cooldown) {
      throw new VaultRevert("CooldownActive", [lastBuyAt + this.policy.cooldown]);
    }
    const day = Math.floor(now / 86_400);
    if (day !== this.state.currentDay) {
      this.state.currentDay = day;
      this.state.buysToday = 0;
    }
    if (this.state.buysToday >= this.policy.maxTradesPerDay) throw new VaultRevert("DailyLimitReached");
    this.state.buysToday += 1;
    this.state.lastBuyAt = now;
  }

  private sellInternal(assetIn: bigint, minBaseOut: bigint, now: number): { baseOut: bigint; pnl: bigint } {
    const balance = this.state.balance;
    if (assetIn > balance) throw new VaultRevert("InsufficientAsset");

    const minOut = max(minBaseOut, this.twapFloor(assetIn, true, now));
    const baseOut = this.swap("sell", assetIn, minOut, now);

    const costRemoved = (this.state.costBasis * assetIn) / balance;
    this.state.costBasis -= costRemoved;
    return { baseOut, pnl: baseOut - costRemoved };
  }

  /** Swaps against the pool as it stands at `now` and moves the balances. */
  private swap(side: "buy" | "sell", amountIn: bigint, minOut: bigint, now: number): bigint {
    if (side === "buy" && amountIn > this.state.idleBase) throw new VaultRevert("InsufficientBase");
    const { amountOut: received, sqrtPriceAfter } = simulateSwap(this.pool.stateAt(now), side, amountIn, this.feePips);
    if (received < minOut) throw new VaultRevert("Slippage", [received, minOut]);
    this.lastSwap = { at: now, sqrtPriceAfter };

    if (side === "buy") {
      this.state.idleBase -= amountIn;
      this.state.balance += received;
    } else {
      this.state.balance -= amountIn;
      this.state.idleBase += received;
    }
    return received;
  }

  private recordTrade(baseAmount: bigint, assetAmount: bigint, realizedPnl: bigint, now: number): TradeReceipt {
    const navAfter = this.nav(now);
    this.checkpointAt(navAfter);
    return { baseAmount, assetAmount, realizedPnl, navAfter, pricePerShareAfter: this.pps(navAfter) };
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
