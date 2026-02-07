# Deployment Guide (Arbitrum Sepolia)

This guide covers setting up config, deploying ShadowPool contracts, and wiring the frontend + relayer to the deployed addresses.

The most common failure mode is configuration drift (addresses/pool key mismatch). This doc includes verification steps that catch drift early.

## Components and Responsibilities

### On-chain contracts (Foundry: `shadowpool-hook/`)

- `IntentRegistry`
  - defines round timing (duration, intake window)
  - stores registered intents and round ids

- `ShadowPoolRootRegistry`
  - stores root per round and validity window
  - controls root lifecycle and “closed/active” flags

- `ShadowPoolHook` (Uniswap v4 hook)
  - verifies leaf signatures against the configured signer (`teeSigner`)
  - verifies Merkle proofs against the posted root
  - enforces execution rules at swap time

### Off-chain services (Node: `shadow-pool-terminal/`)

- **Relayer** (`scripts/relayer.mjs`)
  - polls rounds and decides when a round becomes eligible for matching
  - runs iExec bulk request (TEE)
  - posts Merkle root
  - writes match payload files for the API

- **API server** (`scripts/server.mjs`)
  - exposes endpoints like `GET /api/rounds/:id/matches`
  - makes the frontend work in production (not tied to local filesystem behavior)

### Frontend (React: `shadow-pool-terminal/`)

- creates/protects intents
- grants access
- submits on-chain
- fetches matches from API
- executes swaps via hook

## Prereqs

- Foundry installed (`forge --version`)
- Node `>= 20`
- RPC URL set in `/Users/aomine/Desktop/iexec2/.env` as `ARBITRUM_SEPOLIA_RPC_URL`
- Admin EOA private key set in `/Users/aomine/Desktop/iexec2/.env` as `PRIVATE_KEY`
- `VITE_ADMIN_ADDRESS` corresponds to `PRIVATE_KEY`

## Environment Variables (Reference)

Single source of truth:
- `/Users/aomine/Desktop/iexec2/.env`

### Required

- `ARBITRUM_SEPOLIA_RPC_URL`
- `VITE_PUBLIC_RPC_URL`
- `PRIVATE_KEY`
- `VITE_ADMIN_ADDRESS`
- `VITE_IEXEC_APP_ADDRESS`

### Deployed addresses (must be consistent across UI + relayer)

- `VITE_INTENT_REGISTRY_ADDRESS`
- `VITE_ROOT_REGISTRY_ADDRESS`
- `VITE_SHADOWPOOL_HOOK_ADDRESS`
- `VITE_POOL_SWAP_TEST_ADDRESS`
- `VITE_POOL_MODIFY_LIQUIDITY_ADDRESS`
- `VITE_TOKEN_A_ADDRESS`
- `VITE_TOKEN_B_ADDRESS`

### Pool key configuration

- `VITE_POOL_FEE`
- `VITE_POOL_TICK_SPACING`

### Relayer timing

- `POLL_INTERVAL_SECONDS`
- `POST_END_MATCHING_WINDOW_SECONDS`
- `VITE_ROOT_VALIDITY_SECONDS`

## Deploy Contracts (Hook + Registries + Demo Routers/Tokens)

```bash
cd /Users/aomine/Desktop/iexec2/shadowpool-hook
forge script script/DeployShadowPool.s.sol:DeployShadowPoolScript \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

Addresses are written to:
- `shadowpool-hook/broadcast/DeployShadowPool.s.sol/421614/run-latest.json`

Copy the new addresses into:
- `/Users/aomine/Desktop/iexec2/.env`

Then restart:
- `npm run dev` (frontend)
- `npm run relayer` (relayer)

## Verify Deployment (Must Pass)

### 1) Swap router and modify-liquidity router share a manager

If these point to different `PoolManager` instances, you will see:
- “Pool not initialized”
- “zero liquidity”
- swaps interacting with a different pool than the one you initialized/provisioned

### 2) Hook `teeSigner` equals relayer/admin address

Leaf signatures must be produced by the hook’s configured signer.

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
node scripts/relayer.mjs --check-tee-signer
```

Expected:
- `hook teeSigner` equals `VITE_ADMIN_ADDRESS`

### 3) Pool key consistency

The pool is uniquely identified by:
- sorted `currency0 < currency1`
- `fee`
- `tickSpacing`
- `hooks` (hook contract address)

If any differ between initialization, liquidity provisioning, and swaps, you will get confusing errors.

See `/Users/aomine/Desktop/iexec2/docs/LIQUIDITY.md`.

## Recommended Deployment Order

1. Deploy contracts (Foundry).
2. Initialize pool at 1:1 (sqrtPriceX96 = 2^96).
3. Add liquidity (before testing execution).
4. Start relayer.
5. Start frontend / server.
6. Create intents and verify:
   - relayer matches and posts root
   - API serves matches for the round
   - traders can execute without manual admin actions

## Redeploying (When the Price Is Corrupted)

Uniswap v4 pools cannot be “re-initialized” to reset price. If you pushed the price to an extreme and your test intents become impossible to execute, redeploy a fresh pool/hook and add liquidity immediately.

If you have:
- `shadow-pool-terminal/scripts/redeploy-shadowpool.mjs`

Use it to deploy a fresh environment and update `.env`. Then restart services and run new rounds/intents.

