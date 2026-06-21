# Tasks UI — design spike

A **first-pass visual direction** for the Tasks slice, inspired by GitHub/GitLab issues but
built around what's actually distinctive about Patrice: work is **claimed** (openings/slots) and
its status is **derived**, not set. Two static prototypes, not wired into the Angular app:

- [`tasks-overview.html`](./tasks-overview.html) — the work board (ticket list + facets)
- [`task-detail.html`](./task-detail.html) — one ticket, with the unified **History** timeline

**View it:** open either file directly in a browser. They use the **Tailwind Play CDN** + Google
Fonts, so they need network access on first load but no build step.

## The direction

- **Color encodes division — and team.** Both are facets you filter by, so both carry a
  configurable hue. **Division = square chip + the left spine** (the structural axis); **team =
  round chip** (the grouping axis). Shape tells you which one you're reading. Colors are set per
  row via `--c` / `--tc` to make it obvious they're per-entity config, not hardcoded.
- **Signature: the slot gauge — but only when it earns its place.** Since **1-of-1 is the norm**
  (only ~one division allows multiple claims), single-claim tasks just show the **assignee avatar**
  (or a dashed "unclaimed" circle when open). The `●●○ 2 of 3` pip gauge appears **only on
  multi-claim tasks**, so it reads as a real signal — "this one takes several." On the detail page
  a multi-claim task expands into a **claim strip** (one row per opening); a 1-of-1 collapses to a
  single assignee.
- **Status is a rubber stamp** (mono, bracketed). **Open renders hollow / un-inked** — nothing has
  happened yet. No tilt.
- **Avatars come from Discord.** Circular; we don't host the images. The solid initial-filled
  circle is just the *fallback* — the real avatar is an `<img>` off Discord's CDN.
- **Type: IBM Plex trio** — Serif for task titles (ledger "entries"), Sans for UI, Mono for all
  data (ids, counts, timestamps, stamps).
- **History = one stream.** System events (requested / claimed / submitted / returned) interleave
  with comment cards on a single timeline rail — status/updates and discussion kept together.
- **Copy uses the domain verb.** A task is created by its **requester**, so the primary action is
  *Request a task* and the audit reads *requested by …*.

## Backend gaps this design implies

This is intentionally a step ahead of the API — a few pieces will need server work before it's real:

- **Division/team colors** need a `color` column on `division` and `team` (a DB migration); right
  now there's no place to store them.
- **Avatars** depend on **Slice 8 (Discord integration)** — the `external_identity` link is what
  yields the avatar URL. Until then it's initials-only.
- **Team color as a first-class facet** assumes teams are surfaced in list responses the way
  divisions are (they are, via `LookupStore`).

## Tokens

The palette/type tokens live in the inline `tailwind.config` at the top of each file (duplicated
for now so each prototype is self-contained):

| Token | Hex | Role |
|---|---|---|
| `board` | `#E7E8E1` | page surface (cool oat — deliberately not cream) |
| `paper` | `#FBFBF8` | card surface |
| `ink` / `ink-soft` | `#191B19` / `#5B605C` | text |
| `line` | `#D3D5CC` | hairline borders |
| `accent` / `accent-ink` | `#0F7A6B` / `#0A5249` | claim / approved / primary action (pine) |
| `div.{writing,art,scripting,testing,leadership}` | blue / clay / green / violet / ochre | division hues |

The brand bits that Tailwind utilities express awkwardly — `.spine`, `.stamp`, `.gauge`/`.pip`,
`.dtag`, and the `.timeline` rail — are small element-scoped classes in the `<style>` block.

## Turning this into the real app (when approved)

1. Add Tailwind to the Angular build (`@angular/build` + `tailwindcss` postcss) and move the
   inline `tailwind.config` → a shared `tailwind.config.ts` with these tokens.
2. Bring the signatures (`spine` / `stamp` / `gauge` / `timeline`) into `web/src/styles.css` as a
   small `@layer components` set, or as tiny presentational Angular components.
3. **spartan-ng** would back the interactive primitives — the status/facet menus, the comment
   composer, dialogs, tooltips on the gauge — while these bespoke pieces stay hand-rolled (they're
   the identity, not generic UI). spartan's unstyled "brain" + our Tailwind theme is the intended split.
4. Rebuild `task-list.component` and `task-detail.component` against the real `Task` / `Message`
   data (division/team via `LookupStore`, the message thread as the History stream, the
   submission/review panel feeding the slot strip).

> Scope note: only the Tasks overview + detail are designed here, per the brief. Everything else
> (admin, auth, notifications) is untouched.
