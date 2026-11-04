# ADR 0018 — Bot tokens: one key, held by the worker

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** ADR 0004 (in `docs/old/adr/`)

## Context
The API encrypted tokens with the same key the worker used to decrypt them, compose gave
both the same environment, a missing key stored tokens in plaintext, and the dev stack
shipped a default key (problems D13).

## Decision
- One mandatory AES-256-GCM key, `INTEGRATION_TOKEN_KEY`, provided to the worker only; the
  worker refuses to start without it and there is no plaintext fallback.
- The API hands a new token to the worker in an `integration.store-token` job (no
  retries, no dead letter); the worker encrypts and stores it, then wipes the job's data.
- Admin-supplied `credentialsRef`, the Vault and KMS adapters and the dev default key are
  gone. At boot the worker encrypts any plaintext token left by older versions and flags
  unsupported handles for rotation.

## Consequences
The API container has no key in its environment; compromising it doesn't expose stored
tokens.
