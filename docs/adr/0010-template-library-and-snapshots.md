# ADR 0010 — A template library per division; tasks keep snapshots

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
A division had at most one request template, which every task deep-copied; requesters
couldn't choose or write their own; editing a task copy could crash once a submission was
retired (problems D6).

## Decision
- A division keeps a library of templates (unique names, at most one default). Creating a
  task chooses a library template, the default, or custom questions.
- Custom questions need `task:compose_template` on the division. A static Cedar policy
  permits it in divisions that set `allowCustomTemplates`, and a grant can permit it
  anywhere; a forbid blocks both. `task:create` is needed as well.
- A task keeps its own snapshot (`task_question`); answers reference the snapshot.
  Questions are edited by stable id; a question with answers can't be deleted.
- Library templates are hard-deleted with an audit row (tasks keep their snapshots);
  there is no archive.

## Consequences
Library edits never reach existing work. Templates aren't shared across divisions; a
template can be recreated in another division. An archive flag can be added if admins
ask to hide templates temporarily.
