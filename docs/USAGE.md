# Usage Guide (dApp + Relayer)

This guide describes:
- the trader flow (protect → grant → submit → execute)
- the relayer flow (match → post root → publish match payloads)
- what a trader signs (and what they should not need to sign)
- the practical checks that keep the system working

## Roles

### Trader

- creates intent parameters
- encrypts intent using iExec DataProtector
- grants bulk access to the authorized requester
- submits intent to the active round
- executes matched swaps (pays gas for approvals + swap tx)

### Relayer/Admin

- polls rounds
- runs TEE matching (iExec bulk request)
- posts Merkle root on-chain
- writes match payload files used by the API
- serves matches via API for the frontend

## Round Lifecycle

Terminology:

- **Intake phase**: traders submit intents on-chain (and protected data off-chain).
- **Matching phase**: relayer runs TEE matching after intake ends (post-end window).
- **Root posted**: relayer posts Merkle root committing to matches.
- **Executable window**: traders can execute until the root expires (`VITE_ROOT_VALIDITY_SECONDS`).

Important:
- your on-chain config can have `intakeWindowSeconds == durationSeconds`, which means there is no on-chain “matching window”. The relayer can still run matching post-end if you design it that way.

## Trader Flow (End-to-End)

### 1) Connect wallet

Use the dApp to connect a wallet. For stability during development, prefer having only one injected wallet extension enabled.

### 2) Protect intent (encrypt)

This encrypts your intent payload using iExec DataProtector.

If you see configuration errors for the wrong `chainId`, confirm your app is using the intended network config for Arbitrum Sepolia.

### 3) Grant access (bulk)

The relayer/TEE matcher must be able to read protected data. Grant bulk access to the authorized requester address:

- requester should be `VITE_ADMIN_ADDRESS` (demo setup)

If the relayer logs show `no_bulk_access`, the grant is missing or mismatched.

### 4) Submit intent to round

The on-chain intent registration should succeed. Your intent count should reflect on the round view.

## Relayer Flow

### 1) Poll rounds

The relayer polls at `POLL_INTERVAL_SECONDS` and determines which rounds are eligible to match.

### 2) Ensure iExec prerequisites

Matching typically requires:
- an app order exists for the iExec app
- requester stake is sufficient

If these are missing, matching can stall even if access is correct.

### 3) Run TEE matching

The relayer submits a bulk request and waits for results. This can take ~30–60 seconds or more.

### 4) Post root

If matches exist:
- post Merkle root to `ShadowPoolRootRegistry`
- write match payload to `shadow-pool-terminal/data/relayer/<roundId>.json`

## Execution Flow (Trader)

Traders must sign:
- ERC-20 approval tx (if allowance insufficient)
- swap execution tx

Traders should not need to sign:
- match leaf signatures (the hook verifies against a configured signer; in this demo, leaf signatures come from the relayer/admin key)

## Typical Failures and Fixes

- `no_bulk_access`: missing or mismatched bulk grant to requester/app
- empty matches: matching produced zero fills (parameters didn’t cross, or access/data mismatch)
- swap fails:
  - pool not initialized / zero liquidity / wrong pool key
  - minOut too strict for current price/liquidity

See `/Users/aomine/Desktop/iexec2/docs/LIQUIDITY.md`.

## Production Notes (High Level)

- Relayer should run as a service (not a local terminal process).
- Match payloads should be served via an authenticated API (or sanitized public aggregates, depending on your privacy goals).
- Avoid storing or serving counterparty-identifying details publicly unless required by your threat model.

