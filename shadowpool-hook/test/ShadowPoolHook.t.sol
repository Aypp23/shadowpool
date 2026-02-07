// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "forge-std/console2.sol";

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {ShadowPoolRootRegistry} from "../src/ShadowPoolRootRegistry.sol";
import {ShadowPoolHook} from "../src/ShadowPoolHook.sol";

contract ShadowPoolHookTestable is ShadowPoolHook {
    constructor(IPoolManager manager, ShadowPoolRootRegistry registry, address owner, address teeSigner)
        ShadowPoolHook(manager, registry, owner, teeSigner)
    {}

    function validateHookAddress(BaseHook) internal pure override {}
}

contract ShadowPoolHookTest is Test, Deployers {
    ShadowPoolRootRegistry registry;
    ShadowPoolHookTestable hook;
    uint256 constant TEE_PRIVATE_KEY = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 constant TRADER_PRIVATE_KEY1_DEFAULT =
        bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    bytes32 constant TRADER_PRIVATE_KEY2_DEFAULT =
        bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
    address teeSigner;

    struct MatchPayload {
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

    struct Payload {
        bytes32 roundId;
        bytes32 matchIdHash;
        address trader;
        address counterparty;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expiry;
    }

    function _paramsForSwap(bool zeroForOne, int256 amountSpecified) private pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        registry = new ShadowPoolRootRegistry(address(this));
        teeSigner = vm.addr(TEE_PRIVATE_KEY);
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(ShadowPoolHookTestable).creationCode,
            abi.encode(manager, registry, address(this), teeSigner)
        );
        hook = new ShadowPoolHookTestable{salt: salt}(manager, registry, address(this), teeSigner);
        assertEq(address(hook), hookAddress);
        hook.setAllowedCaller(address(swapRouter), true);

        (key,) = initPool(currency0, currency1, IHooks(address(hook)), 0, int24(60), SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);
        seedMoreLiquidity(key, 1_000_000e18, 1_000_000e18);
    }

    function test_swapSucceedsWithValidProof() public {
        Payload memory p = Payload({
            roundId: keccak256("round_1"),
            matchIdHash: keccak256("match_1"),
            trader: makeAddr("trader"),
            counterparty: makeAddr("counterparty"),
            tokenIn: Currency.unwrap(currency0),
            tokenOut: Currency.unwrap(currency1),
            amountIn: 100,
            minAmountOut: 99,
            expiry: block.timestamp + 3600
        });

        bytes32 leaf = _leaf(p);
        bytes32 otherLeaf = _leaf(
            Payload({
                roundId: p.roundId,
                matchIdHash: keccak256("match_2"),
                trader: p.trader,
                counterparty: p.counterparty,
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                amountIn: p.amountIn,
                minAmountOut: p.minAmountOut,
                expiry: p.expiry
            })
        );

        bytes32 root = _hashPair(leaf, otherLeaf);
        registry.closeRound(p.roundId);
        registry.postRoot(p.roundId, root, p.expiry);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = otherLeaf;

        bytes memory signature = _signLeaf(leaf);
        bytes memory hookData = _encodeHookData(
            p.roundId,
            p.matchIdHash,
            p.trader,
            p.counterparty,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            p.minAmountOut,
            p.expiry,
            proof,
            signature
        );

        swap(key, SWAP_PARAMS.zeroForOne, SWAP_PARAMS.amountSpecified, hookData);

        assertTrue(hook.leafUsed(p.roundId, leaf));
    }

    function test_revertsOnInvalidProof() public {
        Payload memory p = Payload({
            roundId: keccak256("round_1"),
            matchIdHash: keccak256("match_1"),
            trader: makeAddr("trader"),
            counterparty: makeAddr("counterparty"),
            tokenIn: Currency.unwrap(currency0),
            tokenOut: Currency.unwrap(currency1),
            amountIn: 100,
            minAmountOut: 99,
            expiry: block.timestamp + 3600
        });

        bytes32 leaf = _leaf(p);
        bytes32 otherLeaf = _leaf(
            Payload({
                roundId: p.roundId,
                matchIdHash: keccak256("match_2"),
                trader: p.trader,
                counterparty: p.counterparty,
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                amountIn: p.amountIn,
                minAmountOut: p.minAmountOut,
                expiry: p.expiry
            })
        );

        bytes32 root = _hashPair(leaf, otherLeaf);
        registry.closeRound(p.roundId);
        registry.postRoot(p.roundId, root, p.expiry);

        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = bytes32(uint256(123));

        bytes memory signature = _signLeaf(leaf);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodePacked(ShadowPoolHook.InvalidProof.selector),
                abi.encodePacked(Hooks.HookCallFailed.selector)
            )
        );
        bytes memory hookData = _encodeHookData(
            p.roundId,
            p.matchIdHash,
            p.trader,
            p.counterparty,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            p.minAmountOut,
            p.expiry,
            badProof,
            signature
        );
        swap(key, SWAP_PARAMS.zeroForOne, SWAP_PARAMS.amountSpecified, hookData);
    }

    function test_revertsOnReplay() public {
        Payload memory p = Payload({
            roundId: keccak256("round_1"),
            matchIdHash: keccak256("match_1"),
            trader: makeAddr("trader"),
            counterparty: makeAddr("counterparty"),
            tokenIn: Currency.unwrap(currency0),
            tokenOut: Currency.unwrap(currency1),
            amountIn: 100,
            minAmountOut: 99,
            expiry: block.timestamp + 3600
        });

        bytes32 leaf = _leaf(p);
        bytes32 otherLeaf = _leaf(
            Payload({
                roundId: p.roundId,
                matchIdHash: keccak256("match_2"),
                trader: p.trader,
                counterparty: p.counterparty,
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                amountIn: p.amountIn,
                minAmountOut: p.minAmountOut,
                expiry: p.expiry
            })
        );

        bytes32 root = _hashPair(leaf, otherLeaf);
        registry.closeRound(p.roundId);
        registry.postRoot(p.roundId, root, p.expiry);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = otherLeaf;

        bytes memory signature = _signLeaf(leaf);
        bytes memory hookData = _encodeHookData(
            p.roundId,
            p.matchIdHash,
            p.trader,
            p.counterparty,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            p.minAmountOut,
            p.expiry,
            proof,
            signature
        );

        swap(key, SWAP_PARAMS.zeroForOne, SWAP_PARAMS.amountSpecified, hookData);

        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodePacked(ShadowPoolHook.MatchAlreadyUsed.selector),
                abi.encodePacked(Hooks.HookCallFailed.selector)
            )
        );
        swap(key, SWAP_PARAMS.zeroForOne, SWAP_PARAMS.amountSpecified, hookData);
    }

    function test_revertsWhenRootMissing() public {
        Payload memory p = Payload({
            roundId: keccak256("round_1"),
            matchIdHash: keccak256("match_1"),
            trader: makeAddr("trader"),
            counterparty: makeAddr("counterparty"),
            tokenIn: Currency.unwrap(currency0),
            tokenOut: Currency.unwrap(currency1),
            amountIn: 100,
            minAmountOut: 99,
            expiry: block.timestamp + 3600
        });
        bytes32[] memory proof = new bytes32[](0);
        bytes memory signature = _signLeaf(_leaf(p));

        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodePacked(ShadowPoolHook.RootNotSet.selector),
                abi.encodePacked(Hooks.HookCallFailed.selector)
            )
        );
        bytes memory hookData = _encodeHookData(
            p.roundId,
            p.matchIdHash,
            p.trader,
            p.counterparty,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            p.minAmountOut,
            p.expiry,
            proof,
            signature
        );
        swap(key, SWAP_PARAMS.zeroForOne, SWAP_PARAMS.amountSpecified, hookData);
    }

    function test_endToEndRound() public {
        vm.warp(1_700_000_000);

        address token0 = Currency.unwrap(currency0);
        address token1 = Currency.unwrap(currency1);

        bytes32 pkABytes = vm.envOr("TEST_PRIVATE_KEY1", TRADER_PRIVATE_KEY1_DEFAULT);
        bytes32 pkBBytes = vm.envOr("TEST_PRIVATE_KEY2", TRADER_PRIVATE_KEY2_DEFAULT);
        address traderA = vm.addr(uint256(pkABytes));
        address traderB = vm.addr(uint256(pkBBytes));

        uint256 seed = 1000e18;
        MockERC20(token0).transfer(traderA, seed);
        MockERC20(token0).transfer(traderB, seed);
        MockERC20(token1).transfer(traderA, seed);
        MockERC20(token1).transfer(traderB, seed);

        vm.prank(traderA);
        MockERC20(token0).approve(address(swapRouter), type(uint256).max);
        vm.prank(traderA);
        MockERC20(token1).approve(address(swapRouter), type(uint256).max);
        vm.prank(traderB);
        MockERC20(token0).approve(address(swapRouter), type(uint256).max);
        vm.prank(traderB);
        MockERC20(token1).approve(address(swapRouter), type(uint256).max);

        bytes32 roundId = keccak256(bytes("round_001"));
        uint256 expiry = block.timestamp + 3600;

        string[] memory intents = new string[](2);
        intents[0] = _intentJson("buy", traderA, token0, token1, expiry);
        intents[1] = _intentJson("sell", traderB, token0, token1, expiry);
        string memory resultJson = _runIappWithIntents(intents, "round_001");

        bytes32 roundIdBytes32 = vm.parseJsonBytes32(resultJson, ".roundIdBytes32");
        assertEq(roundIdBytes32, roundId);

        bytes32 merkleRoot = vm.parseJsonBytes32(resultJson, ".merkleRoot");
        address iappTeeSigner = vm.parseJsonAddress(resultJson, ".teeSigner");
        assertEq(iappTeeSigner, teeSigner);

        uint256 roundExpiry = vm.parseJsonUint(resultJson, ".roundExpiry");
        registry.closeRound(roundId);
        registry.postRoot(roundId, merkleRoot, roundExpiry);
        assertEq(registry.getRoot(roundId), merkleRoot);

        uint256 a0Before = MockERC20(token0).balanceOf(traderA);
        uint256 a1Before = MockERC20(token1).balanceOf(traderA);
        uint256 b0Before = MockERC20(token0).balanceOf(traderB);
        uint256 b1Before = MockERC20(token1).balanceOf(traderB);

        MatchPayload memory m0 = _readMatch(resultJson, 0);
        MatchPayload memory m1 = _readMatch(resultJson, 1);

        assertEq(m0.amountIn, 10e18);
        assertEq(m1.amountIn, 10e18);

        _executeMatchWithExpect(roundId, token0, m0);
        _executeMatchWithExpect(roundId, token0, m1);

        uint256 a0After = MockERC20(token0).balanceOf(traderA);
        uint256 a1After = MockERC20(token1).balanceOf(traderA);
        uint256 b0After = MockERC20(token0).balanceOf(traderB);
        uint256 b1After = MockERC20(token1).balanceOf(traderB);

        uint256 expectedTrade = 10e18;
        uint256 maxSlippageAbs = expectedTrade / 1000;

        assertEq(m0.trader, traderA);
        assertEq(m1.trader, traderB);

        uint256 a0Gain = a0After - a0Before;
        uint256 a1Paid = a1Before - a1After;
        uint256 b0Paid = b0Before - b0After;
        uint256 b1Gain = b1After - b1Before;

        assertLe(a0Gain > expectedTrade ? a0Gain - expectedTrade : expectedTrade - a0Gain, maxSlippageAbs);
        assertLe(a1Paid > expectedTrade ? a1Paid - expectedTrade : expectedTrade - a1Paid, maxSlippageAbs);
        assertLe(b0Paid > expectedTrade ? b0Paid - expectedTrade : expectedTrade - b0Paid, maxSlippageAbs);
        assertLe(b1Gain > expectedTrade ? b1Gain - expectedTrade : expectedTrade - b1Gain, maxSlippageAbs);
    }

    function test_endToEndMultipleIntentsWithPartialFills() public {
        vm.warp(1_700_000_000);

        address token0 = Currency.unwrap(currency0);
        address token1 = Currency.unwrap(currency1);

        bytes32 pkABytes = vm.envOr("TEST_PRIVATE_KEY1", TRADER_PRIVATE_KEY1_DEFAULT);
        bytes32 pkBBytes = vm.envOr("TEST_PRIVATE_KEY2", TRADER_PRIVATE_KEY2_DEFAULT);
        address traderA = vm.addr(uint256(pkABytes));
        address traderB = vm.addr(uint256(pkBBytes));
        address traderC = makeAddr("traderC");
        address traderD = makeAddr("traderD");

        uint256 seed = 1000e18;
        _seedAndApprove(token0, token1, traderA, seed);
        _seedAndApprove(token0, token1, traderB, seed);
        _seedAndApprove(token0, token1, traderC, seed);
        _seedAndApprove(token0, token1, traderD, seed);

        bytes32 roundId = keccak256(bytes("round_multi_001"));
        uint256 expiry = block.timestamp + 3600;

        string[] memory intents = new string[](4);
        intents[0] = _intentJsonCustom("buy", traderA, token0, token1, "10", "1", expiry);
        intents[1] = _intentJsonCustom("buy", traderC, token0, token1, "5", "1", expiry);
        intents[2] = _intentJsonCustom("sell", traderB, token0, token1, "6", "1", expiry);
        intents[3] = _intentJsonCustom("sell", traderD, token0, token1, "9", "1", expiry);

        string memory resultJson = _runIappWithIntents(intents, "round_multi_001");
        uint256 eligibleIntentsCount = vm.parseJsonUint(resultJson, ".eligibleIntentsCount");
        assertEq(eligibleIntentsCount, 4);

        uint256 matchCount = _countMatches(resultJson, 64);
        assertEq(matchCount, 6);

        bytes32 merkleRoot = vm.parseJsonBytes32(resultJson, ".merkleRoot");
        address iappTeeSigner = vm.parseJsonAddress(resultJson, ".teeSigner");
        assertEq(iappTeeSigner, teeSigner);

        registry.closeRound(roundId);
        uint256 roundExpiry = vm.parseJsonUint(resultJson, ".roundExpiry");
        registry.postRoot(roundId, merkleRoot, roundExpiry);
        assertEq(registry.getRoot(roundId), merkleRoot);

        uint256 a0Before = MockERC20(token0).balanceOf(traderA);
        uint256 a1Before = MockERC20(token1).balanceOf(traderA);
        uint256 b0Before = MockERC20(token0).balanceOf(traderB);
        uint256 b1Before = MockERC20(token1).balanceOf(traderB);
        uint256 c0Before = MockERC20(token0).balanceOf(traderC);
        uint256 c1Before = MockERC20(token1).balanceOf(traderC);
        uint256 d0Before = MockERC20(token0).balanceOf(traderD);
        uint256 d1Before = MockERC20(token1).balanceOf(traderD);

        MatchPayload memory m0 = _readMatch(resultJson, 0);
        MatchPayload memory m1 = _readMatch(resultJson, 1);
        MatchPayload memory m2 = _readMatch(resultJson, 2);
        MatchPayload memory m3 = _readMatch(resultJson, 3);
        MatchPayload memory m4 = _readMatch(resultJson, 4);
        MatchPayload memory m5 = _readMatch(resultJson, 5);

        _executeMatchWithExpect(roundId, token0, m0);
        _executeMatchWithExpect(roundId, token0, m1);
        _executeMatchWithExpect(roundId, token0, m2);
        _executeMatchWithExpect(roundId, token0, m3);
        _executeMatchWithExpect(roundId, token0, m4);
        _executeMatchWithExpect(roundId, token0, m5);

        uint256 a0After = MockERC20(token0).balanceOf(traderA);
        uint256 a1After = MockERC20(token1).balanceOf(traderA);
        uint256 b0After = MockERC20(token0).balanceOf(traderB);
        uint256 b1After = MockERC20(token1).balanceOf(traderB);
        uint256 c0After = MockERC20(token0).balanceOf(traderC);
        uint256 c1After = MockERC20(token1).balanceOf(traderC);
        uint256 d0After = MockERC20(token0).balanceOf(traderD);
        uint256 d1After = MockERC20(token1).balanceOf(traderD);

        uint256 expectedATotal = 10e18;
        uint256 expectedCTotal = 5e18;
        uint256 expectedBTotal = 6e18;
        uint256 expectedDTotal = 9e18;
        uint256 maxSlippageAbsA = expectedATotal / 1000;
        uint256 maxSlippageAbsC = expectedCTotal / 1000;
        uint256 maxSlippageAbsB = expectedBTotal / 1000;
        uint256 maxSlippageAbsD = expectedDTotal / 1000;

        uint256 a0Gain = a0After - a0Before;
        uint256 a1Paid = a1Before - a1After;
        uint256 b0Paid = b0Before - b0After;
        uint256 b1Gain = b1After - b1Before;
        uint256 c0Gain = c0After - c0Before;
        uint256 c1Paid = c1Before - c1After;
        uint256 d0Paid = d0Before - d0After;
        uint256 d1Gain = d1After - d1Before;

        assertLe(a0Gain > expectedATotal ? a0Gain - expectedATotal : expectedATotal - a0Gain, maxSlippageAbsA);
        assertLe(a1Paid > expectedATotal ? a1Paid - expectedATotal : expectedATotal - a1Paid, maxSlippageAbsA);
        assertLe(b0Paid > expectedBTotal ? b0Paid - expectedBTotal : expectedBTotal - b0Paid, maxSlippageAbsB);
        assertLe(b1Gain > expectedBTotal ? b1Gain - expectedBTotal : expectedBTotal - b1Gain, maxSlippageAbsB);
        assertLe(c0Gain > expectedCTotal ? c0Gain - expectedCTotal : expectedCTotal - c0Gain, maxSlippageAbsC);
        assertLe(c1Paid > expectedCTotal ? c1Paid - expectedCTotal : expectedCTotal - c1Paid, maxSlippageAbsC);
        assertLe(d0Paid > expectedDTotal ? d0Paid - expectedDTotal : expectedDTotal - d0Paid, maxSlippageAbsD);
        assertLe(d1Gain > expectedDTotal ? d1Gain - expectedDTotal : expectedDTotal - d1Gain, maxSlippageAbsD);
    }

    function test_endToEndMultiplePairs() public {
        vm.warp(1_700_000_000);

        address token0 = Currency.unwrap(currency0);
        address token1 = Currency.unwrap(currency1);

        Currency currency2 = deployMintAndApproveCurrency();
        address token2 = Currency.unwrap(currency2);

        Currency poolCurrency0 = currency0;
        Currency poolCurrency2 = currency2;
        if (Currency.unwrap(poolCurrency0) > Currency.unwrap(poolCurrency2)) {
            (poolCurrency0, poolCurrency2) = (poolCurrency2, poolCurrency0);
        }

        (PoolKey memory key02,) =
            initPool(poolCurrency0, poolCurrency2, IHooks(address(hook)), 0, int24(60), SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(key02, LIQUIDITY_PARAMS, ZERO_BYTES);
        seedMoreLiquidity(key02, 1_000_000e18, 1_000_000e18);

        bytes32 pkABytes = vm.envOr("TEST_PRIVATE_KEY1", TRADER_PRIVATE_KEY1_DEFAULT);
        bytes32 pkBBytes = vm.envOr("TEST_PRIVATE_KEY2", TRADER_PRIVATE_KEY2_DEFAULT);
        address traderA = vm.addr(uint256(pkABytes));
        address traderB = vm.addr(uint256(pkBBytes));

        uint256 seed = 1000e18;
        _seedAndApprove(token0, token1, traderA, seed);
        _seedAndApprove(token0, token1, traderB, seed);
        _seedAndApprove(token0, token2, traderA, seed);
        _seedAndApprove(token0, token2, traderB, seed);

        bytes32 roundId = keccak256(bytes("round_pairs_001"));
        uint256 expiry = block.timestamp + 3600;

        string[] memory intents = new string[](4);
        intents[0] = _intentJson("buy", traderA, token0, token1, expiry);
        intents[1] = _intentJson("sell", traderB, token0, token1, expiry);
        intents[2] = _intentJson("buy", traderA, token0, token2, expiry);
        intents[3] = _intentJson("sell", traderB, token0, token2, expiry);

        string memory resultJson = _runIappWithIntents(intents, "round_pairs_001");
        uint256 eligibleIntentsCount = vm.parseJsonUint(resultJson, ".eligibleIntentsCount");
        assertEq(eligibleIntentsCount, 4);

        uint256 matchCount = _countMatches(resultJson, 64);
        assertEq(matchCount, 4);

        bytes32 merkleRoot = vm.parseJsonBytes32(resultJson, ".merkleRoot");
        address iappTeeSigner = vm.parseJsonAddress(resultJson, ".teeSigner");
        assertEq(iappTeeSigner, teeSigner);

        uint256 roundExpiry = vm.parseJsonUint(resultJson, ".roundExpiry");
        registry.closeRound(roundId);
        registry.postRoot(roundId, merkleRoot, roundExpiry);
        assertEq(registry.getRoot(roundId), merkleRoot);

        MatchPayload memory m0 = _readMatch(resultJson, 0);
        MatchPayload memory m1 = _readMatch(resultJson, 1);
        MatchPayload memory m2 = _readMatch(resultJson, 2);
        MatchPayload memory m3 = _readMatch(resultJson, 3);

        _executeMatchRouted(roundId, token0, token1, token2, key, key02, m0);
        _executeMatchRouted(roundId, token0, token1, token2, key, key02, m1);
        _executeMatchRouted(roundId, token0, token1, token2, key, key02, m2);
        _executeMatchRouted(roundId, token0, token1, token2, key, key02, m3);
    }

    function test_submitIntentTracksPositionAndPreventsDuplicates() public {
        bytes32 roundId = keccak256("round_submit_1");

        address pd1 = makeAddr("protectedData1");
        address pd2 = makeAddr("protectedData2");

        uint256 pos1 = registry.submitIntent(roundId, pd1);
        assertEq(pos1, 1);
        uint256 pos2 = registry.submitIntent(roundId, pd2);
        assertEq(pos2, 2);

        assertEq(registry.getIntentCount(roundId), 2);
        assertEq(registry.getIntentAt(roundId, 0), pd1);
        assertEq(registry.getIntentAt(roundId, 1), pd2);

        vm.expectRevert(ShadowPoolRootRegistry.IntentAlreadySubmitted.selector);
        registry.submitIntent(roundId, pd1);

        registry.closeRound(roundId);
        vm.expectRevert(ShadowPoolRootRegistry.RoundClosed.selector);
        registry.submitIntent(roundId, makeAddr("protectedData3"));
    }

    function test_revertsPostingRootWhenRoundNotClosed() public {
        bytes32 roundId = keccak256("round_root_1");
        bytes32 root = keccak256("root");

        vm.expectRevert(ShadowPoolRootRegistry.RoundNotClosed.selector);
        registry.postRoot(roundId, root, block.timestamp + 1);
    }

    function _leaf(Payload memory p) private pure returns (bytes32) {
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

    function _seedAndApprove(address token0, address token1, address trader, uint256 seed) private {
        MockERC20(token0).transfer(trader, seed);
        MockERC20(token1).transfer(trader, seed);
        vm.prank(trader);
        MockERC20(token0).approve(address(swapRouter), type(uint256).max);
        vm.prank(trader);
        MockERC20(token1).approve(address(swapRouter), type(uint256).max);
    }

    function _readMatch(string memory resultJson, uint256 idx) private view returns (MatchPayload memory m) {
        string memory idxStr = vm.toString(idx);
        string memory base = string.concat(".matches[", idxStr, "]");

        m.matchIdHash = vm.parseJsonBytes32(resultJson, string.concat(base, ".matchIdHash"));
        m.trader = vm.parseJsonAddress(resultJson, string.concat(base, ".trader"));
        m.counterparty = vm.parseJsonAddress(resultJson, string.concat(base, ".counterparty"));
        m.tokenIn = vm.parseJsonAddress(resultJson, string.concat(base, ".tokenIn"));
        m.tokenOut = vm.parseJsonAddress(resultJson, string.concat(base, ".tokenOut"));
        m.amountIn = vm.parseUint(vm.parseJsonString(resultJson, string.concat(base, ".amountIn")));
        m.minAmountOut = vm.parseUint(vm.parseJsonString(resultJson, string.concat(base, ".minAmountOut")));
        m.expiry = vm.parseJsonUint(resultJson, string.concat(base, ".expiry"));
        m.proof = vm.parseJsonBytes32Array(resultJson, string.concat(base, ".merkleProof"));
        m.signature = vm.parseJsonBytes(resultJson, string.concat(base, ".signature"));
    }

    function _executeMatchWithExpect(bytes32 roundId, address poolCurrency0, MatchPayload memory m) private {
        vm.expectEmit(true, true, true, true, address(hook));
        emit ShadowPoolHook.TradeExecuted(
            roundId,
            m.matchIdHash,
            m.trader,
            m.counterparty,
            m.tokenIn,
            m.tokenOut,
            m.amountIn,
            m.minAmountOut,
            m.expiry
        );

        bool zeroForOne = m.tokenIn == poolCurrency0;
        vm.prank(m.trader);
        swap(
            key,
            zeroForOne,
            -int256(m.amountIn),
            _encodeHookData(
                roundId,
                m.matchIdHash,
                m.trader,
                m.counterparty,
                m.tokenIn,
                m.tokenOut,
                m.amountIn,
                m.minAmountOut,
                m.expiry,
                m.proof,
                m.signature
            )
        );
    }

    function _executeMatchRouted(
        bytes32 roundId,
        address token0,
        address token1,
        address token2,
        PoolKey memory key01,
        PoolKey memory key02,
        MatchPayload memory m
    ) private {
        vm.expectEmit(true, true, true, true, address(hook));
        emit ShadowPoolHook.TradeExecuted(
            roundId,
            m.matchIdHash,
            m.trader,
            m.counterparty,
            m.tokenIn,
            m.tokenOut,
            m.amountIn,
            m.minAmountOut,
            m.expiry
        );

        bool is01 = (m.tokenIn == token0 && m.tokenOut == token1) || (m.tokenIn == token1 && m.tokenOut == token0);
        bool is02 = (m.tokenIn == token0 && m.tokenOut == token2) || (m.tokenIn == token2 && m.tokenOut == token0);
        assertTrue(is01 || is02);

        PoolKey memory k = is01 ? key01 : key02;
        address poolCurrency0 = Currency.unwrap(k.currency0);

        vm.prank(m.trader);
        swap(
            k,
            m.tokenIn == poolCurrency0,
            -int256(m.amountIn),
            _encodeHookData(
                roundId,
                m.matchIdHash,
                m.trader,
                m.counterparty,
                m.tokenIn,
                m.tokenOut,
                m.amountIn,
                m.minAmountOut,
                m.expiry,
                m.proof,
                m.signature
            )
        );
    }

    function _runIappWithIntents(string[] memory intents, string memory roundIdStr) private returns (string memory) {
        string memory projectRoot = vm.projectRoot();
        string memory nowSecondsStr = vm.toString(block.timestamp);
        string memory tmpDir = string.concat(projectRoot, "/.tmp-shadowpool-e2e-", nowSecondsStr, "-", roundIdStr);
        string memory inDir = string.concat(tmpDir, "/iexec_in");
        string memory outDir = string.concat(tmpDir, "/iexec_out");
        vm.createDir(inDir, true);
        vm.createDir(outDir, true);

        for (uint256 i = 0; i < intents.length; i += 1) {
            vm.writeFile(string.concat(inDir, "/intent_", vm.toString(i), ".json"), intents[i]);
        }

        string[] memory cmd = new string[](3);
        cmd[0] = "bash";
        cmd[1] = "-lc";
        cmd[2] = _iappCmd(projectRoot, inDir, outDir, nowSecondsStr, roundIdStr);
        vm.ffi(cmd);

        string memory resultJson = vm.readFile(string.concat(outDir, "/result.json"));
        vm.removeDir(tmpDir, true);
        return resultJson;
    }

    function _countMatches(string memory resultJson, uint256 max) private view returns (uint256 count) {
        for (uint256 i = 0; i < max; i += 1) {
            string memory idxStr = vm.toString(i);
            string memory base = string.concat(".matches[", idxStr, "]");
            try vm.parseJsonBytes32(resultJson, string.concat(base, ".matchIdHash")) returns (bytes32) {
                count += 1;
            } catch {
                break;
            }
        }
    }

    function _signLeaf(bytes32 leaf) private view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(leaf);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEE_PRIVATE_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _intentJson(string memory side, address trader, address baseToken, address quoteToken, uint256 expiry)
        private
        view
        returns (string memory)
    {
        return _intentJsonCustom(side, trader, baseToken, quoteToken, "10", "1", expiry);
    }

    function _intentJsonCustom(
        string memory side,
        address trader,
        address baseToken,
        address quoteToken,
        string memory amountBase,
        string memory limitPrice,
        uint256 expiry
    ) private view returns (string memory) {
        bytes memory p1 = abi.encodePacked(
            "{\"side\":\"", side, "\",\"trader\":\"", vm.toString(trader), "\",\"baseToken\":\""
        );
        bytes memory p2 = abi.encodePacked(
            vm.toString(baseToken),
            "\",\"quoteToken\":\"",
            vm.toString(quoteToken),
            "\",\"amountBase\":\"",
            amountBase,
            "\",\"limitPrice\":\"",
            limitPrice,
            "\",\"expiry\":"
        );
        bytes memory p3 = abi.encodePacked(
            vm.toString(expiry), ",\"tokenPair\":{\"base\":{\"decimals\":18},\"quote\":{\"decimals\":18}}}"
        );
        return string(bytes.concat(bytes.concat(p1, p2), p3));
    }

    function _encodeHookData(
        bytes32 roundId,
        bytes32 matchIdHash,
        address trader,
        address counterparty,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry,
        bytes32[] memory proof,
        bytes memory signature
    ) private pure returns (bytes memory) {
        ShadowPoolHook.HookPayload memory p = ShadowPoolHook.HookPayload({
            roundId: roundId,
            matchIdHash: matchIdHash,
            trader: trader,
            counterparty: counterparty,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            expiry: expiry,
            proof: proof,
            signature: signature
        });
        return abi.encode(p);
    }

    function _iappCmd(
        string memory projectRoot,
        string memory inDir,
        string memory outDir,
        string memory nowSeconds,
        string memory roundIdStr
    ) private pure returns (string memory) {
        bytes memory p1 = abi.encodePacked("cd ", projectRoot, "/../shadowpool-iapp && ");
        bytes memory p2 = abi.encodePacked(
            "TEE_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 ",
            "IEXEC_IN=",
            inDir,
            " IEXEC_OUT=",
            outDir,
            " IEXEC_ARGS='",
            roundIdStr,
            "' NOW_SECONDS="
        );
        bytes memory p3 = abi.encodePacked(nowSeconds, " node src/app.js");
        return string(bytes.concat(bytes.concat(p1, p2), p3));
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
