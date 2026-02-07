// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import "forge-std/console2.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IntentRegistry} from "../src/IntentRegistry.sol";
import {ShadowPoolRootRegistry} from "../src/ShadowPoolRootRegistry.sol";
import {ShadowPoolHook} from "../src/ShadowPoolHook.sol";

contract DeployShadowPool is Script {
    function setUp() public {}

    function run() public {
        address create2Deployer = address(0x4e59b44847b379578588920cA78FbF26c0B4956C);
        bytes32 namespace = vm.envOr("ROUND_NAMESPACE_BYTES32", keccak256(bytes("shadowpool")));
        uint256 durationSeconds = vm.envOr("ROUND_DURATION_SECONDS", uint256(3600));
        uint256 intakeWindowSeconds = vm.envOr("ROUND_INTAKE_WINDOW_SECONDS", durationSeconds);

        uint24 fee = uint24(vm.envOr("POOL_FEE", uint256(0)));
        int24 tickSpacing = int24(int256(vm.envOr("POOL_TICK_SPACING", uint256(60))));
        uint160 sqrtPriceX96 =
            uint160(vm.envOr("POOL_SQRT_PRICE_X96", uint256(79228162514264337593543950336)));

        vm.startBroadcast();
        address deployer = msg.sender;
        address teeSigner = vm.envOr("TEE_SIGNER_ADDRESS", deployer);

        PoolManager manager = new PoolManager(deployer);
        PoolSwapTest swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        PoolModifyLiquidityTest modifyLiquidityRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        ShadowPoolRootRegistry rootRegistry = new ShadowPoolRootRegistry(deployer);
        IntentRegistry intentRegistry = new IntentRegistry(deployer, namespace, durationSeconds, intakeWindowSeconds);

        (address hookAddress, bytes32 salt) = HookMiner.find(
            create2Deployer,
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(ShadowPoolHook).creationCode,
            abi.encode(IPoolManager(address(manager)), rootRegistry, deployer, teeSigner)
        );
        ShadowPoolHook hook = new ShadowPoolHook{salt: salt}(IPoolManager(address(manager)), rootRegistry, deployer, teeSigner);
        require(address(hook) == hookAddress, "Hook address mismatch");

        hook.setAllowedCaller(address(swapRouter), true);

        MockERC20 tokenA = new MockERC20("TokenA", "TKA", 18);
        MockERC20 tokenB = new MockERC20("TokenB", "TKB", 18);
        tokenA.mint(deployer, 10_000_000e18);
        tokenB.mint(deployer, 10_000_000e18);
        tokenA.approve(address(modifyLiquidityRouter), type(uint256).max);
        tokenB.approve(address(modifyLiquidityRouter), type(uint256).max);

        address addrA = address(tokenA);
        address addrB = address(tokenB);
        Currency currency0 = Currency.wrap(addrA < addrB ? addrA : addrB);
        Currency currency1 = Currency.wrap(addrA < addrB ? addrB : addrA);

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(hook))
        });

        manager.initialize(key, sqrtPriceX96);

        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: -120,
            tickUpper: 120,
            liquidityDelta: 1e18,
            salt: 0
        });
        modifyLiquidityRouter.modifyLiquidity(key, params, "");

        vm.stopBroadcast();

        console2.log("Deployed ShadowPool on Arbitrum Sepolia:");
        console2.log("VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS", address(intentRegistry));
        console2.log("VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS", address(rootRegistry));
        console2.log("VITE_SHADOWPOOL_HOOK_ADDRESS", address(hook));
        console2.log("VITE_POOL_SWAP_TEST_ADDRESS", address(swapRouter));
        console2.log("VITE_POOL_FEE", fee);
        console2.log("VITE_POOL_TICK_SPACING", tickSpacing);
        console2.log("VITE_TOKEN_A_ADDRESS", address(tokenA));
        console2.log("VITE_TOKEN_B_ADDRESS", address(tokenB));
        console2.log("TEE_SIGNER_ADDRESS", teeSigner);
    }
}
