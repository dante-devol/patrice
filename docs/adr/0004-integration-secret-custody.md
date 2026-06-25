# ADR 0004 — Outbound sync custodies the bot token, behind a `SecretCipherPort`

- **Status:** Accepted
- **Date:** 2026-06-25
- **Context slice:** Discord integration (issue #46), outbound push (M3/M4)

## Context

ARCHITECTURE §2.8 states Patrice "custodies no long-lived integration secret — auth is
delegated to the provider." Outbound sync breaks that: the Discord **bot token** must be
presented to Discord in **plaintext on every call**, so it is a long-lived secret Patrice
must hold *at rest*, and it is necessarily **reversible** — it cannot be one-way hashed like
a password. Today it sits as plaintext `config.botToken` and is returned by
`GET /api/integrations` (the `list` path returns raw rows) — a present leak.

## Decision

Introduce a **`SecretCipherPort`** (mirroring the `STORAGE_DRIVER` local/s3 pattern):

- The token moves out of `config` into **`credentials_ref`, holding a cipher-tagged
  handle** the port resolves: `aead:<ciphertext>` inline (self-host default, AES-256-GCM,
  key in env, separate from `TOKEN_PEPPER`), `vault:<path>` / `kms:<keyid>:<wrapped>` for
  cloud (master key never touches Patrice; a stolen DB yields only ciphertext).
- **Decryption happens only in the `worker` role** (the only tier that calls Discord), which
  alone holds the key (ADR 0003). The token is **never returned by any read endpoint** —
  redaction is unconditional.
- v1 supports **token rotation** (admin re-supplies a token → re-encrypt). **Key rotation**
  is a documented operational procedure (re-encrypt all connections), not a v1 feature.
- App-level secrets (`DISCORD_CLIENT_SECRET`, peppers) stay **env-only** — out of the port's
  scope. This **narrows** the §2.8 "custodies nothing" claim to the *inbound / OAuth* paths
  rather than contradicting it.

## Consequences

- **Sequencing:** redact-on-read is pulled out to a **pre-M1 hotfix** (independent of the
  cipher, closes the present leak); the `config → credentials_ref` + AEAD-env move lands
  **with M3** so the token is never plaintext once outbound exercises it; the Vault/KMS
  *adapters* land at M4.
- A stolen DB/backup alone never yields a usable token (needs the env key too, or the
  external KMS/Vault); a compromised `api` process holds neither token nor key.
- The added risk is one standing provider credential, not a new class — Patrice already holds
  peppers and the OAuth client secret in env.
