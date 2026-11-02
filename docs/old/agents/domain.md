# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `<context>/docs/adr/` for context-scoped decisions.
- **`docs/ARCHITECTURE.md`** and **`docs/slices/`** — the design source of truth for v1. The canonical domain glossary currently lives in `docs/ARCHITECTURE.md §2.1`; per-tier `CONTEXT.md` files extend it tier-specifically and will gradually absorb shared terms as code lands. ADRs are for changes to this design.

If any of these files don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Patrice is laid out as a multi-context monorepo, one context per tier of `docs/ARCHITECTURE.md §1.2`. The tier split is a *layer* split, not a DDD bounded-context split — most domain terms live in `api/CONTEXT.md` (the API tier owns the canonical domain model via Cedar + Prisma), and `web/CONTEXT.md` carries the thinner UX-specific vocabulary.

```
/
├── CONTEXT-MAP.md
├── CLAUDE.md
├── docs/
│   ├── ARCHITECTURE.md                ← v1 design source of truth (rationale + glossary, today)
│   ├── slices/                        ← v1 build plan (one file per vertical slice)
│   ├── vertical_slices.md             ← index into the slice files
│   ├── adr/                           ← system-wide architectural decisions
│   └── agents/                        ← agent-skill configuration (issue tracker, labels, this file)
├── web/                               ← Angular frontend tier
│   ├── CONTEXT.md                     ← web-tier-specific vocabulary
│   └── docs/adr/                      ← web-specific decisions
└── api/                               ← NestJS backend tier (owns DB via Prisma)
    ├── CONTEXT.md                     ← API-tier vocabulary (load-bearing domain terms today)
    └── docs/adr/                      ← api-specific decisions
```

There is no separate `db/` context — the database schema and migrations are owned by the `api/` tier (Prisma lives there).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` (and the load-bearing glossary in `docs/slices/00-overview.md`, and `docs/ARCHITECTURE.md §2.1` for the broader vocabulary). Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR or a committed decision in `docs/ARCHITECTURE.md` / `docs/slices/`, surface it explicitly rather than silently overriding:

> _Contradicts `docs/ARCHITECTURE.md §2.3` (Cedar owns policy logic) — but worth reopening because…_
