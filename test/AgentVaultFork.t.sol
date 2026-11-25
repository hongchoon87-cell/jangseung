// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {AgentVault} from "../contracts/AgentVault.sol";
import {ISwapRouter02} from "../contracts/interfaces/ISwapRouter02.sol";

interface IWrappedNative {
    function deposit() external payable;
}

/// @notice The vault against the real HSKSwap contracts, on a fork of HSK Chain mainnet
/// pinned to one block so every run sees the same pools and prices.
contract AgentVaultForkTest is Test {
    uint256 internal constant FORK_BLOCK = 30_581_400;

    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant WETH = 0xefd4bC9afD210517803f293ABABd701CaeeCdfd0;
    address internal constant WBTC = 0x6119CA49a79f5825C8B345F8d7aC36B272565b14;

    address internal constant FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742;
    address internal constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;

    address internal constant POOL_WHSK = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address internal constant POOL_WETH = 0xb92b79ed6b370D5cFee2E14B1D0983C258304C16;
    address internal constant POOL_WBTC = 0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A;

    uint24 internal constant FEE = 3000;

    address internal owner = address(0xA11CE);
    address internal agent = address(0xB0B);
    address internal stranger = address(0xCAFE);
    address internal whale = address(0xBEEF);

    AgentVault internal vault;

    function setUp() public {
        vm.createSelectFork("hsk", FORK_BLOCK);

        vault = new AgentVault(owner, agent, USDT, ROUTER, FACTORY, _policy());

        deal(USDT, owner, 200_000e6);
        vm.startPrank(owner);
        vault.configureAsset(WHSK, FEE, true);
        vault.configureAsset(WETH, FEE, true);
        vault.configureAsset(WBTC, FEE, true);
        IERC20(USDT).approve(address(vault), type(uint256).max);
        vault.deposit(1_000e6);
        vm.stopPrank();
    }

    function _policy() internal pure returns (AgentVault.Policy memory) {
        return AgentVault.Policy({
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
        });
    }

    function _pool(address asset) internal view returns (address pool) {
        (,,, pool) = vault.assets(asset);
    }

    function test_Fork_AssetsResolveToHskSwapPools() public view {
        assertEq(_pool(WHSK), POOL_WHSK);
        assertEq(_pool(WETH), POOL_WETH);
        assertEq(_pool(WBTC), POOL_WBTC);
        assertEq(vault.nav(), 1_000e6);
    }

    function test_Fork_BuyThenSellWhsk() public {
        uint256 twapOut = vault.twapQuote(USDT, WHSK, 100e6);

        vm.prank(agent);
        uint256 bought = vault.buy(WHSK, 100e6, 0, keccak256("decision-1"));

        // The fill is the TWAP quote less the 0.3% fee and a little price impact.
        assertLt(bought, twapOut);
        assertGt(bought, twapOut * 9900 / 10_000);
        emit log_named_decimal_uint("WHSK bought for 100 USDT", bought, 18);
        emit log_named_decimal_uint("NAV after buy", vault.nav(), 6);

        assertEq(vault.costBasis(WHSK), 100e6);
        assertApproxEqRel(vault.nav(), 999.7e6, 1e15);

        vm.prank(agent);
        uint256 baseOut = vault.sell(WHSK, bought, 0, keccak256("decision-2"));

        // A round trip costs two pool fees.
        assertApproxEqRel(baseOut, 99.4e6, 2e15);
        assertEq(IERC20(WHSK).balanceOf(address(vault)), 0);
        assertEq(vault.costBasis(WHSK), 0);
        assertEq(vault.nav(), IERC20(USDT).balanceOf(address(vault)));
        emit log_named_decimal_uint("USDT back after round trip", baseOut, 6);
    }

    function test_Fork_NavPricesThreeAssetsAtTwap() public {
        // 90 USDT each: every buy must stay under 10% of a NAV that shrinks slightly with each fee.
        vm.startPrank(agent);
        vault.buy(WHSK, 90e6, 0, bytes32(0));
        vault.buy(WETH, 90e6, 0, bytes32(0));
        vault.buy(WBTC, 90e6, 0, bytes32(0));
        vm.stopPrank();

        AgentVault.Position[] memory list = vault.positions();
        assertEq(list.length, 3);
        uint256 exposure;
        for (uint256 i = 0; i < list.length; i++) {
            assertGt(list[i].balance, 0);
            assertEq(list[i].cost, 90e6);
            // Each position is worth what was paid, less the 0.3% fee and impact, within 1%.
            assertApproxEqRel(list[i].value, 89.73e6, 1e16);
            exposure += list[i].value;
            emit log_named_decimal_uint("position value", list[i].value, 6);
        }
        assertEq(vault.nav(), IERC20(USDT).balanceOf(address(vault)) + exposure);
        assertEq(vault.buysToday(), 3);
    }

    function test_Fork_OversizedBuyIsStoppedByTheTwapFloor() public {
        AgentVault.Policy memory p = _policy();
        p.maxTradeBps = 10_000;
        p.maxPositionBps = 10_000;
        p.maxExposureBps = 10_000;
        vm.startPrank(owner);
        vault.setPolicy(p);
        vault.deposit(100_000e6);
        vm.stopPrank();

        // 30,000 USDT into a pool holding about 45,000 USDT moves the price far past 1%.
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.buy(WBTC, 30_000e6, 0, bytes32(0));

        // A size the pool can absorb goes through.
        vm.prank(agent);
        assertGt(vault.buy(WBTC, 100e6, 0, bytes32(0)), 0);
    }

    function test_Fork_StopLossFollowsTheTwapAfterARealSellOff() public {
        vm.prank(agent);
        vault.buy(WHSK, 100e6, 0, bytes32(0));

        // Someone sells 300,000 WHSK into the pool, pushing the spot price down about 10%.
        vm.deal(whale, 300_000 ether);
        vm.startPrank(whale);
        IWrappedNative(WHSK).deposit{value: 300_000 ether}();
        IERC20(WHSK).approve(ROUTER, type(uint256).max);
        ISwapRouter02(ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WHSK,
                tokenOut: USDT,
                fee: FEE,
                recipient: whale,
                amountIn: 300_000 ether,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        // In the same block the TWAP has not moved, so the stop-loss cannot be forced yet.
        assertFalse(vault.stopLossReached(WHSK));
        vm.prank(stranger);
        vm.expectPartialRevert(AgentVault.StopLossNotReached.selector);
        vault.triggerStopLoss(WHSK, 0);

        // Once the lower price has held for the TWAP window, anyone can close the position.
        skip(300);
        vm.roll(block.number + 150);
        assertTrue(vault.stopLossReached(WHSK));

        vm.prank(stranger);
        uint256 baseOut = vault.triggerStopLoss(WHSK, 0);
        emit log_named_decimal_uint("USDT recovered by stop-loss", baseOut, 6);

        assertLt(baseOut, 95e6);
        assertGt(baseOut, 80e6);
        assertEq(IERC20(WHSK).balanceOf(address(vault)), 0);
        assertEq(IERC20(USDT).balanceOf(stranger), 0);

        vm.prank(agent);
        vm.expectPartialRevert(AgentVault.AssetLocked.selector);
        vault.buy(WHSK, 10e6, 0, bytes32(0));
    }

    function test_Fork_GasCosts() public {
        vm.prank(agent);
        uint256 gasBefore = gasleft();
        uint256 bought = vault.buy(WHSK, 100e6, 0, bytes32(0));
        emit log_named_uint("gas: buy", gasBefore - gasleft());

        vm.prank(agent);
        gasBefore = gasleft();
        vault.sell(WHSK, bought, 0, bytes32(0));
        emit log_named_uint("gas: sell", gasBefore - gasleft());

        gasBefore = gasleft();
        vault.checkpoint();
        emit log_named_uint("gas: checkpoint", gasBefore - gasleft());
    }
}
