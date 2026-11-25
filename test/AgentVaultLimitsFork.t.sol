// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {Test} from "forge-std/Test.sol";

import {AgentVault} from "../contracts/AgentVault.sol";
import {ISwapRouter02} from "../contracts/interfaces/ISwapRouter02.sol";

interface IWrappedNativeToken {
    function deposit() external payable;
}

/// @notice Two ways the first version of the vault could fail, both found by the backtest,
/// and the proof against the real HSKSwap pool that they are fixed.
///
/// 1. A pool whose oracle keeps a single observation loses its price history in every swap,
///    the vault's own included, so the vault could not value itself right after buying.
///    Listing an asset now enlarges the pool's oracle first.
/// 2. The stop-loss sold the whole position in one swap under the 1% limit against the TWAP,
///    so it could not fire for a position too large for the pool. It now sells what fits.
contract AgentVaultLimitsForkTest is Test {
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742;
    address internal constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address internal constant POOL_WHSK = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    uint24 internal constant FEE = 3000;

    /// 2026-10-25 14:42 UTC. The pool held about 220,000 USDT a side, had last traded 20
    /// minutes earlier, and its price oracle still kept a single observation (it was
    /// enlarged to 16 on 2026-10-26 and to 240 on 2026-10-31).
    uint256 internal constant SINGLE_SLOT_BLOCK = 29_296_115;
    /// The block the main fork tests use: 240 observations, about 420,000 USDT a side.
    uint256 internal constant DEEP_POOL_BLOCK = 30_581_400;

    address internal owner = address(0xA11CE);
    address internal agent = address(0xB0B);
    address internal stranger = address(0xCAFE);
    address internal whale = address(0xBEEF);

    AgentVault internal vault;

    function _deploy(uint256 deposit) internal {
        vault = new AgentVault(
            owner,
            agent,
            USDT,
            ROUTER,
            FACTORY,
            AgentVault.Policy({
                maxTradeBps: 1000,
                maxPositionBps: 3000,
                maxExposureBps: 6000,
                maxSlippageBps: 100,
                stopLossBps: 500,
                maxDrawdownBps: 1000,
                maxTradesPerDay: 12,
                cooldown: 0,
                twapWindow: 300,
                reentryLockout: 1 hours
            })
        );
        deal(USDT, owner, deposit);
        vm.startPrank(owner);
        vault.configureAsset(WHSK, FEE, true);
        IERC20(USDT).approve(address(vault), type(uint256).max);
        vault.deposit(deposit);
        vm.stopPrank();
    }

    function _wait() internal {
        skip(301);
        vm.roll(block.number + 151);
    }

    /// Wraps `amount` of native HSK for the whale.
    function _whaleWraps(uint256 amount) internal {
        vm.deal(whale, amount);
        vm.prank(whale);
        IWrappedNativeToken(WHSK).deposit{value: amount}();
    }

    function _whaleSells(uint256 amount) internal {
        _whaleWraps(amount);
        vm.startPrank(whale);
        IERC20(WHSK).approve(ROUTER, type(uint256).max);
        ISwapRouter02(ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WHSK,
                tokenOut: USDT,
                fee: FEE,
                recipient: whale,
                amountIn: amount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    function _lookBackFiveMinutes() internal view returns (int56[] memory tickCumulatives) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = 300;
        (tickCumulatives,) = IUniswapV3Pool(POOL_WHSK).observe(secondsAgos);
    }

    // ------------------------------------------------------- price history

    /// The pool as it really was: one swap, and it can no longer say what its price was five
    /// minutes ago. Nothing of ours is involved here; this is why the fix is needed.
    function test_Fork_ASingleSlotOracleForgetsItsHistoryInEverySwap() public {
        vm.createSelectFork("hsk", SINGLE_SLOT_BLOCK);
        (,,, uint16 cardinality, uint16 next,,) = IUniswapV3Pool(POOL_WHSK).slot0();
        assertEq(cardinality, 1);
        assertEq(next, 1);
        _lookBackFiveMinutes();

        // 2,000 WHSK, about 160 USDT: enough to move the pool by a few ticks.
        _whaleSells(2_000 ether);

        vm.expectRevert(bytes("OLD"));
        this.lookBackFiveMinutes();
    }

    function lookBackFiveMinutes() external view {
        _lookBackFiveMinutes();
    }

    /// Listing the asset enlarges the oracle first, so the vault's own swap no longer erases
    /// the history that its valuation right afterwards needs.
    function test_Fork_ListingEnlargesASingleSlotOracleAndTheVaultTrades() public {
        vm.createSelectFork("hsk", SINGLE_SLOT_BLOCK);
        _deploy(1_000e6);

        (,,, uint16 cardinality, uint16 next,,) = IUniswapV3Pool(POOL_WHSK).slot0();
        assertEq(cardinality, 1, "the pool grows with the next observation it writes");
        assertEq(next, 151, "a 300-second window: one observation per 2-second block, plus one");

        vm.prank(agent);
        uint256 bought = vault.buy(WHSK, 50e6, 0, bytes32(0));
        assertGt(bought, 0);
        (,,, cardinality,,,) = IUniswapV3Pool(POOL_WHSK).slot0();
        assertEq(cardinality, 151);
        assertApproxEqRel(vault.nav(), 999.85e6, 1e15);

        // One block later the vault can still value itself and trade again.
        skip(2);
        vm.roll(block.number + 1);
        assertGt(vault.pricePerShare(), 0);
        vm.prank(agent);
        assertGt(vault.sell(WHSK, bought, 0, bytes32(0)), 49e6);
    }

    // ---------------------------------------------------------- large sales

    /// The vault's estimate of what one sale can put through the pool, against the real pool
    /// and router: that much is accepted, a third more is not.
    function test_Fork_MaxSellNowIsWhatTheRealPoolAccepts() public {
        vm.createSelectFork("hsk", DEEP_POOL_BLOCK);
        _deploy(1_000e6);

        // Hand the vault far more WHSK than the pool can take in one sale.
        _whaleWraps(10_000_000 ether);
        vm.prank(whale);
        IERC20(WHSK).transfer(address(vault), 10_000_000 ether);

        uint256 fits = vault.maxSellNow(WHSK);
        uint256 worth = vault.twapQuote(WHSK, USDT, fits);
        emit log_named_uint("maxSellNow, in WHSK wei", fits);
        emit log_named_decimal_uint("worth at the TWAP, USDT", worth, 6);
        assertLt(fits, 10_000_000 ether);
        // About 0.6% of the roughly 420,000 USDT the pool holds.
        assertApproxEqRel(worth, 2_550e6, 5e16);

        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.sell(WHSK, fits * 13 / 10, 0, bytes32(0));

        // The estimate aims 0.9% under the TWAP, a tenth inside the 1% the vault enforces.
        vm.prank(agent);
        uint256 baseOut = vault.sell(WHSK, fits, 0, bytes32(0));
        emit log_named_decimal_uint("received, USDT", baseOut, 6);
        assertGe(baseOut, worth * 9910 / 10_000);
        assertLe(baseOut, worth * 9912 / 10_000);
    }

    /// A position too large for the pool. Selling all of it in one swap is still refused, as
    /// it should be, and the stop-loss closes it over several calls instead.
    function test_Fork_StopLossClosesAPositionTooLargeForThePoolInParts() public {
        vm.createSelectFork("hsk", DEEP_POOL_BLOCK);
        _deploy(200_000e6);

        // Ten buys of 2,000 USDT, five minutes apart so the TWAP follows each one. Every buy
        // stays inside the 1% limit; together they build a 20,000 USDT position.
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(agent);
            vault.buy(WHSK, 2_000e6, 0, bytes32(i));
            _wait();
        }
        uint256 balance = IERC20(WHSK).balanceOf(address(vault));
        assertEq(vault.costBasis(WHSK), 20_000e6);

        // A sell-off takes the price well below what the vault paid.
        _whaleSells(700_000 ether);
        _wait();
        assertTrue(vault.stopLossReached(WHSK), "the position is past its stop-loss at the TWAP");
        emit log_named_decimal_uint("position value at the TWAP, USDT", vault.twapQuote(WHSK, USDT, balance), 6);

        // All of it at once would fill several percent under the TWAP.
        vm.prank(stranger);
        vm.expectRevert(bytes("Too little received"));
        vault.triggerStopLoss(WHSK, balance);

        uint256 fits = vault.maxSellNow(WHSK);
        assertGt(fits, 0);
        assertLt(fits, balance);

        // Anyone can sell what fits, wait for the TWAP to follow, and sell the next part.
        uint256 recovered;
        uint256 calls;
        while (IERC20(WHSK).balanceOf(address(vault)) > 0) {
            vm.prank(stranger);
            recovered += vault.triggerStopLoss(WHSK, 0);
            calls += 1;
            assertLt(calls, 30, "the position should be closed in a handful of sales");
            assertEq(vault.lockedUntil(WHSK), block.timestamp + 1 hours);
            _wait();
        }
        emit log_named_uint("stop-loss sales needed", calls);
        emit log_named_decimal_uint("recovered, USDT", recovered, 6);

        assertGt(calls, 3);
        assertEq(vault.costBasis(WHSK), 0);
        assertEq(IERC20(USDT).balanceOf(address(vault)), 180_000e6 + recovered);
        assertEq(IERC20(USDT).balanceOf(stranger), 0, "the caller receives nothing");
    }
}
