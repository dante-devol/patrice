# ADR 0011 — Seat semantics: leave, retire, reject, evict

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
The claim lifecycle contradicted the settled rules (intent-vs-reality §6.1, problems
D28): claimants could leave after submitting, retired submissions left the claimant
seated, and an evicted claimant's submission stayed unresolved (D17).

## Decision
- A seat is a person's place on the task. A claimant can't leave once they've submitted
  in their current tenure.
- Retiring a submission removes its claimant and opens the seat for anyone; a return is
  the redo path.
- Rejection keeps the claimant seated, unable to resubmit.
- Eviction is always allowed; the evictee's current-tenure submissions become rejected
  records, the timeline records an eviction, and the evicted user is notified.
- Only submissions from a claimant's current tenure count toward status or resubmission.

## Consequences
Every submission is resolved, and taking a seat again always starts clean.
