# ShadowPool: Privacy-Preserving Dark Pool on Uniswap v4 & iExec TEE

**ShadowPool** is a decentralized dark pool built on **Uniswap v4** hooks and **iExec Confidential Computing (TEE)**. It enables traders to submit limit orders without revealing their intentions to the public mempool, preventing MEV (Maximum Extractable Value), front-running, and sandwich attacks.

The system leverages Trusted Execution Environments (TEEs) to match orders off-chain securely and settles matched trades on-chain via a specialized Uniswap v4 Hook that verifies execution proofs.

---

## 🌟 Key Features

*   **Dark Liquidity**: Orders are encrypted client-side and only decrypted inside a secure TEE enclave. No one (not even the Relayer) sees the order details until they are matched.
*   **MEV Protection**: By hiding order details from the mempool, ShadowPool eliminates the surface area for predatory MEV strategies.
*   **Trustless Settlement**: Matched trades are settled on Uniswap v4. The `ShadowPoolHook` contract ensures that only trades authorized by the TEE (proven via cryptographic signatures and Merkle proofs) can execute.
*   **Batched Execution**: Orders are collected in "rounds" and matched in batches, improving efficiency and privacy.
*   **Compliance & Privacy**: Supports optional viewing keys and regulatory hooks without compromising the core privacy guarantees for general trading.

---

## 🏗 System Architecture

The ShadowPool ecosystem consists of three main components working in unison:

1.  **ShadowPool Terminal (Frontend & Relayer)**:
    *   **Frontend**: A Next.js trading interface where users sign "Intents" (orders).
    *   **Relayer**: A Node.js service that aggregates encrypted intents, triggers TEE tasks, and submits settlement transactions to the blockchain.
    
2.  **ShadowPool iApp (TEE Worker)**:
    *   A secure JavaScript application running inside an iExec TEE worker.
    *   It receives encrypted orders, decrypts them, runs the matching engine (COW - Coincidence of Wants), and outputs a signed result containing the matches and a Merkle Root of the state.

3.  **ShadowPool Contracts (On-Chain)**:
    *   **`ShadowPoolHook.sol`**: The Uniswap v4 Hook that acts as the gatekeeper. It verifies that a swap transaction carries a valid proof authorized by the TEE.
    *   **`RootRegistry.sol`**: Stores the Merkle Roots committed by the TEE for each round, acting as the on-chain source of truth.

---

## 📂 Repository Structure

```
├── shadowpool-hook/          # 🧠 Smart Contracts (Foundry)
│   ├── src/
│   │   ├── ShadowPoolHook.sol    # Core verification logic
│   │   └── RootRegistry.sol      # Merkle root storage
│   └── test/                 # Foundry tests
│
├── shadowpool-iapp/          # 🛡️ TEE Application (iExec)
│   ├── src/
│   │   └── app.js            # Matching logic & signing
│   ├── Dockerfile            # TEE container definition
│   └── scone/                # SCONE conf (if applicable)
│
├── shadow-pool-terminal/     # 💻 Frontend & Relayer
│   ├── src/                  # Next.js App
│   └── scripts/              # Backend Scripts
│       ├── relayer.mjs       # Main orchestration script
│       ├── server.mjs        # API for serving proofs
│       └── utils/            # Cryptographic helpers
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
# Install root dependencies (if any)
npm install

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
2.  **Task Trigger**: The Relayer triggers an iExec task, passing the encrypted intents as input files.
3.  **Secure Matching**:
    *   The TEE worker starts, retrieves the decryption key securely.
    *   `app.js` decrypts orders and runs the matching algorithm.
    *   It generates a **Batch Match** (pairs of buys/sells).
4.  **Commitment**: The TEE generates a **Merkle Tree** of the executions. It signs the Root and the specific matches using its enclave key.
5.  **Output**: The result (encrypted or public, depending on config) is returned to the Relayer.

### Phase 3: Settlement (On-Chain)
1.  **Root Registration**: The Relayer submits the new Merkle Root to `RootRegistry.sol`.
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
| **Contracts** | `forge script script/Deploy.s.sol --broadcast` | Deploy contracts to network |
| **Relayer** | `node scripts/relayer.mjs` | Start the Relayer service (Polling & Execution) |
| **Server** | `node scripts/server.mjs` | Start the Proof Server (API for frontend) |
| **Frontend** | `npm run dev` | Start the Next.js frontend (localhost:3000) |
| **iApp** | `docker build -t image_name .` | Build the TEE application image |

---

## ⚠️ Troubleshooting

**Relayer: "Task Failed"**
*   Check if your iExec wallet has enough RLC and ETH (for gas).
*   Ensure the `IEXEC_APP_ADDRESS` is correct and whitelisted for your workerpool.

**Contracts: "InvalidProof"**
*   Ensure the Merkle Root was successfully registered in `RootRegistry` before the swap transaction was attempted.
*   Check that the `roundId` in the proof matches the currently active round.

**Frontend: "Signature Denied"**
*   The wallet must be on the correct network (Arbitrum Sepolia / Base Sepolia).
*   Ensure you are signing the correct EIP-712 Typed Data structure.

---

## 📄 License

This project is licensed under the MIT License.
