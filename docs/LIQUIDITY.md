# Liquidity Guide (Execution Reliability)

Matching and root posting can be 100% correct while execution still fails. Execution depends on Uniswap v4 pool state.

This doc explains:
- what “pool key” means (the #1 source of errors)
- how to initialize the pool
- how to add liquidity
- when to redeploy

## Pool Key (Critical)

In Uniswap v4, a pool is identified by the tuple:

- `currency0`, `currency1` (sorted: `currency0 < currency1`)
- `fee`
- `tickSpacing`
- `hooks`

If you initialize with one key and swap with another, you are swapping against a different pool and will see:
- `PoolNotInitialized`
- “zero liquidity”
- “price limit exceeded”
- output below `minAmountOut`

## What “Pool Initialized” Means

The pool is “initialized” only if `slot0.sqrtPriceX96 != 0` for that pool key.

Starting price for a 1:1 pool:
- `sqrtPriceX96 = 2^96 = 79228162514264337593543950336`

## What “Liquidity” Means

Liquidity controls depth and price impact:

- If **liquidity is zero**, swaps will fail or output will be ~0.
- If **price moves far away**, strict minOut constraints become impossible (your protected “limit” can’t be satisfied).
- If **liquidity is too concentrated** in a narrow range, small swaps can push the price out of range.

## Add Liquidity (Script)

Use:
- `/Users/aomine/Desktop/iexec2/shadow-pool-terminal/scripts/add-liquidity.mjs`

Example:

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
node scripts/add-liquidity.mjs --tick-lower=-120 --tick-upper=120
```

Requirements:
- `/Users/aomine/Desktop/iexec2/.env` includes `PRIVATE_KEY` and all `VITE_*` addresses
- the deployer has TokenA/TokenB balances
- ticks align to `VITE_POOL_TICK_SPACING`

Recommended strategy:
- For demos: start with a reasonably wide range (aligned to tick spacing).
- If you see extreme price movement, redeploy and add broader liquidity before executing.

## Common Errors and What They Mean

### `PoolNotInitialized`

The pool key used in swap/modifyLiquidity has `slot0.sqrtPriceX96 == 0`.

Causes:
- never initialized
- initialized with a different key
- wrong `PoolManager` (routers not pointing at the same manager)

Fix:
- initialize using the exact same key used later
- ensure routers agree on manager
- ensure currency sorting is consistent

### “Pool has zero liquidity for this pair”

Pool is initialized but total liquidity is zero.

Fix:
- add liquidity for the same pool key

### “Price limit already exceeded”

Typically:
- wrong pool key/router/manager/hook combination, OR
- pool price far from the limits you’re using

Fix:
- verify pool key and addresses
- if price is corrupted, redeploy a fresh pool initialized at 1:1

### “Output below minAmountOut”

The pool could execute, but the expected output is worse than your limit.

Fix:
- add more liquidity around current price
- loosen limit in intent for the demo
- redeploy/reset if the pool price is unrealistic for the scenario

## When to Redeploy

Redeploy when:
- pool price becomes extreme (demo/test environment)
- you cannot satisfy intents’ minOut even with added liquidity
- you want a clean reset to 1:1

In v4, you cannot re-initialize an existing pool. A fresh deployment is the clean reset.

## Reference Scripts (Known-Good)

See:
- `/Users/aomine/Desktop/iexec2/swap.txt`
- `/Users/aomine/Desktop/iexec2/v4-template/script/01_CreatePoolAndAddLiquidity.s.sol`
- `/Users/aomine/Desktop/iexec2/v4-template/script/02_AddLiquidity.s.sol`
- `/Users/aomine/Desktop/iexec2/v4-template/script/03_Swap.s.sol`

