# Patrice

Vertical-slice build plan for a single-org task-tracking tool replacing a sprawl of Google
Drive sheets. See `docs/ARCHITECTURE.md` for the design and `docs/slices/` for the ordered,
full-stack build slices. Repo layout summary in `CONTEXT-MAP.md`.

## Agent skills

### Issue tracker

GitHub Issues at `dante-devol/patrice`; external PRs are **not** a triage surface. See
`docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles using their default strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `CONTEXT-MAP.md` at the root pointing at per-tier `CONTEXT.md` files
(`web/`, `api/`), once code lands. System-wide ADRs at `docs/adr/`. See
`docs/agents/domain.md`.
