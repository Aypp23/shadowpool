# ShadowPool: Privacy-Preserving Dark Pool on Uniswap v4 & iExec TEE

**ShadowPool** is a decentralized dark pool built on **Uniswap v4** hooks and **iExec Confidential Computing (TEE)**. It enables traders to submit limit orders without revealing their intentions to the public mempool, preventing MEV (Maximum Extractable Value), front-running, and sandwich attacks.

The system leverages Trusted Execution Environments (TEEs) to match orders off-chain securely and settles matched trades on-chain via a specialized Uniswap v4 Hook that verifies execution proofs.

---

## 🌟 Key Features

*   **Dark Liquidity**: Orders are encrypted client-side and only decrypted inside a secure TEE enclave. No one (not even the Relayer) sees the order details until they are matched.
*   **MEV Protection**: By hiding order details from the mempool, ShadowPool eliminates the surface area for predatory MEV strategies.
*   **Trustless Settlement**: Matched trades are settled on Uniswap v4. The `ShadowPoolHook` contract ensures that only trades authorized by the TEE (proven via cryptographic signatures and Merkle proofs) can execute.
*   **Batched Execution**: Orders are collected in "rounds" and matched in batches using **iExec Bulk Processing**. This allows up to 100 encrypted orders to be processed in a single TEE task, significantly reducing gas costs and computation overhead per trade.
*   **Compliance & Privacy**: Supports optional viewing keys and regulatory hooks without compromising the core privacy guarantees for general trading.

---

## 🏗 System Architecture

The ShadowPool ecosystem consists of three main components working in unison:

1.  **ShadowPool Terminal (Frontend & Relayer)**:
    *   **Frontend**: A Vite + React trading interface where users create and manage "Intents" (orders).
    *   **Relayer**: A Node.js service that aggregates encrypted intents into **Bulk Requests**, triggers TEE tasks via iExec, and commits settlement authorization to the blockchain.
    
2.  **ShadowPool iApp (TEE Worker)**:
    *   A secure JavaScript application running inside an iExec TEE worker.
    *   It receives encrypted orders, decrypts them, runs the matching engine (COW - Coincidence of Wants), and outputs a signed result containing the matches and a Merkle Root of the state.

3.  **ShadowPool Contracts (On-Chain)**:
    *   **`ShadowPoolHook.sol`**: The Uniswap v4 Hook that acts as the gatekeeper. It verifies that a swap transaction carries a valid proof authorized by the TEE.
    *   **`ShadowPoolRootRegistry.sol`**: Stores the Merkle Roots committed by the TEE for each round, acting as the on-chain source of truth.

---

## 📂 Repository Structure

```
├── shadowpool-hook/          # 🧠 Smart Contracts (Foundry)
│   ├── src/
│   │   ├── ShadowPoolHook.sol    # Core verification logic
│   │   └── ShadowPoolRootRegistry.sol # Merkle root storage
│   └── test/                 # Foundry tests
│
├── shadowpool-iapp/          # 🛡️ TEE Application (iExec)
│   ├── src/
│   │   └── app.js            # Matching logic & signing
│   ├── Dockerfile            # TEE container definition
│
├── shadow-pool-terminal/     # 💻 Frontend & Relayer
│   ├── src/                  # Vite + React app
│   └── scripts/              # Backend scripts (relayer + matches server + utilities)
│       ├── relayer.mjs       # Main orchestration script
│       ├── server.mjs        # API for serving proofs
│       └── ...               # Token deployment, liquidity helpers, debug utilities, etc.
```

---

## 🚀 Getting Started

### Prerequisites

*   **Node.js** (v18+) & **npm/yarn**
*   **Foundry** (Forge/Cast) for smart contract development
*   **Docker** (for building the TEE image)
*   **iExec SDK** (installed globally or via project deps)

### 1. Installation

Clone the repository and install dependencies for all workspaces:

```bash
# Install Contract dependencies
cd shadowpool-hook
forge install

# Install Frontend/Relayer dependencies
cd ../shadow-pool-terminal
npm install

# Install iApp dependencies
cd ../shadowpool-iapp
npm install
```

### 2. Environment Configuration

Create a `.env` file in `shadow-pool-terminal` (see `.env.example`):

```env
# Blockchain Config
RPC_URL=https://sepolia.arbitrum.io/rpc
PRIVATE_KEY=0x...               # Relayer Wallet
CHAIN_ID=421614

# iExec Config
IEXEC_APP_ADDRESS=0x...         # Deployed iApp address
IEXEC_WORKERPOOL_ADDRESS=debug-workerpool-0

# Contract Config
HOOK_ADDRESS=0x...              # Deployed ShadowPoolHook
ROOT_REGISTRY_ADDRESS=0x...     # Deployed RootRegistry
POOL_KEY=...                    # Uniswap Pool Key
```

---

## 🔄 Deep Dive: The Trade Lifecycle

### Phase 1: Intent Creation (Client)
1.  **User signs an intent**: The trader defines parameters (Asset, Amount, Limit Price) on the frontend.
2.  **Encryption**: The intent is encrypted using the iExec dataset encryption key (protecting it from the Relayer).
3.  **Submission**: The encrypted intent is sent to the Relayer via API.

### Phase 2: Execution (TEE)
1.  **Aggregation**: The Relayer collects intents for the current `roundId`.
2.  **Task Trigger (Bulk)**: The Relayer triggers an iExec task using **`processBulkRequest`**. This aggregates multiple encrypted intents (datasets) into a single computational unit, maximizing throughput.
3.  **Secure Matching**:
    *   The TEE worker starts, retrieves the decryption key securely.
    *   `app.js` decrypts orders and runs the matching algorithm.
    *   It generates a **Batch Match** (pairs of buys/sells).
4.  **Commitment**: The TEE generates a **Merkle Tree** of the executions. It signs the Root and the specific matches using its enclave key.
5.  **Output**: The result (encrypted or public, depending on config) is returned to the Relayer.

### Phase 3: Settlement (On-Chain)
1.  **Root Registration**: The Relayer submits the new Merkle Root to `ShadowPoolRootRegistry.sol`.
2.  **Execution**: The Relayer (or Solvers) submits `swap` transactions to the Uniswap v4 Pool.
3.  **Verification (The Hook)**:
    *   `ShadowPoolHook` intercepts the swap.
    *   It checks `beforeSwap`:
        *   Is the caller authorized?
        *   Does the `hookData` contain a valid **Merkle Proof** linking this trade to the committed Root?
        *   Is the proof signed by the verified TEE signer?
    *   If valid, the swap proceeds. If not, it reverts.

---

## 🛠️ Scripts & Commands

| Component | Command | Description |
| :--- | :--- | :--- |
| **Contracts** | `forge test` | Run smart contract tests in `shadowpool-hook` |
| **Contracts** | `forge script script/DeployShadowPool.s.sol:DeployShadowPool --broadcast` | Deploy contracts to network |
| **Relayer** | `node scripts/relayer.mjs` | Start the Relayer service (Polling & Execution) |
| **Server** | `node scripts/server.mjs` | Start the Proof Server (API for frontend) |
| **Frontend** | `npm run dev` | Start the Vite frontend (prints local URL, typically localhost:8080) |
| **iApp** | `docker build -t image_name .` | Build the TEE application image |

---

## ⚠️ Troubleshooting

**Relayer: "Task Failed"**
*   Check if your iExec wallet has enough RLC and ETH (for gas).
*   Ensure the `IEXEC_APP_ADDRESS` is correct and whitelisted for your workerpool.

**Contracts: "InvalidProof"**
*   Ensure the Merkle Root was successfully registered in `ShadowPoolRootRegistry` before the swap transaction was attempted.
*   Check that the `roundId` in the proof matches the currently active round.

**Frontend: "Signature Denied"**
*   The wallet must be on the correct network (Arbitrum Sepolia).
*   Ensure you are signing the correct EIP-712 Typed Data structure.

---

## 📄 License

This project is licensed under the MIT License.

---

## Developer Reference

This section is intentionally detailed and is meant to be the “single source of truth” for developers onboarding to the codebase.

### What runs where

| Component | Where it runs | What it does |
| --- | --- | --- |
| **Contracts** | Arbitrum Sepolia / any EVM chain supporting Uniswap v4 | Stores intent refs, root commits, and verifies swaps |
| **TEE iApp** | iExec TEE workers | Decrypts intent datasets, matches orders, builds Merkle root/proofs, signs leaves |
| **Relayer** | Render / local Node | Polls rounds, triggers iExec bulk processing, posts roots, writes match files |
| **Matches API** | Render / local Node | Serves per-round match metadata and privately filtered matches |
| **Frontend** | Vercel / local Vite dev | UI for creating intents, viewing rounds/matches, executing swaps |

---

## Documentation Map (Where to look in code)

### Contracts

- [IntentRegistry.sol](shadowpool-hook/src/IntentRegistry.sol)
  - `computeRoundId()`, intake window enforcement
  - `registerIntent()`, `registerIntents()`
  - commitment definition `computeCommitment()`
- [ShadowPoolRootRegistry.sol](shadowpool-hook/src/ShadowPoolRootRegistry.sol)
  - `postRoot()`, root validity, matcher role
  - `lockRoot()` for finalization
  - `getRoundInfo()` for UI/relayer reads
- [ShadowPoolHook.sol](shadowpool-hook/src/ShadowPoolHook.sol)
  - hook permissions and `beforeSwap`/`afterSwap` enforcement
  - leaf format, signature verification, replay protection

### iApp

- [app.js](shadowpool-iapp/src/app.js)
  - input parsing: `IEXEC_ARGS`, `IEXEC_IN`
  - intent eligibility (optional commitment validation)
  - matching algorithm and fill construction
  - Merkle tree building and per-leaf signature

### Relayer + Server

- [relayer.mjs](shadow-pool-terminal/scripts/relayer.mjs)
  - `tick()` loop, round phase logic
  - iExec bulk processing: `prepareBulkRequest` → `processBulkRequest`
  - root posting and match file writing
  - HTTP endpoints (express) for matches
- [server.mjs](shadow-pool-terminal/scripts/server.mjs)
  - static `dist/` serving + SPA fallback
  - `GET /api/rounds/:roundId/matches` (public)
  - `GET /api/rounds/:roundId/matches/private` (authenticated)

### Frontend

- [shadowPool.ts](shadow-pool-terminal/src/services/shadowPool.ts)
  - iExec DataProtector usage (`protectData`, `grantAccess`)
  - on-chain reads (round roots, intent registry, matchUsed)
  - hookData encoding and swap execution (`generateHookData`, `executeTradeWithProof`)
- Pages
  - [CreateIntent.tsx](shadow-pool-terminal/src/pages/CreateIntent.tsx)
  - [ExecuteTrade.tsx](shadow-pool-terminal/src/pages/ExecuteTrade.tsx)
  - [RoundDetail.tsx](shadow-pool-terminal/src/pages/RoundDetail.tsx)

---

## Build & Run Guide (Local)

### A) Contracts

```bash
cd shadowpool-hook
forge install
forge test
```

Deploy on a testnet:

```bash
cd shadowpool-hook
forge script script/DeployShadowPool.s.sol:DeployShadowPool --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

The script prints env keys you can paste into `shadow-pool-terminal/.env`:

- `VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS`
- `VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS`
- `VITE_SHADOWPOOL_HOOK_ADDRESS`
- `VITE_POOL_SWAP_TEST_ADDRESS`
- `VITE_POOL_FEE`
- `VITE_POOL_TICK_SPACING`
- `VITE_TOKEN_A_ADDRESS`
- `VITE_TOKEN_B_ADDRESS`
- `TEE_SIGNER_ADDRESS`

See [DeployShadowPool.s.sol](shadowpool-hook/script/DeployShadowPool.s.sol).

### B) Relayer (local)

The relayer expects:

- an RPC URL
- `PRIVATE_KEY` to send transactions
- iExec configuration for the app/workerpool
- deployed contracts addresses

Run:

```bash
cd shadow-pool-terminal
npm install
npm run relayer
```

### C) Matches server (local)

If you want a local API serving match files:

```bash
cd shadow-pool-terminal
npm run build
npm run start
```

This serves:

- static UI from `dist/`
- match endpoints from `data/relayer/` (or `$RELAYER_MATCHES_DIR`)

### D) Frontend (local)

```bash
cd shadow-pool-terminal
npm run dev
```

The UI reads:

- chain + contract config from `VITE_*` env vars
- matches API base from `VITE_MATCHES_API_BASE`

---

## Environment Variables (Complete Reference)

This section aggregates environment variables referenced in code. Use it as a checklist when configuring a new environment.

### Frontend + shared (`shadow-pool-terminal/.env`)

#### RPC / chain selection

- `VITE_PUBLIC_RPC_URL`
- `VITE_RPC_URL`
- `VITE_ARBITRUM_SEPOLIA_RPC_URL`
- `VITE_ALCHEMY_ARBITRUM_SEPOLIA_RPC_URL`
- `VITE_ALCHEMY_RPC_URL`

Used by [shadowPool.ts](shadow-pool-terminal/src/services/shadowPool.ts) read-client selection.

#### Matches API

- `VITE_MATCHES_API_BASE` (base URL for match endpoints)
- `VITE_PRIVATE_MATCHES_TTL_SECONDS` (used for timestamp TTL validation on server-side; also respected by UI fetch auth)

#### Contracts

- `VITE_SHADOWPOOL_HOOK_ADDRESS`
- `VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS`
- `VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS`

Optional log indexing controls:

- `VITE_SHADOWPOOL_FROM_BLOCK`
- `VITE_SHADOWPOOL_INTENT_REGISTRY_FROM_BLOCK`
- `VITE_SHADOWPOOL_ROOT_REGISTRY_FROM_BLOCK`
- `VITE_SHADOWPOOL_LOG_CHUNK_SIZE`

#### Uniswap v4 swap configuration

- `VITE_POOL_SWAP_TEST_ADDRESS`
- `VITE_POOL_FEE`
- `VITE_POOL_TICK_SPACING`
- optional: `VITE_POOL_SQRT_PRICE_X96` (primarily used by scripts)

#### iExec (client-side / UI)

- `VITE_IEXEC_APP_ADDRESS`
- `VITE_IEXEC_WORKERPOOL_ADDRESS`
- `VITE_IEXEC_WORKERPOOL_MAX_PRICE_NRLC`

The UI has additional fallbacks:

- `VITE_IEXEC_APP`
- `VITE_IEXEC_APP_WHITELIST`

#### Tokens

- `VITE_TOKEN_A_ADDRESS`
- `VITE_TOKEN_B_ADDRESS`
- optional: `VITE_TOKEN_C_ADDRESS`
- optional: `VITE_TOKEN_D_ADDRESS`

### Relayer runtime (`shadow-pool-terminal/scripts`)

- `PRIVATE_KEY` (required; never commit)
- `PORT` (used by `relayer.mjs` express server and `server.mjs`)
- `RELAYER_MATCHES_DIR` (override matches dir)
- `RELAYER_POLL_INTERVAL_SECONDS` (polling interval)

### Top-level `.env` (consumed by scripts)

Some scripts read `../.env` from inside `shadow-pool-terminal/scripts/`:

- [redeploy-shadowpool.mjs](shadow-pool-terminal/scripts/redeploy-shadowpool.mjs)

That script expects:

- `RPC_URL` (or `VITE_RPC_URL`, or `ARBITRUM_SEPOLIA_RPC_URL`)
- `PRIVATE_KEY`
- optionally:
  - `POOL_FEE`, `POOL_TICK_SPACING`, `POOL_SQRT_PRICE_X96`
  - `ROUND_NAMESPACE_BYTES32`, `ROUND_DURATION_SECONDS`, `ROUND_INTAKE_WINDOW_SECONDS`
  - `TEE_SIGNER_ADDRESS`

---

## Protocol Details

### Round schedule

Rounds are a shared concept across:

- IntentRegistry (enforces intake window)
- Relayer (computes candidate rounds and determines phase)
- RootRegistry (stores per-round roots and validity)

Round definition in [IntentRegistry.sol](shadowpool-hook/src/IntentRegistry.sol):

- `roundStart = floor(timestamp / durationSeconds) * durationSeconds`
- `roundId = keccak256(abi.encodePacked(namespace, roundStart))`

Intake window:

- `timestamp - roundStart < intakeWindowSeconds`

The relayer mirrors this schedule to decide when to match and when to skip.
See phase logic in [relayer.mjs](shadow-pool-terminal/scripts/relayer.mjs) (`tick()` computes `inIntake`, `inMatchingWindow`, and `phase`).

### Intent commitment

On-chain commitment function:

`IntentRegistry.computeCommitment(side, trader, baseToken, quoteToken, amountBaseWei, limitPriceWad, expirySeconds, saltBytes32)`

Why it matters:

- the relayer can pass `commitmentsByProtectedData` to the iApp
- the iApp recomputes the commitment from decrypted payload
- the iApp can reject malformed or mismatched datasets

### Matching & fills (buys and sells don’t need to be exact)

ShadowPool’s matcher does not require a “perfectly symmetric” buy and sell to produce a match.
Two intents can match as long as they are compatible on **pair** and **price**, and then the fill size can be **partial**.

At a high level (current iApp behavior):

- Intents are grouped by `(baseToken, quoteToken, baseDecimals, quoteDecimals)`.
- Buys are sorted by highest limit price first; sells are sorted by lowest limit price first.
- A match occurs when **prices cross**:
  - `buy.limitPriceWad >= sell.limitPriceWad`
- The fill amount is the minimum of what each side has remaining:
  - `fillBaseWei = min(buy.amountBaseWeiRemaining, sell.amountBaseWeiRemaining)`
- A single fill produces **two executable match entries** (one per trader perspective):
  - buyer entry: `tokenIn = quote`, `tokenOut = base`
  - seller entry: `tokenIn = base`, `tokenOut = quote`

Implications:

- A large order can be filled by multiple smaller orders across the round.
- A small order can be fully filled against a larger order (with the larger order continuing to match further).
- “No match” typically means prices didn’t cross (or the round/pair grouping didn’t align), not that the sizes weren’t identical.

Source of truth for the matching logic is the iApp:

- [app.js](file:///Users/aomine/Desktop/iexec2/shadowpool-iapp/src/app.js)

### Root validity & matcher role

The root registry enforces:

- rounds must be closed before posting root
- only one matcher address can post for a round (first poster becomes matcher)
- root has an expiry (`validUntil`) and can be extended by reposting if unlocked

See [ShadowPoolRootRegistry.sol](shadowpool-hook/src/ShadowPoolRootRegistry.sol).

---

## Hook Verification Contract (Deep Dive)

This section documents the swap-time invariants enforced by the hook and how the UI must match them.

### Hook permissions

`ShadowPoolHook` declares:

- `beforeSwap: true`
- `afterSwap: true`
- all other hooks disabled

This means:

- swaps must carry valid `hookData` (or they revert)
- add/remove liquidity is unaffected by this hook (except via pool initialization configuration)

### Authorization: who may call swap

The hook checks:

- `sender == p.trader` OR `allowedCaller[sender] == true`

Deploy script sets `allowedCaller` for the `PoolSwapTest` router:

- [DeployShadowPool.s.sol](shadowpool-hook/script/DeployShadowPool.s.sol)

This supports two execution styles:

- direct execution by the trader EOA (sender == trader)
- execution via an approved router/relayer contract (allowedCaller == true)

### Swap param validation

The hook requires exact-input semantics:

- `params.amountSpecified < 0`
- `uint256(-params.amountSpecified) == p.amountIn`

Token direction validation:

- derive expected tokenIn/tokenOut from `params.zeroForOne` and pool key currencies
- enforce `p.tokenIn == expectedTokenIn && p.tokenOut == expectedTokenOut`

If the UI chooses wrong `currency0/currency1` ordering, the hook will revert with `InvalidSwapParams`.

### Proof and signature validation

The hook defines a leaf:

`leaf = keccak256(abi.encode(roundId, matchIdHash, trader, counterparty, tokenIn, tokenOut, amountIn, minAmountOut, expiry))`

And validates:

- `MerkleProof.verify(p.proof, root, leaf)`
- `ECDSA.recover(ethSignedMessageHash(leaf), p.signature) == teeSigner`

The iApp must use the same leaf format and signature scheme.

### Replay protection

The hook prevents double-execution by tracking:

- used match IDs (`matchUsed[roundId][matchIdHash]`)
- used leaves (`leafUsed[roundId][leaf]`)

This is why executed matches become non-clickable in the UI.

---

## iExec Bulk Processing (Deep Dive)

The relayer uses iExec’s bulk APIs to reduce overhead:

- It queries granted access for each protected dataset with `{ bulkOnly: true }`.
- It creates a bulk request with:
  - `maxProtectedDataPerTask: 100`
- It executes `processBulkRequest(...)` and waits for results.

Practical impact:

- up to ~100 encrypted intents can be processed within one TEE task
- fewer tasks means fewer orders/calls and better throughput

See `runMatching()` in [relayer.mjs](shadow-pool-terminal/scripts/relayer.mjs).

---

## Relayer API Contract

There are two ways matches are served in this repository:

1) The relayer process itself (Express inside `relayer.mjs`)
2) The static server (`server.mjs`) that can serve built frontend and matches

Both expose a similar path shape:

- `/api/rounds/:roundId/matches`
- `/api/rounds/:roundId/matches/private`

### Private endpoint authentication

Clients authenticate by signing a human-readable message:

```
shadowpool:matches:<address>:<timestamp>
```

Then sending:

- address + signature + timestamp headers

Server verifies the signer address using `recoverMessageAddress` from `viem`.

See [server.mjs](shadow-pool-terminal/scripts/server.mjs).

---

## Frontend Execution Details

This section focuses on the “Execute via Uniswap v4 Hook” flow and how it interacts with the contracts.

### Match selection and execution

The UI execution flow is implemented by:

- [ExecuteTrade.tsx](shadow-pool-terminal/src/pages/ExecuteTrade.tsx) for UI state
- [shadowPool.ts](shadow-pool-terminal/src/services/shadowPool.ts) for chain calls

At a high level:

1) Fetch private matches for the connected address
2) Choose a match
3) Generate hook data from match fields (roundId, matchIdHash, proof, signature, etc.)
4) Perform `swap` via the configured router address

### Token approvals and balances

Swaps require:

- sufficient `tokenIn` balance
- sufficient allowance for the swap router

`executeTradeWithProof()` includes explicit pre-checks and clear error mapping to avoid “unknown swap error”.

See [shadowPool.ts](shadow-pool-terminal/src/services/shadowPool.ts).

---

## Deployment Files

### Render (relayer)

Render configuration:

- [render.yaml](render.yaml)

Notes:

- persistent disk is required to keep match files across deploys
- update `VITE_MATCHES_API_BASE` in the frontend to point at your Render URL

### Vercel (frontend)

SPA rewrite:

- [vercel.json](shadow-pool-terminal/vercel.json)

---

## Existing Repo Docs

Additional docs used by the project:

- [docs/USAGE.md](docs/USAGE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/LIQUIDITY.md](docs/LIQUIDITY.md)
