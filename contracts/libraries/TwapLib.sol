// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";

/// @notice Time-weighted average price helpers for Uniswap V3 style pools.
/// @dev Same math as Uniswap's periphery OracleLibrary, written for Solidity 0.8 and
/// using OpenZeppelin's 512-bit mulDiv.
library TwapLib {
    /// @notice Arithmetic mean tick of `pool` over the last `window` seconds.
    /// @dev Reverts (inside the pool) when the pool has no observation that old.
    function meanTick(address pool, uint32 window) internal view returns (int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives,) = IUniswapV3Pool(pool).observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 span = int56(uint56(window));
        tick = int24(delta / span);
        // Round toward negative infinity, as the reference implementation does.
        if (delta < 0 && (delta % span != 0)) tick--;
    }

    /// @notice Most of `tokenIn` that one exact-input swap can put through `pool` while its
    /// output stays at or above `keepBps` (out of 10 000) of what the input is worth at `tick`.
    /// @dev A swap of amount `a` inside one liquidity range fills, per unit and before the fee,
    /// at the geometric mean of the pool's price before and after it. Asking that mean to stay
    /// above the floor gives the furthest price the swap may reach, and the liquidity between
    /// here and there is the answer. Liquidity beyond the current range is not looked at, so
    /// this is an estimate: the caller must still enforce the floor on the swap itself.
    /// Every rounding goes toward a smaller amount.
    /// @param tick the reference tick, normally the TWAP
    /// @param feePips pool fee in hundredths of a bip, taken from the input
    function maxInputAboveFloor(
        address pool,
        int24 tick,
        address tokenIn,
        address tokenOut,
        uint24 feePips,
        uint256 keepBps
    ) internal view returns (uint256 amountIn) {
        uint128 liquidity = IUniswapV3Pool(pool).liquidity();
        if (liquidity == 0) return 0;
        (uint160 sqrtPrice,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 sqrtRef = TickMath.getSqrtRatioAtTick(tick);

        // Floor as a share of the reference price once the fee is taken off the input.
        uint256 keep = keepBps * 1e6;
        uint256 afterFee = 10_000 * (1e6 - uint256(feePips));
        uint256 net;

        if (tokenIn < tokenOut) {
            // Selling token0 pushes the pool's price down. The swap may go no lower than
            // sqrtMin = sqrtRef^2 * keep / (sqrtPrice * afterFee).
            if (sqrtRef >= uint256(sqrtPrice) * 2) return 0; // already far below the floor
            uint256 sqrtMin = Math.mulDiv(
                Math.mulDiv(sqrtRef, sqrtRef, sqrtPrice, Math.Rounding.Ceil), keep, afterFee, Math.Rounding.Ceil
            );
            if (sqrtMin >= sqrtPrice) return 0;
            if (sqrtMin < TickMath.MIN_SQRT_RATIO) sqrtMin = TickMath.MIN_SQRT_RATIO;
            // token0 between the two prices: liquidity * (1/sqrtMin - 1/sqrtPrice)
            net = Math.mulDiv(uint256(liquidity) << 96, sqrtPrice - sqrtMin, sqrtPrice) / sqrtMin;
        } else {
            // Selling token1 pushes the pool's price up. The swap may go no higher than
            // sqrtMax = sqrtRef^2 * afterFee / (sqrtPrice * keep).
            if (sqrtRef > uint256(sqrtPrice) * 2) sqrtRef = uint256(sqrtPrice) * 2; // keeps the product in range
            uint256 sqrtMax = Math.mulDiv(Math.mulDiv(sqrtRef, sqrtRef, sqrtPrice), afterFee, keep);
            if (sqrtMax <= sqrtPrice) return 0;
            // token1 between the two prices: liquidity * (sqrtMax - sqrtPrice)
            net = Math.mulDiv(liquidity, sqrtMax - sqrtPrice, 1 << 96);
        }
        amountIn = Math.mulDiv(net, 1e6, 1e6 - uint256(feePips));
    }

    /// @notice Amount of `tokenOut` that `amountIn` of `tokenIn` is worth at `tick`, ignoring fees.
    function quoteAtTick(int24 tick, uint256 amountIn, address tokenIn, address tokenOut)
        internal
        pure
        returns (uint256 amountOut)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        // Square the price with as much precision as fits in 256 bits.
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            amountOut = tokenIn < tokenOut
                ? Math.mulDiv(ratioX192, amountIn, 1 << 192)
                : Math.mulDiv(1 << 192, amountIn, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            amountOut = tokenIn < tokenOut
                ? Math.mulDiv(ratioX128, amountIn, 1 << 128)
                : Math.mulDiv(1 << 128, amountIn, ratioX128);
        }
    }
}
