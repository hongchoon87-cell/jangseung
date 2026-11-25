// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {TwapLib} from "./libraries/TwapLib.sol";

/// @title AgentVault
/// @notice Holds one owner's funds and lets an AI agent trade them on a Uniswap V3 style
/// DEX (HSKSwap) strictly inside limits that live in this contract.
///
/// The owner deposits a base stablecoin, withdraws at any time and sets the policy. The
/// agent key can only swap between the base token and listed assets, and every swap is
/// checked against the policy: trade size, position size, total exposure, price versus the
/// pool's time-weighted average price (TWAP), trade frequency, a per-position stop-loss
/// and a portfolio drawdown breaker. The agent can never withdraw.
///
/// All values are denominated in the base token and priced with the TWAP of the
/// asset/base pool, so a price pushed around within a single block cannot move them.
contract AgentVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    /// @notice Risk limits enforced on every agent trade. Bps values are out of 10 000.
    struct Policy {
        /// Largest single buy, as a share of net asset value (NAV).
        uint16 maxTradeBps;
        /// Largest holding of one asset, as a share of NAV.
        uint16 maxPositionBps;
        /// Largest combined holding of all assets, as a share of NAV.
        uint16 maxExposureBps;
        /// Worst execution price accepted, measured against the TWAP. Includes the pool fee.
        uint16 maxSlippageBps;
        /// A position worth this much less than what was paid for it can be closed by anyone.
        uint16 stopLossBps;
        /// NAV per share falling this far below its peak halts buying.
        uint16 maxDrawdownBps;
        /// Buys allowed per UTC day.
        uint16 maxTradesPerDay;
        /// Minimum seconds between two buys.
        uint32 cooldown;
        /// TWAP averaging window in seconds.
        uint32 twapWindow;
        /// Seconds an asset cannot be bought again after its stop-loss fired.
        uint32 reentryLockout;
    }

    struct AssetConfig {
        bool listed;
        /// Disabled assets can still be sold, never bought.
        bool enabled;
        uint24 fee;
        address pool;
    }

    struct Position {
        address asset;
        bool enabled;
        uint256 balance;
        /// Current worth in base token at the TWAP.
        uint256 value;
        /// Base token spent to build the balance.
        uint256 cost;
        uint64 lockedUntil;
    }

    // ------------------------------------------------------------ constants

    uint256 internal constant BPS = 10_000;
    /// @notice NAV per share is reported with 18 decimals; a fresh vault starts at 1e18.
    uint256 public constant PPS_ONE = 1e18;
    uint256 public constant MAX_ASSETS = 8;
    /// @notice Shortest block time assumed when sizing a pool's price history. HSK Chain
    /// produces a block every 2 seconds; a faster chain would need a smaller value.
    uint32 public constant MIN_BLOCK_SECONDS = 2;

    // ---------------------------------------------------------------- state

    IERC20 public immutable base;
    ISwapRouter02 public immutable router;
    IUniswapV3Factory public immutable factory;

    /// @notice The key allowed to trade. Zero address means no agent.
    address public agent;

    Policy internal _policy;

    mapping(address => AssetConfig) public assets;
    address[] internal _assetList;

    /// @notice Base token spent to build the current position in each asset.
    mapping(address => uint256) public costBasis;
    /// @notice Timestamp before which an asset cannot be bought after a stop-loss.
    mapping(address => uint64) public lockedUntil;

    /// @notice Accounting units that keep NAV per share unaffected by deposits and withdrawals.
    uint256 public totalShares;
    /// @notice Highest NAV per share seen so far, 18 decimals.
    uint256 public highWaterMark = PPS_ONE;
    /// @notice True once the drawdown breaker has tripped. Buying stays blocked until the owner resumes.
    bool public halted;

    uint64 public lastBuyAt;
    uint64 public currentDay;
    uint16 public buysToday;

    // --------------------------------------------------------------- events

    event Deposited(address indexed owner, uint256 amount, uint256 shares);
    event Withdrawn(address indexed to, uint256 amount, uint256 shares);
    event Exited(address indexed to);
    event AgentUpdated(address indexed agent);
    event PolicyUpdated(Policy policy);
    event AssetConfigured(address indexed asset, uint24 fee, address pool, bool enabled);
    /// @param memo keccak256 of the agent's decision record, kept off-chain, so the reasoning
    /// behind each trade can be checked later against what actually happened on-chain.
    event Trade(
        address indexed asset,
        bool indexed isBuy,
        uint256 baseAmount,
        uint256 assetAmount,
        int256 realizedPnl,
        bytes32 memo,
        uint256 navAfter,
        uint256 pricePerShareAfter
    );
    event StopLossTriggered(address indexed asset, address indexed caller, uint256 assetSold, uint256 baseReceived);
    event Flattened(address indexed asset, address indexed caller, uint256 assetSold, uint256 baseReceived);
    event BreakerTripped(uint256 pricePerShare, uint256 highWaterMark);
    event Resumed(uint256 pricePerShare);

    // --------------------------------------------------------------- errors

    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidPolicy();
    error RouterFactoryMismatch();
    error AssetIsBase();
    error AssetNotListed();
    error AssetDisabled();
    error AssetLocked(uint64 until);
    error TooManyAssets();
    error PoolNotFound();
    error EmptyVault();
    error InsufficientBase();
    error InsufficientShares();
    error TradeTooLarge(uint256 amount, uint256 limit);
    error PositionTooLarge(uint256 valueAfter, uint256 limit);
    error ExposureTooLarge(uint256 exposureAfter, uint256 limit);
    error CooldownActive(uint64 until);
    error DailyLimitReached();
    error Slippage(uint256 received, uint256 minimum);
    error StopLossNotReached(uint256 value, uint256 threshold);
    error Halted();
    error NotHalted();
    error NothingToSell();
    /// The pool cannot take any sale inside the slippage limit right now.
    error NoRoomToSell();
    error InsufficientAsset();
    error NotSweepable();

    // ------------------------------------------------------------ modifiers

    modifier onlyOperator() {
        if (msg.sender != agent && msg.sender != owner()) revert NotOperator();
        _;
    }

    // ---------------------------------------------------------- constructor

    constructor(address owner_, address agent_, address base_, address router_, address factory_, Policy memory policy_)
        Ownable(owner_)
    {
        if (base_ == address(0) || router_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        if (ISwapRouter02(router_).factory() != factory_) revert RouterFactoryMismatch();
        _validatePolicy(policy_);

        base = IERC20(base_);
        router = ISwapRouter02(router_);
        factory = IUniswapV3Factory(factory_);
        agent = agent_;
        _policy = policy_;

        emit AgentUpdated(agent_);
        emit PolicyUpdated(policy_);
    }

    // ---------------------------------------------------------- owner: funds

    /// @notice Add base token to the vault.
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 navBefore = _nav();
        if (totalShares != 0 && navBefore == 0) {
            // Everything was lost or withdrawn in kind; start a fresh track record.
            totalShares = 0;
            highWaterMark = PPS_ONE;
        }
        uint256 shares = totalShares == 0 ? amount : Math.mulDiv(amount, totalShares, navBefore);
        if (shares == 0) revert ZeroAmount();

        totalShares += shares;
        base.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, shares);
    }

    /// @notice Take base token out. Positions stay open; sell first to free more base.
    function withdraw(uint256 amount, address to) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (amount > base.balanceOf(address(this))) revert InsufficientBase();

        uint256 navBefore = _nav();
        uint256 shares = Math.mulDiv(amount, totalShares, navBefore, Math.Rounding.Ceil);
        if (shares > totalShares) revert InsufficientShares();

        totalShares -= shares;
        base.safeTransfer(to, amount);
        emit Withdrawn(to, amount, shares);
    }

    /// @notice Send every token the vault holds to `to` and reset the accounting.
    /// @dev Reads no prices, so the owner can always leave, whatever state the pools are in.
    function exit(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        uint256 count = _assetList.length;
        for (uint256 i = 0; i < count; i++) {
            address asset = _assetList[i];
            uint256 balance = IERC20(asset).balanceOf(address(this));
            if (balance != 0) IERC20(asset).safeTransfer(to, balance);
            costBasis[asset] = 0;
        }
        uint256 baseBalance = base.balanceOf(address(this));
        if (baseBalance != 0) base.safeTransfer(to, baseBalance);

        totalShares = 0;
        highWaterMark = PPS_ONE;
        halted = false;
        emit Exited(to);
    }

    /// @notice Recover a token that is neither the base token nor a listed asset.
    function sweep(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(base) || assets[token].listed) revert NotSweepable();
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }

    // --------------------------------------------------------- owner: config

    /// @notice Replace the agent key. Pass the zero address to revoke trading rights.
    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentUpdated(agent_);
    }

    /// @dev A longer TWAP window may make this call enlarge the price history of every
    /// listed pool, which costs gas per added observation (see `_ensureOracle`).
    function setPolicy(Policy calldata policy_) external onlyOwner {
        _validatePolicy(policy_);
        // Every listed pool must be able to serve the new window, or NAV could not be computed.
        uint256 count = _assetList.length;
        for (uint256 i = 0; i < count; i++) {
            address pool = assets[_assetList[i]].pool;
            _ensureOracle(pool, policy_.twapWindow);
            TwapLib.meanTick(pool, policy_.twapWindow);
        }
        _policy = policy_;
        emit PolicyUpdated(policy_);
    }

    /// @notice List an asset, change its pool fee tier, or enable/disable buying it.
    /// @dev Enlarges the pool's price history first if it is too short for the TWAP window.
    function configureAsset(address asset, uint24 fee, bool enabled) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (asset == address(base)) revert AssetIsBase();

        address pool = factory.getPool(asset, address(base), fee);
        if (pool == address(0)) revert PoolNotFound();
        _ensureOracle(pool, _policy.twapWindow);
        // Reverts if the pool cannot serve the TWAP window yet.
        TwapLib.meanTick(pool, _policy.twapWindow);

        AssetConfig storage config = assets[asset];
        if (!config.listed) {
            if (_assetList.length == MAX_ASSETS) revert TooManyAssets();
            _assetList.push(asset);
            config.listed = true;
        }
        config.enabled = enabled;
        config.fee = fee;
        config.pool = pool;
        emit AssetConfigured(asset, fee, pool, enabled);
    }

    /// @notice Clear a tripped breaker and start measuring drawdown from the current NAV.
    function resume() external onlyOwner {
        if (!halted) revert NotHalted();
        halted = false;
        uint256 pps = pricePerShare();
        highWaterMark = pps;
        emit Resumed(pps);
    }

    // -------------------------------------------------------------- trading

    /// @notice Spend `baseIn` of the base token on `asset`.
    /// @param minAssetOut the caller's own minimum; the TWAP floor applies on top of it.
    /// @param memo keccak256 of the off-chain decision record for this trade.
    /// @return assetOut asset received. Zero means the drawdown breaker tripped on this call
    /// and nothing was bought.
    function buy(address asset, uint256 baseIn, uint256 minAssetOut, bytes32 memo)
        external
        onlyOperator
        nonReentrant
        returns (uint256 assetOut)
    {
        if (baseIn == 0) revert ZeroAmount();
        AssetConfig memory config = assets[asset];
        if (!config.listed) revert AssetNotListed();
        if (!config.enabled) revert AssetDisabled();
        if (block.timestamp < lockedUntil[asset]) revert AssetLocked(lockedUntil[asset]);
        if (halted) revert Halted();

        Policy memory p = _policy;
        // If this call is the one that discovers the drawdown breach, record the halt and
        // buy nothing. Reverting here would roll the halt back.
        if (_checkBuyLimits(asset, baseIn, p)) return 0;
        _consumeBuySlot(p);

        uint256 minOut = Math.max(minAssetOut, _twapFloor(config.pool, baseIn, address(base), asset, p));
        uint256 spent;
        (spent, assetOut) = _swap(address(base), asset, config.fee, baseIn, minOut);

        costBasis[asset] += spent;
        _recordTrade(asset, true, spent, assetOut, 0, memo);
    }

    /// @notice Sell `assetIn` of `asset` for the base token. Always allowed for the operator,
    /// including while halted or after the asset was disabled, because it only reduces risk.
    function sell(address asset, uint256 assetIn, uint256 minBaseOut, bytes32 memo)
        external
        onlyOperator
        nonReentrant
        returns (uint256 baseOut)
    {
        if (assetIn == 0) revert ZeroAmount();
        int256 pnl;
        (, baseOut, pnl) = _sell(asset, assetIn, minBaseOut);
        _recordTrade(asset, false, baseOut, assetIn, pnl, memo);
    }

    /// @notice Sell from a position that has lost more than the stop-loss allows. Anyone may
    /// call, so the stop-loss works even when the agent is offline or compromised.
    /// @param assetIn how much to sell; more than the vault holds means all of it. Pass 0 to
    /// sell as much as the pool can take inside the slippage limit right now (`maxSellNow`).
    /// @dev Every sale stays under the TWAP floor, so a position too large for the pool cannot
    /// be closed in one swap. It is closed over several calls instead, each one waiting for
    /// the TWAP to follow the price the one before it left.
    function triggerStopLoss(address asset, uint256 assetIn) external nonReentrant returns (uint256 baseOut) {
        AssetConfig memory config = assets[asset];
        if (!config.listed) revert AssetNotListed();

        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance == 0) revert NothingToSell();

        Policy memory p = _policy;
        uint256 value = _twapQuote(config.pool, balance, asset, address(base), p.twapWindow);
        uint256 threshold = costBasis[asset] * (BPS - p.stopLossBps) / BPS;
        if (value >= threshold) revert StopLossNotReached(value, threshold);

        assetIn = _saleAmount(config, asset, assetIn, balance, p);
        int256 pnl;
        (, baseOut, pnl) = _sell(asset, assetIn, 0);
        lockedUntil[asset] = uint64(block.timestamp) + p.reentryLockout;

        emit StopLossTriggered(asset, msg.sender, assetIn, baseOut);
        _recordTrade(asset, false, baseOut, assetIn, pnl, bytes32("STOP_LOSS"));
    }

    /// @notice While the breaker is tripped, anyone may convert a position back to base token.
    /// @param assetIn as in `triggerStopLoss`: an amount, or 0 for as much as fits right now.
    function flatten(address asset, uint256 assetIn) external nonReentrant returns (uint256 baseOut) {
        if (!halted) revert NotHalted();
        AssetConfig memory config = assets[asset];
        if (!config.listed) revert AssetNotListed();
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance == 0) revert NothingToSell();

        assetIn = _saleAmount(config, asset, assetIn, balance, _policy);
        int256 pnl;
        (, baseOut, pnl) = _sell(asset, assetIn, 0);

        emit Flattened(asset, msg.sender, assetIn, baseOut);
        _recordTrade(asset, false, baseOut, assetIn, pnl, bytes32("BREAKER_FLATTEN"));
    }

    /// @notice Update the high-water mark and trip the breaker if the drawdown limit is breached.
    /// @return tripped whether buying is halted after this call.
    function checkpoint() external nonReentrant returns (bool tripped) {
        return _checkpoint(_nav());
    }

    // ---------------------------------------------------------------- views

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    function assetList() external view returns (address[] memory) {
        return _assetList;
    }

    /// @notice Net asset value in base token: idle base plus every position at its TWAP.
    function nav() external view returns (uint256) {
        return _nav();
    }

    /// @notice NAV per share with 18 decimals. Tracks performance independent of deposits and withdrawals.
    function pricePerShare() public view returns (uint256) {
        return _pps(_nav());
    }

    /// @notice How far NAV per share sits below its peak, in bps.
    function drawdownBps() external view returns (uint256) {
        uint256 pps = pricePerShare();
        if (pps >= highWaterMark) return 0;
        return (highWaterMark - pps) * BPS / highWaterMark;
    }

    function positions() external view returns (Position[] memory list) {
        uint256 count = _assetList.length;
        uint32 window = _policy.twapWindow;
        list = new Position[](count);
        for (uint256 i = 0; i < count; i++) {
            address asset = _assetList[i];
            AssetConfig memory config = assets[asset];
            uint256 balance = IERC20(asset).balanceOf(address(this));
            list[i] = Position({
                asset: asset,
                enabled: config.enabled,
                balance: balance,
                value: balance == 0 ? 0 : _twapQuote(config.pool, balance, asset, address(base), window),
                cost: costBasis[asset],
                lockedUntil: lockedUntil[asset]
            });
        }
    }

    /// @notice Whether `triggerStopLoss(asset)` would succeed right now.
    function stopLossReached(address asset) external view returns (bool) {
        AssetConfig memory config = assets[asset];
        if (!config.listed) return false;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance == 0) return false;
        uint256 value = _twapQuote(config.pool, balance, asset, address(base), _policy.twapWindow);
        return value < costBasis[asset] * (BPS - _policy.stopLossBps) / BPS;
    }

    /// @notice Largest amount of `asset` that one sale can put through its pool right now
    /// without filling below the slippage limit, capped at what the vault holds.
    /// @dev An estimate from the pool's current price and in-range liquidity. The limit
    /// itself is enforced on the swap, so a wrong estimate can only make a sale revert.
    function maxSellNow(address asset) external view returns (uint256) {
        AssetConfig memory config = assets[asset];
        if (!config.listed) return 0;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance == 0) return 0;
        return Math.min(balance, _maxSell(config, asset, _policy));
    }

    /// @notice Amount of `tokenOut` that `amountIn` of `tokenIn` is worth at the TWAP, before fees.
    /// One of the two tokens must be the base token and the other a listed asset.
    function twapQuote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        address asset = tokenIn == address(base) ? tokenOut : tokenIn;
        AssetConfig memory config = assets[asset];
        if (!config.listed) revert AssetNotListed();
        return _twapQuote(config.pool, amountIn, tokenIn, tokenOut, _policy.twapWindow);
    }

    // ------------------------------------------------------------- internal

    function _validatePolicy(Policy memory p) internal pure {
        if (
            p.maxTradeBps == 0 || p.maxTradeBps > BPS || p.maxPositionBps == 0 || p.maxPositionBps > BPS
                || p.maxExposureBps == 0 || p.maxExposureBps > BPS || p.maxSlippageBps == 0 || p.maxSlippageBps > 1_000
                || p.stopLossBps < 10 || p.stopLossBps > 9_000 || p.maxDrawdownBps < 10 || p.maxDrawdownBps > 9_000
                || p.maxTradesPerDay == 0 || p.cooldown > 7 days || p.twapWindow < 60 || p.twapWindow > 1 hours
                || p.reentryLockout > 30 days
        ) revert InvalidPolicy();
    }

    function _twapQuote(address pool, uint256 amountIn, address tokenIn, address tokenOut, uint32 window)
        internal
        view
        returns (uint256)
    {
        return TwapLib.quoteAtTick(TwapLib.meanTick(pool, window), amountIn, tokenIn, tokenOut);
    }

    /// @dev Makes sure `pool` keeps enough price observations for `window` seconds of history
    /// to survive even if every block writes one. A pool with fewer loses its history to
    /// ordinary trading: with the single slot a new pool starts with, the vault's own swap
    /// overwrites the only observation and the valuation that follows it reverts.
    /// Each added observation costs about 22,000 gas. If that is too much for one
    /// transaction, anyone can enlarge the pool in steps beforehand.
    function _ensureOracle(address pool, uint32 window) internal {
        uint16 needed = uint16(window / MIN_BLOCK_SECONDS + 1);
        (,,,, uint16 next,,) = IUniswapV3Pool(pool).slot0();
        if (next < needed) IUniswapV3Pool(pool).increaseObservationCardinalityNext(needed);
    }

    /// @dev Estimate of the most that one sale of `asset` can put through its pool inside the
    /// slippage limit. A tenth of the allowance is kept back for rounding and for liquidity
    /// that thins out along the way.
    function _maxSell(AssetConfig memory config, address asset, Policy memory p) internal view returns (uint256) {
        uint256 usable = uint256(p.maxSlippageBps) - p.maxSlippageBps / 10;
        return TwapLib.maxInputAboveFloor(
            config.pool, TwapLib.meanTick(config.pool, p.twapWindow), asset, address(base), config.fee, BPS - usable
        );
    }

    /// @dev Amount a permissionless sale will sell: what was asked for, or what fits when
    /// nothing was asked for, never more than the balance.
    function _saleAmount(AssetConfig memory config, address asset, uint256 requested, uint256 balance, Policy memory p)
        internal
        view
        returns (uint256)
    {
        if (requested == 0) {
            requested = _maxSell(config, asset, p);
            if (requested == 0) revert NoRoomToSell();
        }
        return requested > balance ? balance : requested;
    }

    function _nav() internal view returns (uint256 total) {
        (total,,) = _valuation(address(0));
    }

    /// @return total NAV in base token
    /// @return exposure combined worth of all asset positions
    /// @return focusValue worth of the position in `focus`
    function _valuation(address focus) internal view returns (uint256 total, uint256 exposure, uint256 focusValue) {
        uint256 count = _assetList.length;
        uint32 window = _policy.twapWindow;
        for (uint256 i = 0; i < count; i++) {
            address asset = _assetList[i];
            uint256 balance = IERC20(asset).balanceOf(address(this));
            if (balance == 0) continue;
            uint256 value = _twapQuote(assets[asset].pool, balance, asset, address(base), window);
            exposure += value;
            if (asset == focus) focusValue = value;
        }
        total = base.balanceOf(address(this)) + exposure;
    }

    function _pps(uint256 navNow) internal view returns (uint256) {
        if (totalShares == 0) return PPS_ONE;
        return Math.mulDiv(navNow, PPS_ONE, totalShares);
    }

    /// @dev Raises the high-water mark or trips the breaker. Returns whether buying is halted.
    function _checkpoint(uint256 navNow) internal returns (bool) {
        if (halted) return true;
        if (totalShares == 0) return false;

        uint256 pps = _pps(navNow);
        uint256 peak = highWaterMark;
        if (pps > peak) {
            highWaterMark = pps;
        } else if (pps < peak * (BPS - _policy.maxDrawdownBps) / BPS) {
            halted = true;
            emit BreakerTripped(pps, peak);
            return true;
        }
        return false;
    }

    /// @dev Checks the drawdown breaker and the three size limits for a buy of `baseIn`.
    /// @return tripped true when the breaker tripped on this call; the caller must not trade.
    function _checkBuyLimits(address asset, uint256 baseIn, Policy memory p) internal returns (bool tripped) {
        (uint256 navBefore, uint256 exposure, uint256 positionValue) = _valuation(asset);
        if (navBefore == 0) revert EmptyVault();
        if (_checkpoint(navBefore)) return true;

        uint256 limit = navBefore * p.maxTradeBps / BPS;
        if (baseIn > limit) revert TradeTooLarge(baseIn, limit);
        limit = navBefore * p.maxPositionBps / BPS;
        if (positionValue + baseIn > limit) revert PositionTooLarge(positionValue + baseIn, limit);
        limit = navBefore * p.maxExposureBps / BPS;
        if (exposure + baseIn > limit) revert ExposureTooLarge(exposure + baseIn, limit);
    }

    /// @dev Least acceptable output for a swap of `amountIn`: the TWAP quote less the slippage allowance.
    function _twapFloor(address pool, uint256 amountIn, address tokenIn, address tokenOut, Policy memory p)
        internal
        view
        returns (uint256)
    {
        return _twapQuote(pool, amountIn, tokenIn, tokenOut, p.twapWindow) * (BPS - p.maxSlippageBps) / BPS;
    }

    /// @dev Enforces the cooldown and the daily buy count, then records this buy.
    function _consumeBuySlot(Policy memory p) internal {
        uint64 nowTs = uint64(block.timestamp);
        if (lastBuyAt != 0 && nowTs < lastBuyAt + p.cooldown) revert CooldownActive(lastBuyAt + p.cooldown);

        uint64 day = nowTs / 1 days;
        if (day != currentDay) {
            currentDay = day;
            buysToday = 0;
        }
        if (buysToday >= p.maxTradesPerDay) revert DailyLimitReached();

        buysToday += 1;
        lastBuyAt = nowTs;
    }

    /// @dev Sells `assetIn` with the TWAP floor applied and reduces the cost basis pro rata.
    function _sell(address asset, uint256 assetIn, uint256 minBaseOut)
        internal
        returns (uint256 sold, uint256 baseOut, int256 pnl)
    {
        AssetConfig memory config = assets[asset];
        if (!config.listed) revert AssetNotListed();

        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (assetIn > balance) revert InsufficientAsset();

        uint256 minOut = Math.max(minBaseOut, _twapFloor(config.pool, assetIn, asset, address(base), _policy));
        (sold, baseOut) = _swap(asset, address(base), config.fee, assetIn, minOut);

        uint256 costRemoved = Math.mulDiv(costBasis[asset], sold, balance);
        costBasis[asset] -= costRemoved;
        pnl = int256(baseOut) - int256(costRemoved);
    }

    /// @dev Swaps through the router and measures both legs by balance difference.
    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 spent, uint256 received)
    {
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(address(router), amountIn);
        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(router), 0);

        spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < minOut) revert Slippage(received, minOut);
    }

    function _recordTrade(address asset, bool isBuy, uint256 baseAmount, uint256 assetAmount, int256 pnl, bytes32 memo)
        internal
    {
        uint256 navAfter = _nav();
        _checkpoint(navAfter);
        emit Trade(asset, isBuy, baseAmount, assetAmount, pnl, memo, navAfter, _pps(navAfter));
    }
}
