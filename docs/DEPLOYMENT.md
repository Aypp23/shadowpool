# Deployment Guide (Arbitrum Sepolia)

This guide covers deploying ShadowPool’s on-chain contracts and wiring the frontend + relayer + API server to the same environment.

The most common failure mode is configuration drift (addresses or pool key mismatch). This doc emphasizes verification steps that catch drift early.

## Architecture (What Gets Deployed)

### On-chain (Foundry: `shadowpool-hook/`)

- `IntentRegistry`
  - defines round timing (duration, intake window)
  - stores registered intent commitments per round
- `ShadowPoolRootRegistry`
  - stores Merkle root per round + validity window
  - controls root lifecycle (active/closed)
- `ShadowPoolHook` (Uniswap v4 hook)
  - verifies leaf signatures against the configured signer (`teeSigner`)
  - verifies Merkle proofs against the posted root
  - enforces execution rules at swap time (only valid matches execute)
- Demo helpers (deployment-dependent)
  - test swap router / modify-liquidity router
  - demo tokens (TokenA/TokenB)

### Off-chain (Node + React: `shadow-pool-terminal/`)

- Relayer (`scripts/relayer.mjs`)
  - polls rounds, runs TEE matching (iExec bulk request), posts roots, writes match payload files
- API server (`scripts/server.mjs`)
  - serves `GET /api/rounds/:id/matches` (public) and `GET /api/rounds/:id/matches/private` (trader-only)
- Frontend (Vite + React)
  - protects/grants/submits intents and executes matches through the hook

## Prereqs

- Foundry installed (`forge --version`)
- Node `>= 20`
- An Arbitrum Sepolia RPC URL
- An admin EOA private key (used by the relayer to:
  - post roots
  - sign match leaves when needed
  - pay gas for relayer transactions)

## Environment Configuration (Single Source of Truth)

Single source of truth for deployment + local dev:

- `/Users/aomine/Desktop/iexec2/.env`

The frontend consumes `VITE_*` variables at build time. The relayer and server read from process env (and attempt to load `.env` from common locations).

### Required (Core)

- `ARBITRUM_SEPOLIA_RPC_URL` (or `RPC_URL`)
- `VITE_PUBLIC_RPC_URL` (frontend read-only RPC)
- `PRIVATE_KEY` (relayer/admin key)
- `VITE_ADMIN_ADDRESS` (must correspond to `PRIVATE_KEY`)

### Required (ShadowPool contract addresses)

These must be consistent across frontend + relayer:

- `VITE_SHADOWPOOL_HOOK_ADDRESS`
- `VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS`
- `VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS`

### Required (Routers + tokens)

Used for execution and/or liquidity provisioning scripts:

- `VITE_POOL_SWAP_TEST_ADDRESS`
- `VITE_POOL_MODIFY_LIQUIDITY_ADDRESS`
- `VITE_TOKEN_A_ADDRESS`
- `VITE_TOKEN_B_ADDRESS`

### Pool key configuration (must match how the pool was created)

- `VITE_POOL_FEE`
- `VITE_POOL_TICK_SPACING`
- `VITE_POOL_SQRT_PRICE_X96` (optional; defaults to 1:1 = `2^96`)

### iExec configuration (for matching)

- `VITE_IEXEC_APP_ADDRESS`
- `VITE_IEXEC_WORKERPOOL_ADDRESS` (optional; relayer has a fallback)
- `VITE_IEXEC_WORKERPOOL_MAX_PRICE_NRLC` (optional)

### Relayer timing

- `RELAYER_POLL_INTERVAL_SECONDS` (or `POLL_INTERVAL_SECONDS`)
- `RELAYER_POST_END_MATCHING_SECONDS` (or `POST_END_MATCHING_WINDOW_SECONDS`)
- `VITE_ROOT_VALIDITY_SECONDS`

## Deploy Contracts (Foundry)

Deploy hook + registries + demo routers/tokens:

```bash
cd /Users/aomine/Desktop/iexec2/shadowpool-hook
forge script script/DeployShadowPool.s.sol:DeployShadowPoolScript \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

Addresses are written to:

- `shadowpool-hook/broadcast/DeployShadowPool.s.sol/421614/run-latest.json`

Update your repo root env file:

- `/Users/aomine/Desktop/iexec2/.env`

Then restart services:

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm run dev
```

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm run relayer
```

## Initialize Pool + Add Liquidity (Must Do Before Execution)

Execution depends on Uniswap v4 pool state. Even if matching/root posting is correct, swaps fail when the pool is not initialized or has no liquidity.

Use the Liquidity guide:

- `/Users/aomine/Desktop/iexec2/docs/LIQUIDITY.md`

## Verify Deployment (Must Pass)

### 1) Hook signer correctness (`teeSigner`)

Leaf signatures must match the hook’s configured signer.

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
node scripts/relayer.mjs --check-tee-signer
```

Expected:

- `hook teeSigner` equals `VITE_ADMIN_ADDRESS`

### 2) Pool key consistency (the #1 drift source)

Uniswap v4 pool identity is:

- sorted `currency0 < currency1`
- `fee`
- `tickSpacing`
- `hooks` (hook contract address)

If any differ between initialization, liquidity provisioning, and swaps, you will see confusing errors (wrong pool, “not initialized”, “zero liquidity”, output < minOut).

### 3) Routers share the same PoolManager

If swap router and modify-liquidity router point to different `PoolManager` instances, you can initialize/provision liquidity on one pool and execute swaps on another.

Symptoms:

- “Pool not initialized”
- “zero liquidity”
- swaps interacting with a different pool than the one you initialized/provisioned

### 4) API wiring (production)

The frontend expects a matches API in production. Configure:

- `VITE_MATCHES_API_BASE` to point to your server deployment

Locally, you can serve the production build using:

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm run build
npm run start
```

## Recommended Deployment Order (Avoid Drift)

1. Deploy contracts (Foundry).
2. Initialize pool at 1:1 and add liquidity.
3. Start relayer (matching + root posting).
4. Start API server (if not using local files).
5. Start frontend.
6. Smoke test:
   - submit intents
   - relayer posts root
   - API serves matches
   - execution succeeds

## Redeploying / Resetting (When Price or State Is Corrupted)

Uniswap v4 pools cannot be “re-initialized” to reset price. In demo environments, price can become extreme and make intents impossible to execute.

Use the redeploy helper:

- `/Users/aomine/Desktop/iexec2/shadow-pool-terminal/scripts/redeploy-shadowpool.mjs`

It deploys a fresh environment and updates `/Users/aomine/Desktop/iexec2/.env`.

Example:

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
node scripts/redeploy-shadowpool.mjs --tick-lower=-120 --tick-upper=120
```
