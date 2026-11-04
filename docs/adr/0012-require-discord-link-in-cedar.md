# ADR 0012 — `requireDiscordLink` is a Cedar forbid

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
The setting was only read by the browser, so the API never enforced it (problems D14).

## Decision
- When the setting is on and there is an active Discord connection, a principal who isn't
  linked to every active connection is denied every task-family action by a static Cedar
  `forbid`. Account, profile, linking and admin surfaces stay reachable.
- `task:bypass_discord_gate` is a grantable exemption (e.g. contractors not on Discord).
- `/me` reports `taskAccessBlockedByDiscord` so the client can explain.

## Consequences
The gate is enforced where everything else is, and a forbid means the same thing as
anywhere else.
