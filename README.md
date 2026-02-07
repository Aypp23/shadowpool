# ShadowPool

ShadowPool is a privacy-preserving, intent-based trading system.

Traders submit encrypted intents (side/size/limit/strategy parameters) using iExec DataProtector. A relayer triggers TEE matching (iExec) after an intake window, posts a Merkle root on-chain, and publishes per-round match payloads via an API. Traders then execute matched swaps through a Uniswap v4 hook by presenting a proof against the posted root.

This repo is a monorepo for the full stack: contracts/hook, frontend, backend/API, relayer automation, and scripts for deployment, debugging, and liquidity provisioning.

## What’s In This Repo

- `shadow-pool-terminal/`
  - Vite React dApp (Trader UX)
  - Node server (serves app + exposes API endpoints used by the frontend)
  - Relayer (round polling, TEE matching, root posting)
  - Operational scripts (debug, add liquidity, redeploy, E2E helpers)
- `shadowpool-hook/`
  - Foundry workspace for on-chain contracts:
    - ShadowPool hook (Uniswap v4 hook)
    - Intent registry (rounds + intent registration)
    - Root registry (Merkle root lifecycle)
    - Demo Uniswap v4 routers/tokens used by the project scripts
- `shadowpool-iapp/`
  - iExec app workspace (TEE matcher) and related artifacts/config
- `v4-template/`
  - reference Uniswap v4 scripts (pool init/liquidity/swap) used as a baseline

## Concepts (Mental Model)

### Public vs Private

- Public (on-chain):
  - round id / schedule
  - intent registration metadata (not the encrypted payload)
  - posted Merkle root + validity window
  - swap execution txs

- Private (off-chain / in TEE):
  - encrypted intent parameters
  - matching logic and intermediate computations
  - per-intent “revealed” details only as required for execution

### Why Merkle Roots

The relayer posts a Merkle root committing to a set of matched fills. Traders later prove their fill is included, without the protocol needing to reveal the entire match set publicly.

## Prereqs

- Node.js `>= 20`
- npm `>= 9`
- Foundry (`forge`) for deploying `shadowpool-hook/` or running reference scripts in `v4-template/`
- An Arbitrum Sepolia RPC endpoint (Alchemy/Infura/etc.)
- At least:
  - 1 funded EOA for the relayer/admin (posts roots, signs match leaves, handles liquidity provisioning in scripts)
  - 2 funded EOAs for traders (E2E testing)

Recommended:
- Enable only one injected EVM wallet extension while developing (multiple providers can cause flaky `window.ethereum` behavior).

## Environment Setup (Single Source of Truth)

All scripts and the frontend read from the repo root env file:

- `/Users/aomine/Desktop/iexec2/.env`

Minimum required keys:

```bash
# RPC
ARBITRUM_SEPOLIA_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/<key>"
VITE_PUBLIC_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/<key>"

# Relayer/admin EOA
PRIVATE_KEY="0x..."
VITE_ADMIN_ADDRESS="0x..."

# iExec
VITE_IEXEC_APP_ADDRESS="0x..."

# ShadowPool contracts + demo routers/tokens (set by deploy scripts)
VITE_INTENT_REGISTRY_ADDRESS="0x..."
VITE_ROOT_REGISTRY_ADDRESS="0x..."
VITE_SHADOWPOOL_HOOK_ADDRESS="0x..."
VITE_POOL_SWAP_TEST_ADDRESS="0x..."
VITE_POOL_MODIFY_LIQUIDITY_ADDRESS="0x..."
VITE_TOKEN_A_ADDRESS="0x..."
VITE_TOKEN_B_ADDRESS="0x..."

# Pool key params (must match deployment)
VITE_POOL_FEE="0"
VITE_POOL_TICK_SPACING="60"

# Relayer timing
POLL_INTERVAL_SECONDS="60"
POST_END_MATCHING_WINDOW_SECONDS="3600"

# Root validity / execution window (seconds)
VITE_ROOT_VALIDITY_SECONDS="21600"
```

If you redeploy, restart both the dev server and relayer so they pick up the new addresses.

## Install

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm i
```

## Run (Development)

### dApp (Vite)

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm run dev
```

Open the printed URL (commonly `http://localhost:8080` or `http://localhost:8081`).

### Relayer

In a second terminal:

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm run relayer
```

Relayer writes:
- `shadow-pool-terminal/data/relayer/<roundId>.json`

### Local Production-Like Server (Recommended)

This serves the built frontend and exposes match endpoints. This is the mode you want to validate “production behavior”.

```bash
cd /Users/aomine/Desktop/iexec2/shadow-pool-terminal
npm run build
PORT=8080 npm start
```

If the port is in use:

```bash
PORT=8082 npm start
```

API example:
- `GET /api/rounds/:roundId/matches`

## Deployment

Start here:
- `/Users/aomine/Desktop/iexec2/docs/DEPLOYMENT.md`

Liquidity matters for execution reliability:
- `/Users/aomine/Desktop/iexec2/docs/LIQUIDITY.md`

Full E2E usage + troubleshooting:
- `/Users/aomine/Desktop/iexec2/docs/USAGE.md`

## Fast Troubleshooting Checklist

- `no_bulk_access` (relayer debug):
  - trader didn’t grant bulk access to the correct requester address (usually `VITE_ADMIN_ADDRESS`)
  - OR trader granted for the wrong iExec app address

- swap fails with “Pool not initialized / zero liquidity / price limit exceeded”:
  - pool key mismatch (token ordering/fee/tickSpacing/hook)
  - OR pool not initialized
  - OR pool has no liquidity
  - OR price moved to an extreme (minOut impossible)

See `/Users/aomine/Desktop/iexec2/docs/LIQUIDITY.md`.

