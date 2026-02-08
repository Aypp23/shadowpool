# iExec Tooling Feedback (ShadowPool Integration)

This document captures feedback from integrating iExec **DataProtector** + **bulk access** + **TEE execution** into ShadowPool:

- Round-based intent ingestion (encrypted datasets)
- Off-chain matching inside a TEE worker
- On-chain root posting + proof-based execution
- Relayer-driven orchestration (poll → preflight → run → download → publish)

Audience:

- iExec SDK/tooling maintainers
- builders implementing relayer-style pipelines on iExec

The goal is to highlight what worked, what caused friction, and what would make integrations materially easier.

---

## What Worked Well

### DataProtector maps cleanly to intent privacy

- The protect → grant → consume model matches “private intents consumed by a TEE matcher” extremely well.
- Protected Data provides a simple abstraction for encrypting per-user payloads without inventing custom crypto.

### Bulk access + bulk execution enable real batching

- Bulk access is a practical primitive for batching many datasets into a single matching run.
- Bulk request processing is a good fit for relayers that need throughput and predictable orchestration.

### The platform has all the primitives needed for a trust-minimized flow

- On-chain enforcement (e.g., “execute only if TEE authorized”) composes with iExec’s confidential compute outputs.
- The matching service can be kept stateless, with output verification and distribution handled externally.

---

## Pain Points (Developer Experience)

### 1) Chain configuration errors are hard to diagnose

Observed error example:

- `Missing required configuration for chainId 1: subgraphUrl, dataprotectorContractAddress, sharingContractAddress, ipfsGateway, defaultWorkerpool, ipfsNode`

What makes this hard:

- It’s unclear which runtime path selected `chainId=1` (wallet, provider defaults, or SDK fallback).
- The error does not identify which SDK entrypoint triggered it (which call) and which missing field blocks that call.
- Builders end up trial-and-erroring env vars and providers.

Suggestions:

- Add `validateConfig({ chainId }) -> { ok, missing[], selectedChainId, usedNetwork, hints[] }`.
- Include the caller context in thrown errors:
  - SDK call name (e.g., `core.getGrantedAccess`, `core.prepareBulkRequest`, `core.processBulkRequest`)
  - selected chainId and network label
  - a minimal “how to fix” hint (e.g., “set allowExperimentalNetworks”, “switch provider chain”).
- Add a `debug: true` option that prints a redacted “resolution trace”:
  - which provider supplied chainId
  - what config source was used (defaults vs user-provided vs env)
  - which config fields were read

### 2) Bulk access mismatches need first-class diagnostics

When matching fails due to access mismatch (often surfaced as “no bulk access”), builders typically don’t know if they granted:

- the wrong requester address
- the wrong iExec app address / whitelist address
- non-bulk access instead of bulk access
- access with an expiry or remaining uses that have been consumed

Suggestions:

- Provide a helper that answers one question clearly:

  “Is this protected dataset bulk-granted to this requester for this app?”

  Example API:

  - `diagnoseAccess({ protectedData, app, requester }) -> { ok, reason, grants[] }`

- Provide a copy/paste “debug bundle” structure that can be shared in issues without secrets:
  - protectedData address
  - app address (or ENS)
  - requester address
  - workerpool address (if relevant)
  - grant type (`bulkOnly`, `single`)
  - remaining uses / number of accesses
  - grant expiry

### 3) Long-running TEE tasks need better progress visibility

Bulk requests commonly take 30–60s+ (sometimes more). Without structured progress, the UX becomes:

- “it’s stuck” even when it’s actually running
- unclear whether failure is RPC, orderbook, task execution, or result download

Suggestions:

- Provide a standard “task progress stream” abstraction with recommended steps:
  - `FETCH_ORDERS`
  - `DEAL_CREATED`
  - `TASK_RUNNING`
  - `TASK_COMPLETED`
  - `DOWNLOAD_RESULT`
  - `DECRYPT_RESULT` (if applicable)
- Provide official timeout/retry guidance:
  - RPC timeouts
  - task polling intervals
  - download retries with jitter
  - idempotent resumption (e.g., “if deal exists, reuse it”).

### 4) Stake/apporder preconditions surprise relayer implementations

Relayer-style pipelines can fail in ways that look like “TEE failed”, but root causes are often:

- no free app order published (or incompatible app order)
- requester stake not funded / insufficient stake for volume
- workerpool order constraints

Suggestions:

- Add official idempotent helpers:
  - `ensureFreeAppOrderPublished(app)`
  - `ensureRequesterStake(min)`
  - `ensureWorkerpoolOrder(workerpool, constraints)`
- Document a “preflight checklist” that relayer authors can run before processing rounds.

### 5) Result download and output parsing need ergonomics

Common pain points in practice:

- output payloads can be absent or malformed (esp. if the iApp wrote non-deterministic paths or failed late)
- distinguishing “task finished but output invalid” vs “download failed” vs “execution failed” is often ambiguous

Suggestions:

- Provide a safe `downloadResultOrThrow(taskId)` that returns:
  - `rawResult` + `decoded` (optional)
  - clear error classification: `TASK_FAILED`, `DOWNLOAD_FAILED`, `INVALID_OUTPUT`, `DECODE_FAILED`
- Add clear conventions for “computed.json” and deterministic output paths, with a validator:
  - `validateComputedJson(outputDir)`.

---

## Production Guidance (What Would Help Builders)

### A relayer starter template (official)

An opinionated template would accelerate adoption if it includes:

- polling a registry (or intake source)
- validating access per dataset (bulk grants)
- preflighting stake and orders
- submitting bulk requests
- downloading and validating outputs
- emitting structured logs + metrics (durations per stage, task ids, deal ids)

This would reduce repeated re-implementation across projects and encourage best practices.

### A privacy-safe API patterns guide

Relayers often need to publish “match availability” without leaking sensitive info. Guidance on patterns would help, such as:

- serving public aggregates (counts, roots, round metadata)
- gating private match details to authenticated traders
- k-anonymity thresholds for public stats
- counterparty-redaction strategies (avoid leaking the other side)

---

## Quick Diagnostic Checklist (Relayer/Builder)

When “matching failed” or “no bulk access” happens, a standard checklist would prevent hours of guesswork:

- Chain:
  - does the provider chainId match the intended environment?
  - does the SDK have all required chain config for that chainId?
- Access:
  - dataset bulk-granted to the correct requester?
  - authorized app matches the one used by the relayer?
  - grant still valid (expiry/remaining uses)?
- Orders / stake:
  - free app order exists and is compatible?
  - requester stake funded above minimum?
  - workerpool order constraints satisfied?
- Task lifecycle:
  - deal created successfully?
  - task reached `COMPLETED`?
  - output downloadable?
  - output matches the expected schema?

Providing SDK helpers that print this checklist with real values would be a big win.

---

## Summary

The primitives are strong, and the architecture is viable for privacy-preserving relayer pipelines. Builders would benefit most from:

- configuration validation + chainId resolution diagnostics
- first-class access mismatch diagnostics (especially bulk grants)
- progress visibility for long-running bulk requests
- relayer-oriented preflight utilities (stake/orders/workerpool)
- better result download + output validation ergonomics
