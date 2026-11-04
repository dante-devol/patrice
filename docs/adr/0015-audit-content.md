# ADR 0015 — Audit records configuration, not user text

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
Audit payloads mixed ids, free text (moderation reasons) and nothing at all for edits
(intent-vs-reality §6.5, problems D18).

## Decision
- `activity` is append-only and Zod-validated per verb.
- Configuration changes record before/after values (`changes`): names, flags, counts,
  scopes, question types.
- User-authored text (prompts, descriptions, reasons, bodies) is recorded by id; a
  moderation reason lives only on the task timeline, which the audit row references.

## Consequences
The audit log explains configuration history and stays safe to keep after a GDPR scrub.
