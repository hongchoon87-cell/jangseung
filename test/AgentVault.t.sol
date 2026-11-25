// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {AgentVault} from "../contracts/AgentVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapRouter, MockV3Factory, MockV3Pool} from "./mocks/MockDex.sol";

/// @notice Policy logic of AgentVault against a mock DEX where the spot price (what swaps
/// execute at) and the TWAP (what the vault values things at) can be set independently.
contract AgentVaultTest is Test {
    address internal owner = address(0xA11CE);
    address internal agent = address(0xB0B);
    address internal stranger = address(0xCAFE);

    MockERC20 internal usdt;
    MockERC20 internal whsk;
    MockERC20 internal wbtc;
    MockV3Factory internal factory;
    MockSwapRouter internal router;
    MockV3Pool internal whskPool;
    MockV3Pool internal wbtcPool;
    AgentVault internal vault;

    uint24 internal constant FEE = 3000;
    /// Tick at which 1 WHSK (18 decimals) is worth 0.08 USDT (6 decimals), WHSK as token0.
    int24 internal constant HSK_TICK = -301583;
    /// Tick at which 1 WBTC (8 decimals) is worth 60,000 USDT, WBTC as token0.
    int24 internal constant BTC_TICK = 63972;

    uint256 internal constant DEPOSIT = 1_000e6;

    function setUp() public {
        vm.warp(1_795_000_000);

        usdt = new MockERC20("Tether USD", "USDT", 6);
        whsk = new MockERC20("Wrapped HSK", "WHSK", 18);
        wbtc = new MockERC20("Wrapped BTC", "WBTC", 8);
        factory = new MockV3Factory();
        router = new MockSwapRouter(address(factory));
        whskPool = factory.createPool(address(whsk), address(usdt), FEE);
        wbtcPool = factory.createPool(address(wbtc), address(usdt), FEE);
        _setPrice(whskPool, address(whsk), HSK_TICK, 0, 0);
        _setPrice(wbtcPool, address(wbtc), BTC_TICK, 0, 0);

        vault = new AgentVault(owner, agent, address(usdt), address(router), address(factory), _defaultPolicy());

        usdt.mint(owner, 100_000e6);
        vm.startPrank(owner);
        vault.configureAsset(address(whsk), FEE, true);
        vault.configureAsset(address(wbtc), FEE, true);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(DEPOSIT);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- helpers

    function _defaultPolicy() internal pure returns (AgentVault.Policy memory) {
        return AgentVault.Policy({
            maxTradeBps: 1000,
            maxPositionBps: 3000,
            maxExposureBps: 5000,
            maxSlippageBps: 100,
            stopLossBps: 500,
            maxDrawdownBps: 1000,
            maxTradesPerDay: 3,
            cooldown: 60,
            twapWindow: 300,
            reentryLockout: 1 hours
        });
    }

    /// A policy loose enough on size and frequency to build a 50% exposure quickly.
    function _loosePolicy() internal pure returns (AgentVault.Policy memory p) {
        p = _defaultPolicy();
        p.maxTradeBps = 3000;
        p.maxTradesPerDay = 10;
        p.cooldown = 0;
    }

    /// Sets the asset's price as an offset, in ticks (about 0.01% each), from `baseTick`.
    /// Positive offsets make the asset more expensive whichever way the pool orders its tokens.
    function _setPrice(MockV3Pool pool, address asset, int24 baseTick, int24 spotOffset, int24 twapOffset) internal {
        int24 spot = baseTick + spotOffset;
        int24 twap = baseTick + twapOffset;
        if (asset > address(usdt)) (spot, twap) = (-spot, -twap);
        pool.setTicks(spot, twap);
    }

    function _moveWhsk(int24 offset) internal {
        _setPrice(whskPool, address(whsk), HSK_TICK, offset, offset);
    }

    function _moveWbtc(int24 offset) internal {
        _setPrice(wbtcPool, address(wbtc), BTC_TICK, offset, offset);
    }

    function _buy(address asset, uint256 baseIn) internal returns (uint256) {
        vm.prank(agent);
        return vault.buy(asset, baseIn, 0, bytes32("memo"));
    }

    function _sell(address asset, uint256 assetIn) internal returns (uint256) {
        vm.prank(agent);
        return vault.sell(asset, assetIn, 0, bytes32("memo"));
    }

    /// Builds a 30% WHSK and 20% WBTC book, then drops both by about 25%.
    function _crashHalfTheBook() internal {
        vm.prank(owner);
        vault.setPolicy(_loosePolicy());
        _buy(address(whsk), 300e6);
        _buy(address(wbtc), 200e6);
        _moveWhsk(-2877);
        _moveWbtc(-2877);
    }

    // ------------------------------------------------------------- deposits

    function test_DepositMintsSharesAtPar() public view {
        assertEq(vault.totalShares(), DEPOSIT);
        assertEq(vault.nav(), DEPOSIT);
        assertEq(vault.pricePerShare(), 1e18);
        assertEq(vault.highWaterMark(), 1e18);
    }

    function test_DepositAfterGainsKeepsPricePerShare() public {
        _buy(address(whsk), 100e6);
        _moveWhsk(953); // about +10%
        uint256 ppsBefore = vault.pricePerShare();
        assertGt(ppsBefore, 1e18);

        vm.prank(owner);
        vault.deposit(500e6);

        assertApproxEqRel(vault.pricePerShare(), ppsBefore, 1e12);
        assertLt(vault.totalShares(), DEPOSIT + 500e6, "new shares are issued above par");
    }

    function test_WithdrawKeepsPricePerShare() public {
        _buy(address(whsk), 100e6);
        _moveWhsk(953);
        uint256 ppsBefore = vault.pricePerShare();
        uint256 ownerBefore = usdt.balanceOf(owner);

        vm.prank(owner);
        vault.withdraw(400e6, owner);

        assertEq(usdt.balanceOf(owner), ownerBefore + 400e6);
        assertApproxEqRel(vault.pricePerShare(), ppsBefore, 1e12);
    }

    function test_WithdrawRevertsBeyondIdleBase() public {
        _buy(address(whsk), 100e6);
        vm.prank(owner);
        vm.expectRevert(AgentVault.InsufficientBase.selector);
        vault.withdraw(901e6, owner);
    }

    function test_ExitSendsEverythingAndResets() public {
        _buy(address(whsk), 100e6);
        uint256 whskHeld = whsk.balanceOf(address(vault));
        uint256 usdtHeld = usdt.balanceOf(address(vault));
        uint256 ownerUsdt = usdt.balanceOf(owner);

        vm.prank(owner);
        vault.exit(owner);

        assertEq(whsk.balanceOf(owner), whskHeld);
        assertEq(usdt.balanceOf(owner), ownerUsdt + usdtHeld);
        assertEq(whsk.balanceOf(address(vault)), 0);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.costBasis(address(whsk)), 0);
    }

    function test_ExitWorksWhenPoolsCannotBePriced() public {
        _buy(address(whsk), 100e6);
        whskPool.setObserveReverts(true);

        vm.expectRevert();
        vault.nav();

        vm.prank(owner);
        vault.exit(owner);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    function testFuzz_DepositAndWithdrawKeepPricePerShare(uint256 extra, uint256 out) public {
        _buy(address(whsk), 100e6);
        _moveWhsk(300);
        uint256 ppsBefore = vault.pricePerShare();

        extra = bound(extra, 1e6, 50_000e6);
        vm.prank(owner);
        vault.deposit(extra);
        assertApproxEqRel(vault.pricePerShare(), ppsBefore, 1e12);

        out = bound(out, 1e6, usdt.balanceOf(address(vault)));
        vm.prank(owner);
        vault.withdraw(out, owner);
        assertApproxEqRel(vault.pricePerShare(), ppsBefore, 1e12);
    }

    // -------------------------------------------------------- access control

    function test_AgentCannotMoveFundsOrChangeRules() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent);
        vm.startPrank(agent);

        vm.expectRevert(unauthorized);
        vault.withdraw(1e6, agent);
        vm.expectRevert(unauthorized);
        vault.exit(agent);
        vm.expectRevert(unauthorized);
        vault.deposit(1e6);
        vm.expectRevert(unauthorized);
        vault.setPolicy(_loosePolicy());
        vm.expectRevert(unauthorized);
        vault.configureAsset(address(whsk), FEE, true);
        vm.expectRevert(unauthorized);
        vault.setAgent(agent);
        vm.expectRevert(unauthorized);
        vault.resume();
        vm.expectRevert(unauthorized);
        vault.sweep(address(whsk), agent);

        vm.stopPrank();
    }

    function test_StrangerCannotTrade() public {
        vm.startPrank(stranger);
        vm.expectRevert(AgentVault.NotOperator.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));
        vm.expectRevert(AgentVault.NotOperator.selector);
        vault.sell(address(whsk), 1, 0, bytes32(0));
        vm.stopPrank();
    }

    function test_RevokedAgentCannotTrade() public {
        vm.prank(owner);
        vault.setAgent(address(0));

        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOperator.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));
    }

    function test_OwnerCanTrade() public {
        vm.prank(owner);
        uint256 out = vault.buy(address(whsk), 50e6, 0, bytes32(0));
        assertGt(out, 0);
    }

    // ----------------------------------------------------------------- buys

    function test_BuyWithinLimits() public {
        vm.expectEmit(true, true, false, false, address(vault));
        emit AgentVault.Trade(address(whsk), true, 0, 0, 0, bytes32(0), 0, 0);
        uint256 out = _buy(address(whsk), 100e6);

        // 100 USDT at 0.08 is 1,250 WHSK before the 0.3% pool fee.
        assertApproxEqRel(out, 1246.25e18, 1e15);
        assertEq(whsk.balanceOf(address(vault)), out);
        assertEq(usdt.balanceOf(address(vault)), DEPOSIT - 100e6);
        assertEq(vault.costBasis(address(whsk)), 100e6);
        assertApproxEqRel(vault.nav(), 999.7e6, 1e15);
        assertEq(vault.buysToday(), 1);
        assertEq(usdt.allowance(address(vault), address(router)), 0, "no allowance left behind");
    }

    function test_BuyRevertsAboveTradeLimit() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.TradeTooLarge.selector, 100e6 + 1, 100e6));
        vault.buy(address(whsk), 100e6 + 1, 0, bytes32(0));
    }

    function test_BuyRevertsAbovePositionLimit() public {
        for (uint256 i = 0; i < 3; i++) {
            _buy(address(whsk), 99e6);
            skip(60);
        }
        // About 296 USDT of WHSK is held; the cap is 30% of a NAV just under 1,000.
        vm.prank(agent);
        vm.expectPartialRevert(AgentVault.PositionTooLarge.selector);
        vault.buy(address(whsk), 50e6, 0, bytes32(0));
    }

    function test_BuyRevertsAboveExposureLimit() public {
        AgentVault.Policy memory p = _loosePolicy();
        p.maxExposureBps = 2500;
        vm.prank(owner);
        vault.setPolicy(p);

        _buy(address(whsk), 200e6);
        vm.prank(agent);
        vm.expectPartialRevert(AgentVault.ExposureTooLarge.selector);
        vault.buy(address(wbtc), 100e6, 0, bytes32(0));
    }

    function test_CooldownAndDailyLimit() public {
        _buy(address(whsk), 10e6);

        vm.prank(agent);
        vm.expectPartialRevert(AgentVault.CooldownActive.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));

        skip(60);
        _buy(address(whsk), 10e6);
        skip(60);
        _buy(address(whsk), 10e6);
        skip(60);

        vm.prank(agent);
        vm.expectRevert(AgentVault.DailyLimitReached.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));

        skip(1 days);
        _buy(address(whsk), 10e6);
        assertEq(vault.buysToday(), 1);
    }

    function test_BuyRevertsWhenExecutionIsWorseThanTwapAllows() public {
        // Spot 1.5% above the TWAP: with the 0.3% fee the fill is about 1.8% worse, over the 1% cap.
        _setPrice(whskPool, address(whsk), HSK_TICK, 150, 0);
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.buy(address(whsk), 100e6, 0, bytes32(0));

        // Spot 0.5% above the TWAP: about 0.8% worse, inside the cap.
        _setPrice(whskPool, address(whsk), HSK_TICK, 50, 0);
        assertGt(_buy(address(whsk), 100e6), 0);
    }

    function test_CallerMinimumIsHonoured() public {
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.buy(address(whsk), 100e6, 1247e18, bytes32(0));
    }

    function test_BuyRevertsForUnlistedOrDisabledAsset() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.prank(agent);
        vm.expectRevert(AgentVault.AssetNotListed.selector);
        vault.buy(address(other), 10e6, 0, bytes32(0));

        vm.prank(owner);
        vault.configureAsset(address(whsk), FEE, false);
        vm.prank(agent);
        vm.expectRevert(AgentVault.AssetDisabled.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));
    }

    function testFuzz_BuyNeverExceedsTradeLimit(uint256 baseIn) public {
        baseIn = bound(baseIn, 1e6, DEPOSIT);
        vm.prank(agent);
        if (baseIn > 100e6) {
            vm.expectPartialRevert(AgentVault.TradeTooLarge.selector);
            vault.buy(address(whsk), baseIn, 0, bytes32(0));
        } else {
            vault.buy(address(whsk), baseIn, 0, bytes32(0));
            assertEq(vault.costBasis(address(whsk)), baseIn);
        }
    }

    // ---------------------------------------------------------------- sells

    function test_SellReducesCostBasisProRata() public {
        uint256 bought = _buy(address(whsk), 100e6);
        _moveWhsk(953); // about +10%

        uint256 baseOut = _sell(address(whsk), bought / 2);

        // Half of 1,246.25 WHSK at 0.088, less the 0.3% fee.
        assertApproxEqRel(baseOut, 54.67e6, 2e15);
        assertApproxEqAbs(vault.costBasis(address(whsk)), 50e6, 1);
        assertEq(whsk.balanceOf(address(vault)), bought - bought / 2);
    }

    function test_SellIsAllowedDuringCooldownAndWhenDisabled() public {
        uint256 bought = _buy(address(whsk), 100e6);
        vm.prank(owner);
        vault.configureAsset(address(whsk), FEE, false);

        assertGt(_sell(address(whsk), bought), 0);
        assertEq(vault.costBasis(address(whsk)), 0);
    }

    function test_SellRevertsBeyondBalance() public {
        uint256 bought = _buy(address(whsk), 100e6);
        vm.prank(agent);
        vm.expectRevert(AgentVault.InsufficientAsset.selector);
        vault.sell(address(whsk), bought + 1, 0, bytes32(0));
    }

    function test_SellRevertsWhenExecutionIsWorseThanTwapAllows() public {
        uint256 bought = _buy(address(whsk), 100e6);
        _setPrice(whskPool, address(whsk), HSK_TICK, -150, 0);
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.sell(address(whsk), bought, 0, bytes32(0));
    }

    // ------------------------------------------------------------ stop-loss

    function test_StopLossCannotFireAboveThreshold() public {
        _buy(address(whsk), 100e6);
        _moveWhsk(-305); // about -3%
        assertFalse(vault.stopLossReached(address(whsk)));

        vm.prank(stranger);
        vm.expectPartialRevert(AgentVault.StopLossNotReached.selector);
        vault.triggerStopLoss(address(whsk), 0);
    }

    function test_AnyoneCanFireStopLossBelowThreshold() public {
        _buy(address(whsk), 100e6);
        _moveWhsk(-619); // about -6%
        assertTrue(vault.stopLossReached(address(whsk)));

        vm.expectEmit(true, true, false, false, address(vault));
        emit AgentVault.StopLossTriggered(address(whsk), stranger, 0, 0);
        vm.prank(stranger);
        uint256 baseOut = vault.triggerStopLoss(address(whsk), 0);

        assertApproxEqRel(baseOut, 93.44e6, 2e15);
        assertEq(whsk.balanceOf(address(vault)), 0);
        assertEq(vault.costBasis(address(whsk)), 0);
        assertEq(usdt.balanceOf(stranger), 0, "the caller receives nothing");

        // The asset is locked for re-entry, then opens again.
        skip(60);
        vm.prank(agent);
        vm.expectPartialRevert(AgentVault.AssetLocked.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));

        skip(1 hours);
        assertGt(_buy(address(whsk), 10e6), 0);
    }

    function test_StopLossIgnoresASpotOnlyCrash() public {
        _buy(address(whsk), 100e6);
        // Spot is pushed down 10% but the TWAP has not moved: a one-block manipulation.
        _setPrice(whskPool, address(whsk), HSK_TICK, -1054, 0);
        assertFalse(vault.stopLossReached(address(whsk)));

        vm.prank(stranger);
        vm.expectPartialRevert(AgentVault.StopLossNotReached.selector);
        vault.triggerStopLoss(address(whsk), 0);
    }

    function test_StopLossRevertsWithNoPosition() public {
        vm.expectRevert(AgentVault.NothingToSell.selector);
        vault.triggerStopLoss(address(whsk), 0);
    }

    function test_StopLossTakesAnAmountAndNeverSellsMoreThanIsHeld() public {
        uint256 bought = _buy(address(whsk), 100e6);
        _moveWhsk(-619);

        // A quarter of the position: cost leaves in proportion and the asset is locked.
        vm.prank(stranger);
        vault.triggerStopLoss(address(whsk), bought / 4);
        assertEq(whsk.balanceOf(address(vault)), bought - bought / 4);
        assertApproxEqAbs(vault.costBasis(address(whsk)), 75e6, 1);
        assertEq(vault.lockedUntil(address(whsk)), block.timestamp + 1 hours);

        // What is left is still past its stop-loss, and an amount above the balance means all of it.
        assertTrue(vault.stopLossReached(address(whsk)));
        vm.prank(stranger);
        vault.triggerStopLoss(address(whsk), type(uint256).max);
        assertEq(whsk.balanceOf(address(vault)), 0);
        assertEq(vault.costBasis(address(whsk)), 0);
    }

    // --------------------------------------------- selling into a thin pool

    /// Makes the WHSK pool hold about 20,000 USDT a side and move when traded.
    function _thinWhskPool() internal {
        whskPool.setLiquidity(70_700_000_000_000_000, true);
    }

    /// Builds a 300 USDT WHSK position while the pool is still deep, then thins the pool.
    function _largePositionInAThinPool() internal returns (uint256 bought) {
        vm.prank(owner);
        vault.setPolicy(_loosePolicy());
        bought = _buy(address(whsk), 300e6);
        _thinWhskPool();
    }

    function test_MaxSellNowIsWhatOneSaleCanPutThroughThePool() public {
        uint256 bought = _largePositionInAThinPool();

        // 0.9% of slippage less the 0.3% fee leaves room for about 0.6% of the pool's depth.
        uint256 fits = vault.maxSellNow(address(whsk));
        assertLt(fits, bought, "a 300 USDT position is too much for a 20,000 USDT pool");
        assertApproxEqRel(vault.twapQuote(address(whsk), address(usdt), fits), 121.4e6, 2e16);

        // A third more than that does not clear the vault's limit; the amount itself does.
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.sell(address(whsk), fits * 13 / 10, 0, bytes32(0));
        assertGt(_sell(address(whsk), fits), 0);
    }

    /// The estimate has one formula for an asset that is the pool's token0 and another for
    /// token1. Which one WHSK gets here depends on deployment addresses, so this test builds
    /// a vault whose base token sits between two assets and checks both.
    function test_MaxSellNowHoldsForEitherTokenOrder() public {
        MockERC20[3] memory tokens =
            [new MockERC20("A", "A", 18), new MockERC20("B", "B", 18), new MockERC20("C", "C", 18)];
        for (uint256 i = 0; i < 2; i++) {
            for (uint256 j = 0; j < 2 - i; j++) {
                if (address(tokens[j]) > address(tokens[j + 1])) (tokens[j], tokens[j + 1]) = (tokens[j + 1], tokens[j]);
            }
        }
        MockERC20 baseToken = tokens[1];
        MockERC20[2] memory twoAssets = [tokens[0], tokens[2]];

        AgentVault v =
            new AgentVault(owner, agent, address(baseToken), address(router), address(factory), _loosePolicy());
        baseToken.mint(owner, 1_000e18);
        vm.startPrank(owner);
        baseToken.approve(address(v), type(uint256).max);
        v.deposit(1_000e18);
        vm.stopPrank();

        for (uint256 i = 0; i < 2; i++) {
            address asset = address(twoAssets[i]);
            MockV3Pool pool = factory.createPool(asset, address(baseToken), FEE);
            pool.setTicks(0, 0); // one asset is worth one base token
            vm.prank(owner);
            v.configureAsset(asset, FEE, true);

            vm.prank(agent);
            uint256 bought = v.buy(asset, 250e18, 0, bytes32(0));
            // 20,000 base tokens a side at a price of one.
            pool.setLiquidity(20_000e18, true);

            uint256 fits = v.maxSellNow(asset);
            assertLt(fits, bought);
            assertApproxEqRel(fits, 121.4e18, 2e16, i == 0 ? "asset is token0" : "asset is token1");

            vm.prank(agent);
            vm.expectRevert(bytes("Too little received"));
            v.sell(asset, fits * 13 / 10, 0, bytes32(0));
            vm.prank(agent);
            assertGt(v.sell(asset, fits, 0, bytes32(0)), fits * 99 / 100);
        }
    }

    function test_MaxSellNowIsTheWholePositionWhenThePoolIsDeep() public {
        uint256 bought = _buy(address(whsk), 100e6);
        assertEq(vault.maxSellNow(address(whsk)), bought);
        assertEq(vault.maxSellNow(address(wbtc)), 0, "nothing held");
        assertEq(vault.maxSellNow(address(0xDEAD)), 0, "not listed");
    }

    function test_MaxSellNowIsZeroWhileThePriceSitsUnderTheFloor() public {
        _buy(address(whsk), 100e6);
        // Spot 1% under the TWAP: after the 0.3% fee no sale of any size stays inside the limit.
        _setPrice(whskPool, address(whsk), HSK_TICK, -100, 0);
        assertEq(vault.maxSellNow(address(whsk)), 0);

        // Spot above the TWAP leaves more room than usual, capped at the balance.
        _setPrice(whskPool, address(whsk), HSK_TICK, 50, 0);
        assertEq(vault.maxSellNow(address(whsk)), whsk.balanceOf(address(vault)));
    }

    function test_StopLossClosesALargePositionInParts() public {
        uint256 bought = _largePositionInAThinPool();
        _moveWhsk(-619);
        assertTrue(vault.stopLossReached(address(whsk)));

        // All of it in one swap would fill far under the TWAP, so that is still refused.
        vm.prank(stranger);
        vm.expectRevert(bytes("Too little received"));
        vault.triggerStopLoss(address(whsk), bought);

        // Asking for what fits sells a part and leaves the rest with its share of the cost.
        uint256 fits = vault.maxSellNow(address(whsk));
        assertGt(fits, 0);
        assertLt(fits, bought);
        vm.prank(stranger);
        uint256 baseOut = vault.triggerStopLoss(address(whsk), 0);
        assertGt(baseOut, 0);
        assertEq(whsk.balanceOf(address(vault)), bought - fits);
        assertApproxEqAbs(vault.costBasis(address(whsk)), 300e6 - (300e6 * fits) / bought, 2);
        assertEq(vault.lockedUntil(address(whsk)), block.timestamp + 1 hours);

        // That sale left the price under the TWAP, so nothing more fits until the TWAP follows.
        assertEq(vault.maxSellNow(address(whsk)), 0);
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NoRoomToSell.selector);
        vault.triggerStopLoss(address(whsk), 0);

        // Each time the TWAP has caught up, anyone can sell the next part.
        uint256 calls = 1;
        while (whsk.balanceOf(address(vault)) > 0) {
            whskPool.syncTwap();
            vm.prank(stranger);
            vault.triggerStopLoss(address(whsk), 0);
            calls += 1;
            assertLt(calls, 10, "the position should be gone in a few sales");
        }
        assertGt(calls, 2);
        assertEq(vault.costBasis(address(whsk)), 0);
        assertEq(vault.nav(), usdt.balanceOf(address(vault)));
    }

    // -------------------------------------------------------------- breaker

    function test_CheckpointTripsBreakerAfterDrawdown() public {
        _crashHalfTheBook();
        assertGt(vault.drawdownBps(), 1000);

        vm.expectEmit(false, false, false, false, address(vault));
        emit AgentVault.BreakerTripped(0, 0);
        vm.prank(stranger);
        assertTrue(vault.checkpoint());
        assertTrue(vault.halted());

        vm.prank(agent);
        vm.expectRevert(AgentVault.Halted.selector);
        vault.buy(address(whsk), 10e6, 0, bytes32(0));
    }

    function test_BuyLatchesBreakerInsteadOfReverting() public {
        _crashHalfTheBook();
        uint256 usdtBefore = usdt.balanceOf(address(vault));
        uint256 whskBefore = whsk.balanceOf(address(vault));

        assertEq(_buy(address(whsk), 10e6), 0);

        assertTrue(vault.halted());
        assertEq(usdt.balanceOf(address(vault)), usdtBefore);
        assertEq(whsk.balanceOf(address(vault)), whskBefore);
    }

    function test_HaltedVaultCanBeFlattenedByAnyone() public {
        _crashHalfTheBook();
        vault.checkpoint();

        vm.prank(stranger);
        uint256 baseOut = vault.flatten(address(whsk), 0);
        assertGt(baseOut, 0);
        assertEq(whsk.balanceOf(address(vault)), 0);

        // The agent can still sell while halted.
        assertGt(_sell(address(wbtc), wbtc.balanceOf(address(vault))), 0);
        assertEq(vault.nav(), usdt.balanceOf(address(vault)));
    }

    function test_FlattenRevertsWhenNotHalted() public {
        _buy(address(whsk), 100e6);
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotHalted.selector);
        vault.flatten(address(whsk), 0);
    }

    function test_FlattenTakesAnAmountAndSellsWhatFitsInAThinPool() public {
        _crashHalfTheBook();
        vault.checkpoint();
        uint256 held = whsk.balanceOf(address(vault));

        vm.prank(stranger);
        vault.flatten(address(whsk), held / 2);
        assertEq(whsk.balanceOf(address(vault)), held - held / 2);

        // The rest is too much for a thin pool in one go; "what fits" sells a part of it.
        _thinWhskPool();
        uint256 fits = vault.maxSellNow(address(whsk));
        assertLt(fits, held - held / 2);
        vm.prank(stranger);
        vault.flatten(address(whsk), 0);
        assertEq(whsk.balanceOf(address(vault)), held - held / 2 - fits);

        vm.expectRevert(AgentVault.AssetNotListed.selector);
        vault.flatten(address(0xDEAD), 0);
    }

    function test_OwnerResumesFromCurrentNav() public {
        _crashHalfTheBook();
        vault.checkpoint();

        vm.prank(owner);
        vault.resume();

        assertFalse(vault.halted());
        assertEq(vault.highWaterMark(), vault.pricePerShare());
        assertEq(vault.drawdownBps(), 0);
        assertGt(_buy(address(whsk), 10e6), 0);
    }

    function test_HighWaterMarkFollowsGains() public {
        _buy(address(whsk), 100e6);
        _moveWhsk(953);
        vault.checkpoint();
        assertGt(vault.highWaterMark(), 1e18);
        assertEq(vault.highWaterMark(), vault.pricePerShare());
        assertFalse(vault.halted());
    }

    // --------------------------------------------------------------- config

    function test_PolicyBoundsAreEnforced() public {
        AgentVault.Policy memory p = _defaultPolicy();
        p.maxSlippageBps = 1001;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.maxSlippageBps = 0;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.maxTradeBps = 10_001;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.stopLossBps = 9;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.maxDrawdownBps = 9_001;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.maxTradesPerDay = 0;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.twapWindow = 59;
        _expectInvalidPolicy(p);

        p = _defaultPolicy();
        p.twapWindow = 1 hours + 1;
        _expectInvalidPolicy(p);
    }

    function _expectInvalidPolicy(AgentVault.Policy memory p) internal {
        vm.prank(owner);
        vm.expectRevert(AgentVault.InvalidPolicy.selector);
        vault.setPolicy(p);
    }

    function test_SetPolicyRevertsWhenAPoolCannotServeTheWindow() public {
        whskPool.setObserveReverts(true);
        vm.prank(owner);
        vm.expectRevert(bytes("OLD"));
        vault.setPolicy(_loosePolicy());
    }

    function test_ConfigureAssetValidation() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.startPrank(owner);

        vm.expectRevert(AgentVault.PoolNotFound.selector);
        vault.configureAsset(address(other), FEE, true);
        vm.expectRevert(AgentVault.AssetIsBase.selector);
        vault.configureAsset(address(usdt), FEE, true);
        vm.expectRevert(AgentVault.PoolNotFound.selector);
        vault.configureAsset(address(whsk), 500, true);

        vm.stopPrank();
        assertEq(vault.assetList().length, 2);
    }

    // -------------------------------------------------------- price history

    function test_ListingAnAssetEnlargesAPriceHistoryThatIsTooShort() public view {
        // Both mock pools started with one observation. Listing them under a 300-second
        // window asked for one per 2-second block, plus one.
        assertEq(whskPool.observationCardinalityNext(), 151);
        assertEq(wbtcPool.observationCardinalityNext(), 151);
        assertEq(whskPool.enlargements(), 1);
    }

    function test_ALongerWindowEnlargesEveryListedPool() public {
        AgentVault.Policy memory p = _defaultPolicy();
        p.twapWindow = 900;
        vm.prank(owner);
        vault.setPolicy(p);
        assertEq(whskPool.observationCardinalityNext(), 451);
        assertEq(wbtcPool.observationCardinalityNext(), 451);

        // Going back to a shorter window asks for nothing.
        vm.prank(owner);
        vault.setPolicy(_defaultPolicy());
        assertEq(whskPool.observationCardinalityNext(), 451);
        assertEq(whskPool.enlargements(), 2);
    }

    function test_APriceHistoryThatIsLongEnoughIsLeftAlone() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        MockV3Pool pool = factory.createPool(address(other), address(usdt), FEE);
        pool.setTicks(0, 0);
        pool.increaseObservationCardinalityNext(240);

        vm.prank(owner);
        vault.configureAsset(address(other), FEE, true);
        assertEq(pool.observationCardinalityNext(), 240);
        assertEq(pool.enlargements(), 1, "only the test's own call");

        // Changing the listing later does not touch it either.
        vm.prank(owner);
        vault.configureAsset(address(other), FEE, false);
        assertEq(pool.enlargements(), 1);
    }

    function test_ConstructorRejectsRouterOfAnotherFactory() public {
        MockV3Factory otherFactory = new MockV3Factory();
        vm.expectRevert(AgentVault.RouterFactoryMismatch.selector);
        new AgentVault(owner, agent, address(usdt), address(router), address(otherFactory), _defaultPolicy());
    }

    function test_SweepOnlyTouchesUnrelatedTokens() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(vault), 5e18);

        vm.startPrank(owner);
        vault.sweep(address(other), owner);
        assertEq(other.balanceOf(owner), 5e18);

        vm.expectRevert(AgentVault.NotSweepable.selector);
        vault.sweep(address(usdt), owner);
        vm.expectRevert(AgentVault.NotSweepable.selector);
        vault.sweep(address(whsk), owner);
        vm.stopPrank();
    }

    function test_PositionsView() public {
        uint256 bought = _buy(address(whsk), 100e6);
        AgentVault.Position[] memory list = vault.positions();

        assertEq(list.length, 2);
        assertEq(list[0].asset, address(whsk));
        assertEq(list[0].balance, bought);
        assertEq(list[0].cost, 100e6);
        assertApproxEqRel(list[0].value, 99.7e6, 1e15);
        assertEq(list[1].asset, address(wbtc));
        assertEq(list[1].balance, 0);
        assertEq(list[1].value, 0);
    }
}
