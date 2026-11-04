# Cutover rehearsal

There is no production data yet, so the cutover was rehearsed on a re-seeded instance
(redesign plan, Phase 8, item 1). Run date: 2026-11-04.

## Method

1. Build a database at the pre-redesign schema (`main`), run the old API, and load the
   demo set with `api/scripts/seed.mjs` through the old API (6 users, 5 divisions,
   2 teams, 7 tasks across every status, submissions, threads, notifications).
2. Snapshot with `api/scripts/cutover-snapshot.mjs`: row counts per entity, every task's
   status, and — signing in as each user — the tasks each one can see.
3. Apply every redesign migration (`prisma migrate deploy`), start the new version, and
   snapshot again.
4. Compare (`cutover-snapshot.mjs --compare before.json after.json`).

To repeat it against a copy of real data: restore the copy, start the old version, take
the *before* snapshot, migrate, start the new version, take the *after* snapshot, compare.

## Result

| entity | before | after | why it changed |
|---|---|---|---|
| users | 6 | 6 | |
| roles | 9 | 2 | Division and team inherent roles became memberships (ADR 0007); a pre-existing "Member" role was adopted as the seeded one |
| grants | 40 | 90 | Admin now holds every action (ADR 0016); Member's starter grants were topped up |
| user_roles | 6 | 7 | Everyone already there holds Member, now including the admin |
| divisions / teams | 5 / 2 | 5 / 2 | |
| tasks | 7 | 7 | |
| seated claimants | 6 | 6 | |
| submissions / answers | 5 / 5 | 5 / 5 | Answers now point at task questions with the same ids |
| messages | 22 | 2 | 20 system messages became typed events (ADR 0009); 2 + 20 = 22 |
| domain events | 0 | 20 | |
| notifications | 20 | 20 | |

Every task kept its status (open ×2, claimed, revising, review ×2, approved), and every
user can see exactly the tasks they could see before (7 each).

## What the rehearsal caught

The first run showed every existing member able to see **no** tasks after the upgrade.
Reads used to need no grant; the redesign gates them through the seeded Member role, but
that role was only handed to new invitations — and the old install already had a role
named "Member", so a second one was created. Bootstrap seeding now adopts an existing
"Member" role, tops up its grants, and gives it to every active user on first seed
(`test/upgrade-seed.e2e-spec.ts`). The second run is the result above.

## Not covered

- Access was compared as task visibility. Write actions are covered by the e2e suites,
  not compared across versions (the old version authorized writes differently by design).
- Integration data: the seed creates no Discord connections. Plaintext and Vault/KMS
  token handles are upgraded or flagged by the worker at boot (`TokenWorker`).
