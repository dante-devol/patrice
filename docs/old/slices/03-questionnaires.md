# Slice 3 — Questionnaires

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** Slice 2 (divisions, the `division:update` action).*

**Goal.** Implement the always-present **questionnaire** model — the 7 question types with
qualities — as a **division default** the admin can author, plus the per-task copy mechanism (used
by Slice 4) and the Angular renderer (authoring + answering modes). After this slice a division has a
real default questionnaire that tasks will copy.

**Acceptance demo.**
1. Admin opens the **Writing** division → questionnaire builder → adds a **Detail-Text** question
   ("Submit your writing", required). Saves.
2. Admin opens **Art** → adds an **Attachment** question (allowed: png, jpg, model files).
3. Admin opens **Testing** → adds a mix: Text, Numeric (1–10 integer), Radio (options), Attachment.
4. Each renders correctly in the builder and validates its constraints (numeric range, required,
   option lists). A `questionnaire` row exists for each division with `owner_division_id` set.

**In scope.** `questionnaire`/`question` tables; the division-default questionnaire (created & edited
via `division:update`); the per-type **constraint** model; the Angular **questionnaire renderer**
(one component per type) in **authoring** and **answer** modes; the server-side
**answer-validation function** (used by Slice 5, built & unit-tested here).

**Not in scope.** Tasks/submissions (Slice 4/5) — but the answer-validation function is written here
and unit-tested with synthetic answers.

## Schema (add)
```
questionnaire  id, organization_id, created_at,
               owner_division_id uuid null UNIQUE → division(id),   -- exactly one of the two owner FKs is set
               owner_task_id     uuid null UNIQUE → task(id),       -- task FK target lands in Slice 4
               CHECK ((owner_division_id IS NOT NULL)::int + (owner_task_id IS NOT NULL)::int = 1)
question       id, questionnaire_id→questionnaire, ordinal int, type, prompt text, required bool,
               constraints jsonb
               type ∈ ('detail_text','multiline','text','numeric','dropdown','radio','attachment')
```
**Ownership exclusivity is schema-enforced** (UNIQUEs + CHECK) — no questionnaire row is ever
shared across two divisions or two tasks, and never simultaneously a division-default and a
task-copy. The architecture's *"editing a division default never mutates existing tasks"* claim
rests on this; the schema is the backstop, not just the test suite.

**No `division.default_questionnaire_id` column** (revised from the earlier draft) — the owner
columns on `questionnaire` are the single source of truth. *"Does this division have a
questionnaire?"* is `EXISTS(questionnaire WHERE owner_division_id = $div_id)`; *"this task's
questionnaire"* is fetched via the inverse relation `questionnaire WHERE owner_task_id =
$task_id` (Prisma models it as an optional inverse relation; the DB guarantees presence for
non-coordination tasks).

**`constraints` jsonb shape per type:**
- `detail_text`/`multiline`/`text`: `{ maxChars?: int, minChars?: int }`
- `numeric`: `{ kind: 'integer'|'float', min?: number, max?: number }`
- `dropdown`/`radio`: `{ multi: bool, options: [{value, label}], minSelect?, maxSelect? }`
- `attachment`: `{ allowedTypes: [mime/ext...], maxBytes?, maxFiles?: int }`

## Answer-validation function (server, pure)
`validateSubmission(questionnaire, answers, attachmentLookup) → ok | { errors[] }`. Rules: every
`required` question answered; each answer matches its type + constraints; resource answers
reference an allowed-type attachment. **Port-injected**: `attachmentLookup(id) → {content_type,
kind} | null` is an injectable port — Slice 3 unit-tests with a stub returning synthetic
attachments; Slice 4 implements the real adapter; Slice 5 wires it through `task:submit`. Reused
verbatim by Slice 5.

## API endpoints
```
GET   /divisions/:id/questionnaire                     → the division default (or 404 if none)
PUT   /divisions/:id/questionnaire   (division:update) → upsert + replace the question set
```
**PUT semantics:** if no `questionnaire` row exists for this division (no row with
`owner_division_id = $div_id`), create one (with `owner_division_id` set). If one exists, **update
its question children in place** (rewrite `question` rows under the same `questionnaire.id` —
identity is stable across question-set edits because `UNIQUE(owner_division_id)` prevents a
sibling row for the same division). **An empty `question[]` is a valid input** — it explicitly
authors a zero-question questionnaire, which is the way to make a coordination-only division
(tasks created there carry an empty questionnaire and reach Approved via `task:complete` or
empty-submission validation).

*(The per-task questionnaire-editing endpoint — gated `task:configure_questionnaire` — is added in
Slice 4 where tasks exist; it edits a task's copy and is the same shape.)*

## Web (Angular)
- **Questionnaire builder** (authoring): add/reorder/remove questions, pick type, set constraints;
  the **same** renderer drives it. Build it as: a `QuestionnaireFormService` (application layer) that
  maps `question[] → Angular FormGroup`, plus a presentational `QuestionRenderer` switching on the 7
  types. Authoring mode edits definitions; answer mode (used in Slice 5) binds values.
- Mount it inside the Slice-2 Division editor.

## Tests
- Round-trip each of the 7 types with constraints; persistence + reload.
- `validateSubmission`: required-missing → error; numeric out-of-range → error; wrong attachment type
  → error; happy path → ok. (Synthetic answers — no task needed.)
- Builder renders all 7; numeric/radio constraints enforced client-side.

**Done when** each division can carry a real default questionnaire authored from the 7 types, and the
shared validator + renderer are proven.
