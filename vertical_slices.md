# Patrice — Vertical Slices (index)

The build plan now lives as **individual slice files** in [`slices/`](slices/), so an
implementing agent reads only the one slice it's working on (plus the shared overview).

**Start here:** [`slices/00-overview.md`](slices/00-overview.md) — purpose, the pinned tech
stack, global conventions, and the full slice list.

| # | Slice | File |
|---|---|---|
| 1 | Foundation, Auth, Access Engine & Bootstrap | [`slices/01-foundation-auth-engine-bootstrap.md`](slices/01-foundation-auth-engine-bootstrap.md) |
| 2 | Org Configuration | [`slices/02-org-configuration.md`](slices/02-org-configuration.md) |
| 3 | Questionnaires | [`slices/03-questionnaires.md`](slices/03-questionnaires.md) |
| 4 | Tasks — Creation, Claiming & Messages | [`slices/04-tasks-creation-claiming-messages.md`](slices/04-tasks-creation-claiming-messages.md) |
| 5 | Submissions & Review Lifecycle | [`slices/05-submissions-review-lifecycle.md`](slices/05-submissions-review-lifecycle.md) |
| 6 | Notifications | [`slices/06-notifications.md`](slices/06-notifications.md) |
| 7 | Retirement & Garbage Collection | [`slices/07-retirement-garbage-collection.md`](slices/07-retirement-garbage-collection.md) |
| 8 | Integrations (Discord) — *post-v1* | [`slices/08-integrations-discord.md`](slices/08-integrations-discord.md) |

Design rationale lives in [`ARCHITECTURE.md`](ARCHITECTURE.md); these slices implement it
top-to-bottom, each one a runnable, testable vertical cut.
