// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwapMath} from "@uniswap/v3-core/contracts/libraries/SwapMath.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";

import {ISwapRouter02} from "../../contracts/interfaces/ISwapRouter02.sol";
import {TwapLib} from "../../contracts/libraries/TwapLib.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Stand-in for a Uniswap V3 pool. Tests set the spot tick (what swaps execute at)
/// and the TWAP tick (what `observe` reports) independently.
///
/// By default a swap leaves the price where it was, which keeps the arithmetic of most
/// tests simple. `setLiquidity(amount, true)` turns the pool into a real single-range one:
/// swaps then move its price exactly as Uniswap's SwapMath says, so a trade can be too
/// large for it.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    int24 public spotTick;
    int24 public twapTick;
    bool public observeReverts;

    /// Price swaps execute at. Set from the spot tick, then moved by swaps with price impact.
    uint160 public sqrtPriceX96;
    /// Liquidity in range. Enormous unless a test sets it, so any sale "fits".
    uint128 public liquidity = 1e30;
    bool public priceImpact;

    /// Observations the oracle will keep, as in slot0. A new pool starts with one.
    uint16 public observationCardinalityNext = 1;
    /// How many times somebody enlarged the oracle.
    uint256 public enlargements;

    constructor(address tokenA, address tokenB, uint24 fee_) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
    }

    function setTicks(int24 spot, int24 twap) external {
        spotTick = spot;
        twapTick = twap;
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(spot);
    }

    function setLiquidity(uint128 amount, bool withPriceImpact) external {
        liquidity = amount;
        priceImpact = withPriceImpact;
    }

    /// The TWAP catches up with wherever swaps have left the price.
    function syncTwap() external {
        twapTick = spotTick;
    }

    function setObserveReverts(bool value) external {
        observeReverts = value;
    }

    /// Called by the router after a swap with price impact.
    function moveTo(uint160 sqrtPrice) external {
        sqrtPriceX96 = sqrtPrice;
        spotTick = TickMath.getTickAtSqrtRatio(sqrtPrice);
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPrice,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 cardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, spotTick, 0, observationCardinalityNext, observationCardinalityNext, 0, true);
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        enlargements += 1;
        if (next > observationCardinalityNext) observationCardinalityNext = next;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!observeReverts, "OLD");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        // A cumulative that grows by twapTick every second, so any window averages to twapTick.
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = -int56(twapTick) * int56(uint56(secondsAgos[i]));
        }
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (MockV3Pool pool) {
        pool = new MockV3Pool(tokenA, tokenB, fee);
        getPool[tokenA][tokenB][fee] = address(pool);
        getPool[tokenB][tokenA][fee] = address(pool);
    }
}

/// @notice Executes swaps against the mock pools, minting the output token. At the pool's
/// spot tick less the fee by default; along the pool's curve when it has price impact on.
contract MockSwapRouter is ISwapRouter02 {
    address public immutable override factory;

    constructor(address factory_) {
        factory = factory_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        MockV3Pool pool = MockV3Pool(MockV3Factory(factory).getPool(params.tokenIn, params.tokenOut, params.fee));
        require(address(pool) != address(0), "no pool");

        if (pool.priceImpact()) {
            bool zeroForOne = params.tokenIn < params.tokenOut;
            uint160 next;
            (next,, amountOut,) = SwapMath.computeSwapStep(
                pool.sqrtPriceX96(),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                pool.liquidity(),
                int256(params.amountIn),
                params.fee
            );
            require(amountOut >= params.amountOutMinimum, "Too little received");
            pool.moveTo(next);
        } else {
            uint256 gross = TwapLib.quoteAtTick(pool.spotTick(), params.amountIn, params.tokenIn, params.tokenOut);
            amountOut = gross * (1_000_000 - params.fee) / 1_000_000;
            require(amountOut >= params.amountOutMinimum, "Too little received");
        }

        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);
    }
}
