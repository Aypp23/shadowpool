// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";

import {ShadowPoolRootRegistry} from "./ShadowPoolRootRegistry.sol";

contract ShadowPoolHook is BaseHook, Ownable {
    error RootNotSet();
    error RootExpired();
    error InvalidProof();
    error LeafAlreadyUsed();
    error MatchAlreadyUsed();
    error InvalidHookData();
    error InvalidSignature();
    error MatchExpired();
    error UnauthorizedCaller();
    error InvalidSwapParams();
    error InvalidTeeSigner();
    error MinAmountOutNotMet();

    uint256 private constant BPS = 10_000;
    uint256 private constant MIN_OUT_BPS = 0;

    ShadowPoolRootRegistry public immutable rootRegistry;
    address public teeSigner;
    mapping(address caller => bool allowed) public allowedCaller;

    mapping(bytes32 roundId => mapping(bytes32 leaf => bool used)) public leafUsed;
    mapping(bytes32 roundId => mapping(bytes32 matchIdHash => bool used)) public matchUsed;

    struct HookPayload {
        bytes32 roundId;
        bytes32 matchIdHash;
        address trader;
        address counterparty;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expiry;
        bytes32[] proof;
        bytes signature;
    }

    event TradeExecuted(
        bytes32 indexed roundId,
        bytes32 indexed matchIdHash,
        address indexed trader,
        address counterparty,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry
    );

    constructor(IPoolManager manager, ShadowPoolRootRegistry registry, address owner, address teeSigner_)
        BaseHook(manager)
        Ownable(owner)
    {
        rootRegistry = registry;
        if (teeSigner_ == address(0)) revert InvalidTeeSigner();
        teeSigner = teeSigner_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function setTeeSigner(address newTeeSigner) external onlyOwner {
        if (newTeeSigner == address(0)) revert InvalidTeeSigner();
        teeSigner = newTeeSigner;
    }

    function setAllowedCaller(address caller, bool allowed) external onlyOwner {
        allowedCaller[caller] = allowed;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        HookPayload memory p = _decodeHookData(hookData);

        if (sender != p.trader && !allowedCaller[sender]) revert UnauthorizedCaller();
        if (params.amountSpecified >= 0) revert InvalidSwapParams();
        if (uint256(-params.amountSpecified) != p.amountIn) revert InvalidSwapParams();

        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        address expectedTokenIn = params.zeroForOne ? currency0 : currency1;
        address expectedTokenOut = params.zeroForOne ? currency1 : currency0;

        if (p.tokenIn != expectedTokenIn || p.tokenOut != expectedTokenOut) revert InvalidSwapParams();

        bytes32 root = rootRegistry.getRoot(p.roundId);
        if (root == bytes32(0)) revert RootNotSet();

        uint256 validUntil = rootRegistry.getRootValidUntil(p.roundId);
        if (block.timestamp > validUntil) revert RootExpired();

        if (block.timestamp > p.expiry) revert MatchExpired();

        if (matchUsed[p.roundId][p.matchIdHash]) revert MatchAlreadyUsed();

        bytes32 leaf = _leaf(p);

        if (leafUsed[p.roundId][leaf]) revert LeafAlreadyUsed();
        if (!MerkleProof.verify(p.proof, root, leaf)) revert InvalidProof();

        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(leaf), p.signature);
        if (recovered != teeSigner) revert InvalidSignature();

        matchUsed[p.roundId][p.matchIdHash] = true;
        leafUsed[p.roundId][leaf] = true;

        emit TradeExecuted(
            p.roundId,
            p.matchIdHash,
            p.trader,
            p.counterparty,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            p.minAmountOut,
            p.expiry
        );

        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4, int128) {
        HookPayload memory p = _decodeHookData(hookData);

        int128 tokenOutDelta = params.zeroForOne ? delta.amount1() : delta.amount0();
        if (tokenOutDelta <= 0) revert InvalidSwapParams();

        uint256 amountOut = uint256(uint128(tokenOutDelta));
        uint256 minAmountOut = (p.minAmountOut * MIN_OUT_BPS) / BPS;
        if (amountOut < minAmountOut) revert MinAmountOutNotMet();

        return (BaseHook.afterSwap.selector, 0);
    }

    function _decodeHookData(bytes calldata hookData) private pure returns (HookPayload memory p) {
        if (hookData.length == 0) revert InvalidHookData();
        p = abi.decode(hookData, (HookPayload));
    }

    function _leaf(HookPayload memory p) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                p.roundId,
                p.matchIdHash,
                p.trader,
                p.counterparty,
                p.tokenIn,
                p.tokenOut,
                p.amountIn,
                p.minAmountOut,
                p.expiry
            )
        );
    }
}
