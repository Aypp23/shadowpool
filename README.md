# ShadowPool

**Privacy-Preserving, Intent-Based Dark Pool on Uniswap v4**

ShadowPool is a decentralized trading system that allows traders to submit encrypted "intents" (limit orders) that are matched off-chain within a Trusted Execution Environment (TEE) powered by iExec. Matched orders are then executed on-chain via a Uniswap v4 Hook, ensuring privacy, fairness, and valid execution without revealing order details until the moment of settlement.

## 🏗 Architecture

The system consists of three main components:

1.  **ShadowPool Terminal (`shadow-pool-terminal`)**:
    *   **Frontend**: A React/Vite DApp for traders to manage liquidity, create intents, and execute trades.
    *   **Relayer**: A Node.js service that orchestrates rounds, triggers TEE matching, and posts results on-chain.
    *   **API**: Serves match proofs to the frontend.

2.  **Smart Contracts (`shadowpool-hook`)**:
    *   **`ShadowPoolHook`**: A Uniswap v4 Hook that gates swaps. It verifies that a swap matches a valid, TEE-signed order included in the current round's Merkle root.
    *   **`IntentRegistry`**: Coordinates round schedules and tracks intent submission counts.
    *   **`ShadowPoolRootRegistry`**: Stores the Merkle roots of valid matches posted by the relayer.

3.  **TEE Matcher (`shadowpool-iapp`)**:
    *   An iExec application (Node.js) that runs inside a secure enclave (Scone/Gramine).
    *   Decrypts user intents, performs order matching (sorting by price, matching overlaps), generates a Merkle tree, and signs the results with a TEE-specific key.

---

## 📂 Repository Structure

```
.
├── shadow-pool-terminal/       # Frontend, Relayer, and Scripts
│   ├── src/                    # React frontend code
│   ├── scripts/                # Operational scripts (relayer, deploy, debug)
│   ├── public/                 # Static assets
│   └── vercel.json             # Deployment config
│
├── shadowpool-hook/            # Solidity Contracts (Foundry)
│   ├── src/                    # Contract source code (Hook, Registries)
│   ├── test/                   # Foundry tests
│   └── script/                 # Deployment scripts
│
├── shadowpool-iapp/            # iExec TEE Application
│   ├── src/                    # Matching logic (app.js)
│   └── Dockerfile              # Container definition for TEE
│
└── docs/                       # Detailed documentation
```

---

## 🚀 Getting Started

### Prerequisites

*   **Node.js** (v20+)
*   **Foundry** (for contract work)
*   **Docker** (for building the TEE app)
*   **Arbitrum Sepolia** RPC URL
*   **iExec RLC** (for the relayer to pay for TEE tasks)
*   **ETH** (Arbitrum Sepolia) for gas

### 1. Environment Setup

Create a `.env` file in the root directory (or `shadow-pool-terminal/`) with the following variables. See `env.example` if available.

```bash
# RPC Configuration
ARBITRUM_SEPOLIA_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/..."
VITE_PUBLIC_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/..."

# Relayer / Admin Wallet
PRIVATE_KEY="0x..."               # Must have ETH and RLC
VITE_ADMIN_ADDRESS="0x..."

# iExec Configuration
VITE_IEXEC_APP_ADDRESS="0x..."    # Address of your deployed TEE app
VITE_IEXEC_WORKERPOOL_ADDRESS="0xB967057a21dc6A66A29721d96b8Aa7454B7c383F" # Debug workerpool
VITE_IEXEC_WORKERPOOL_MAX_PRICE_NRLC="100000000" # 0.1 RLC

# ShadowPool Contracts (Populated after deployment)
VITE_INTENT_REGISTRY_ADDRESS="0x..."
VITE_ROOT_REGISTRY_ADDRESS="0x..."
VITE_SHADOWPOOL_HOOK_ADDRESS="0x..."
VITE_TOKEN_A_ADDRESS="0x..."
VITE_TOKEN_B_ADDRESS="0x..."

# Relayer Settings
POLL_INTERVAL_SECONDS="60"
```

### 2. Installation

```bash
cd shadow-pool-terminal
npm install
```

### 3. Running Locally

**Start the Frontend:**
```bash
npm run dev
# Opens at http://localhost:8080
```

**Start the Relayer:**
```bash
npm run relayer
# Polls for rounds and executes TEE tasks
```

---

## 🔄 The Trade Lifecycle

1.  **Submit Intent**:
    *   Trader selects a pair (e.g., TokenA/TokenB) and direction (Buy/Sell).
    *   Frontend encrypts the order data using iExec DataProtector.
    *   Frontend grants access to the **Relayer** (to trigger the task) and the **TEE App** (to decrypt).
    *   Intent hash is registered on-chain in `IntentRegistry`.

2.  **Matching (TEE)**:
    *   Relayer detects a new round window.
    *   Relayer calls the iExec App (`shadowpool-iapp`).
    *   **Inside TEE**:
        *   Intents are decrypted and validated.
        *   Matching engine pairs orders based on price/amount.
        *   Merkle tree is constructed from valid matches.
        *   Match leaves are signed by the TEE private key.
    *   Result (Merkle Root + Match Data) is returned to the Relayer.

3.  **Commitment**:
    *   Relayer posts the **Merkle Root** to the `ShadowPoolRootRegistry` contract.
    *   Relayer saves match data locally (or serves via API).

4.  **Execution**:
    *   Frontend detects the round is "Closed" and a root is posted.
    *   Frontend fetches the **Merkle Proof** and **TEE Signature** for the user's match.
    *   User signs a transaction to `swap()` on Uniswap v4.
    *   **ShadowPoolHook** verifies:
        *   Merkle Proof is valid against the on-chain root.
        *   TEE Signature is valid.
        *   Swap parameters match the committed intent.
    *   Swap executes.

---

## 🛠 Operational Scripts

Located in `shadow-pool-terminal/scripts/`:

*   **`relayer.mjs`**: The main service. Handles the entire off-chain orchestration.
*   **`add-liquidity.mjs`**: Adds liquidity to the Uniswap v4 pool (required for trades to execute).
*   **`check-rlc.mjs`**: Checks the Relayer's RLC balance (Critical for TEE tasks).
*   **`check-workerpool.mjs`**: Checks current market prices for TEE computing power.
*   **`redeploy-shadowpool.mjs`**: Full deployment script for all contracts.

## ⚠️ Troubleshooting

**"Deposit amount exceed wallet balance"**
*   **Cause**: Relayer wallet has insufficient RLC to stake for the TEE task.
*   **Fix**: Fund the relayer wallet with RLC on Arbitrum Sepolia. Use `node scripts/check-rlc.mjs` to verify.

**"No bulk access" / "granted_access_error"**
*   **Cause**: The trader failed to grant DataProtector access to the Relayer or App.
*   **Fix**: Ensure the frontend "Sign & Permit" step completed successfully. Check browser console for signing errors.

**"Pool not initialized" / "Zero Liquidity"**
*   **Cause**: Uniswap v4 pool is empty.
*   **Fix**: Run `node scripts/add-liquidity.mjs` to provision initial liquidity.

---

## 📄 License

MIT
