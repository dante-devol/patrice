# Context Map

Patrice ships as two strictly-bound tiers in one monorepo. The split is a **layer** split (web ↔ api), not a DDD bounded-context split — the domain language is shared, with most load-bearing terms anchored on the api tier where Cedar and Prisma live.

## Contexts

- [API](./api/CONTEXT.md) — NestJS backend, owns the domain model, the Cedar access engine, the Prisma schema/migrations, and the background-job queue
- [Web](./web/CONTEXT.md) — Angular frontend, signals-first, consumes the OpenAPI client

## Relationships

- **Web → API**: HTTP over OpenAPI. Web holds no domain logic — it reflects API state and re-authorizes every action server-side. No shared TypeScript types couple the tiers (the OpenAPI spec generated from the API's Zod contract is the shared artifact; the web's types are generated from it — see `docs/architecture.md §3`).

## Where the canonical glossary lives today

[`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md) is the cross-tier glossary and [`docs/architecture.md`](docs/architecture.md) the system description. Per-tier `CONTEXT.md` files add tier-specific vocabulary.

## System-wide architectural decisions

ADRs live at [`docs/adr/`](./docs/adr/) — created lazily when the first one is needed. The grilled-and-committed decisions in `docs/slices/` are the implementation contract today; ADRs document changes *to* that contract.
