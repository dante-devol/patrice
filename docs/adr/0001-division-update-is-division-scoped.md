# ADR 0001 — `division:update` is scoped to the Division, not the Organization

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context slice:** Slice 3 (Questionnaires), issue #15

## Context

Slice 2 registered `division:update` with Cedar `resourceType: 'Organization'` and
authorized the division PATCH endpoint against the singleton org (`orgResource`),
grouping it with the governance actions (`grant:*`, `role:*`, `division:create/retire/
revive`). In practice this made `division:update` **global-only**: a grant scoped to a
specific division could not be expressed (the grant-shape validator rejects
`specific_division` for an Organization-resourced action), and the org resource carries
no `division` attribute for a scope condition to match.

Slice 3 adds `PUT /divisions/:id/questionnaire` (gated `division:update`) and requires
that **a division admin scoped to one division cannot edit another division's
questionnaire** (issue #15: "PUT by a non-owner division rejected (403)"). The
architecture already marks `division:update` as **(S) — scopable** (ARCHITECTURE.md
§2.3). The Slice 2 placement on Organization was a simplification, not an intentional
narrowing of the capability surface.

## Decision

`division:update` now applies to the **Division** Cedar entity type:

- `actions.ts`: `divisionUpdate.resourceType = 'Division'` (added `'Division'` to
  `CedarEntityType`). `division:create/retire/revive` stay Organization-resourced
  (governance), keeping revive clear of the Retired-as-Hard-Deny per the Slice 2 note.
- `cedar/schema.ts`: the `Division` entity gains an optional self-reference
  `division?: Division` so a `specific_division`/`own_division` scope condition
  (`resource.division == Division::"X"`) validates against the schema.
- `grants.service.ts`: `Division` joins `GROUP_SCOPABLE`, so `specific_division`
  grants on `division:update` pass shape validation. `grant:create` and the other
  governance actions remain Organization-resourced and are still rejected when scoped.
- `authorize.decorator.ts`: a `divisionResource` resolver loads the `:id` division and
  returns it as the Cedar resource, carrying `division` (self) + `retired`.

The questionnaire `PUT` authorizes via `divisionResource`. The existing division
`PATCH` endpoint is **left on `orgResource`** — it is request-time schema-less, so a
global `division:update` grant still matches, and no Slice 2 behaviour changes.

## Consequences

- A `specific_division`-scoped `division:update` grant now lets a division admin edit
  only their own division's questionnaire; a global grant (the seeded Admin) still
  edits any division. Editing a **retired** division's questionnaire is blocked by the
  Retired-as-Hard-Deny (the division resource reports `retired`).
- Minor asymmetry: division `PATCH` (general settings) remains effectively global-only
  because it resolves the org as its resource. If per-division settings editing is
  wanted later, point that endpoint at `divisionResource` too — no further engine
  change needed.
- The team analogue (`team:update`) is untouched; revisit symmetrically if/when a
  team-scoped editing surface lands.
