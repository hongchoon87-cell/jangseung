// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {TestToken} from "../contracts/testnet/TestToken.sol";

/// @notice The valueless token of the testnet demo market.
contract TestTokenTest is Test {
    address internal stranger = address(0xCAFE);
    TestToken internal token;

    function setUp() public {
        token = new TestToken("Test USDT (AgentVault demo)", "tUSDT", 6);
    }

    function test_KeepsTheNameAndDecimalsItWasGiven() public view {
        assertEq(token.name(), "Test USDT (AgentVault demo)");
        assertEq(token.symbol(), "tUSDT");
        assertEq(token.decimals(), 6);
        assertEq(token.owner(), address(this));
        assertEq(token.totalSupply(), 0);
    }

    function test_OwnerMints() public {
        token.mint(stranger, 5e6);
        assertEq(token.balanceOf(stranger), 5e6);
        assertEq(token.totalSupply(), 5e6);
    }

    function test_NobodyElseMints() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1);
    }
}
