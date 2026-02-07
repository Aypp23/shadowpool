# iExec Tooling Feedback (ShadowPool Integration)

This document is feedback from integrating iExec DataProtector + bulk access + TEE execution into ShadowPool (a round-based intent matcher with on-chain root posting and proof-based execution).

It’s written for iExec SDK/tooling maintainers and for builders integrating similar relayer-driven patterns.

## What Worked Well

### DataProtector fits intent privacy

- The protect → grant → consume pattern maps cleanly to “private intents consumed by a TEE matcher”.
- Bulk access is a practical primitive for batching many protected datasets into one matching run.

### Bulk workflows compose with relayers

- A relayer service can act as a requester to read protected data for matching.
- The iExec workflow can be made robust when paired with:
  - preflight access checks
  - stake/apporder preflight checks
  - structured task progress logs

## Pain Points (Developer Experience)

### Chain configuration errors are hard to act on

Observed error example:
- `Missing required configuration for chainId 1: subgraphUrl, dataprotectorContractAddress, sharingContractAddress, ipfsGateway, defaultWorkerpool, ipfsNode`

Issues:
- it’s not obvious which runtime path selected chainId 1
- it’s not obvious which call requires which missing fields

Suggestions:
- provide a `validateConfig(chainId)` helper that returns a structured list of missing fields and a “quick fix” hint
- include the selected chainId and the caller context in thrown errors (SDK call name)

### Access mismatch (“no_bulk_access”) needs first-class diagnostics

When matching fails due to access mismatch, users typically don’t know if they granted:
- the wrong requester address
- the wrong iExec app address
- non-bulk access instead of bulk

Suggestions:
- publish a helper to verify “dataset is bulk granted to requester for app”
- provide a copy/paste “debug bundle” output:
  - dataset address
  - app address
  - requester address
  - grant type
  - grant expiry

### Long-running TEE tasks need better progress visibility

TEE bulk requests often take 30–60s+.

Suggestions:
- standard “task progress stream” utilities (FETCH_ORDERS, DEAL_CREATED, TASK_RUNNING, TASK_COMPLETED, DOWNLOAD_RESULT)
- recommended timeout/retry patterns for RPC and result download

### Stake/apporder requirements surprise relayer implementations

Without ensuring:
- free app orders published
- requester stake funded

matching can stall in ways that look like “TEE failed”.

Suggestions:
- official, idempotent helpers:
  - `ensureFreeAppOrderPublished(app)`
  - `ensureRequesterStake(min)`
- docs section explicitly calling out these preconditions for relayer patterns

## Production Guidance (What Would Help Builders)

- a “relayer starter template”:
  - polls a registry
  - validates access
  - checks stake/apporder
  - submits bulk request
  - downloads result
  - emits structured logs + metrics

- a “privacy-safe API patterns” guide:
  - how to serve match payloads without leaking counterparties
  - how to implement public aggregates (k-anonymity thresholds)
  - how to gate private match details to authenticated traders

## Summary

The primitives are strong, but builders need better:
- configuration validation
- access mismatch diagnostics
- progress visibility
- relayer-oriented “preflight” utilities

