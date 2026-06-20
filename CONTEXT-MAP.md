# Context Map

Patrice ships as two strictly-bound tiers in one monorepo. The split is a **layer** split (web ↔ api), not a DDD bounded-context split — the domain language is shared, with most load-bearing terms anchored on the api tier where Cedar and Prisma live.

## Contexts

- [API](./api/CONTEXT.md) — NestJS backend, owns the domain model, the Cedar access engine, the Prisma schema/migrations, and the background-job queue
- [Web](./web/CONTEXT.md) — Angular frontend, signals-first, consumes the OpenAPI client

## Relationships

- **Web → API**: HTTP over OpenAPI. Web holds no domain logic — it reflects API state and re-authorizes every action server-side. No shared TypeScript types couple the tiers (the OpenAPI spec is the contract, not TS types — see `docs/ARCHITECTURE.md §4.1`).

## Where the canonical glossary lives today

`docs/ARCHITECTURE.md §2.1` still carries the canonical domain glossary, and `docs/slices/00-overview.md` adds project-level load-bearing terms (Effective Admin, the `scope_kind` shapes, etc.). Per-tier `CONTEXT.md` files extend that glossary with tier-specific vocabulary and will gradually absorb cross-cutting terms as code lands and `docs/ARCHITECTURE.md` is decomposed.

## System-wide architectural decisions

ADRs live at [`docs/adr/`](./docs/adr/) — created lazily when the first one is needed. The grilled-and-committed decisions in `docs/slices/` are the implementation contract today; ADRs document changes *to* that contract.
