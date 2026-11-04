# Patrice visual language — "graphite sheet"

The working rules for how the web UI looks. They replace the earlier "drafting board"
direction (oat board, IBM Plex trio, a rounded card per task). The page layouts don't
change; this file fixes the **font, colour and shape** vocabulary every page draws from.

The aim is a UI that looks like nobody else's while staying as functional as it is
now. One idea runs through it: **work is listed on ruled sheets of paper, and each mark
on the sheet means one thing.**

## What a task shows

These fields are the data that matters, in this order of emphasis:

1. Task name
2. Overall status
3. Claimant(s)
4. Division
5. Team
6. Task ID
7. Requester

The description is **not** shown in lists. It appears only on the task detail page.
Per-claimant submission state is allowed on the detail page but is never emphasised.

## Colour

| Token | Hex | Use |
|---|---|---|
| `board` | `#E2E4E7` | Page background. Cool grey, flat — no dot grain. |
| `paper` | `#FFFFFF` | Sheets, dialogs, inputs. |
| `paper-alt` | `#F5F6F8` | Every second row on a sheet (see Rows). |
| `graphite` | `#2A2D32` | Text, primary buttons, focus ring, the Claimed stamp. |
| `soft` | `#62666E` | Secondary text: IDs, requester, timestamps, field labels. |
| `line` | `#D5D8DD` | Rules between rows, sheet and input borders. |
| `margin` | `#9AA6B6` | The margin rule only (see Shape). |
| `faint` | `#A3A7AE` | Dashed "empty / open" outlines. |

**Division hues** (client defaults until divisions get a `color` column): writing
`#3F5FB5`, art `#C0563A`, scripting `#2D8060`, testing `#7B57A8`, leadership `#A57F12`.
**Team** text takes a stable hue hashed from the team's name (`teamColor` in
`task-presentation.ts`) until teams get a configured colour too.

**Status colours** (text / outline):

| Status | Text | Outline |
|---|---|---|
| Open | `#62666E` | 1.5px dashed `#A3A7AE` |
| Claimed | `#2A2D32` | 1.5px solid `#2A2D32` |
| In review | `#7A5B00` | 1.5px solid `#A9810F` |
| Revising | `#8E3B26` | 1.5px solid `#C0563A` |
| Approved | `#2D6B50` | 1px solid `#8FC2A8` |
| Rejected, Retired | `#62666E` | 1px solid `#C9CCD1`; the row's name is struck through |

Rejected is a submission state (a rejected claimant keeps their seat), so it appears on
submissions, not as a task status. Admin lifecycle states reuse the same stamps: Active takes the Approved
treatment, and Retired takes the Rejected one.

Rules:

- Colour encodes **division** (spine and tag) and **status** (stamp), nothing else.
  There's no brand accent colour; the primary action is graphite.
- Approved is deliberately the quietest stamp: finished work recedes so the board's
  attention goes to what's still moving.
- Never fill a stamp. Status is always an outline with coloured text.
- Errors use the revising rust (`#8E3B26` text) — a returned task and a failed action
  are the same kind of "needs another pass".

## Type

| Role | Face | Weight | Size |
|---|---|---|---|
| Page title (task name on detail, page headings) | Bricolage Grotesque | 700 | 28px |
| Row title (task name in lists), sheet headings | Bricolage Grotesque | 700 | 18px |
| Body, comments | Atkinson Hyperlegible | 400 | 15px / 1.55 |
| UI: meta line, labels, buttons, stamps | Atkinson Hyperlegible | 400 / 700 | 13px (stamps 12px) |

Rules:

- **Two faces, two weights.** Bricolage is only ever for names of things (tasks, pages,
  sections). Everything else is Atkinson.
- **No monospace.** The task ID is Atkinson in `soft`, sitting with the tags.
- **Sentence case everywhere**: labels, tabs, stamps, buttons ("In review", "Divisions",
  "Request a task"). No all-caps, no letter-spaced labels.
- No middle-dot strings. Separate meta items with a 10px gap; separate *what* from *who*
  with the margin rule.
- No arrow glyphs (`→`) appended to links or buttons.

## Shape

Each shape has one meaning. Don't reuse a shape for anything else.

| Shape | Means |
|---|---|
| **3px spine** in the division hue, full row height, square ends | Which division a task belongs to. |
| **Circle** | A person. Avatars are round, overlap by 6px with a 2px paper ring. Nothing else is round. |
| **Dashed outline** | Empty or open: an unclaimed slot, an Open stamp, a dropzone. |
| **Outlined stamp**, 2px corners, min-width 64px, centred text | A status. Stamps line up down the right edge of a sheet. |
| **Margin rule**: 3px double line in `margin` | Separates *what the task is* (division, team, ID) from *who* (requester, claimants). |
| **Ruled sheet** (`.sheet`): paper, 1px `line` border, 2px corners, rows divided by 1px `line` | A list of things. Lists are never a stack of separate cards. Every direct child is a row. |
| **Paper** (`.paper`): the same surface without rows | A single thing that isn't a list: a header, a form, a description. |

Corners are **2px** on sheets, stamps, inputs, buttons and dialogs. Circles are only for
people. There are no other radii.

**Shadows**: none on in-page surfaces. Only floating layers (dialogs, menus, toasts) get
one shadow: `0 18px 40px -16px rgba(42, 45, 50, 0.35)`.

## Rows

A task row, left to right:

```
│ Task name (Bricolage 18)                                  (MA)(AR)  [In review] │
│ Writing  USA  tloc  ‖  for Devin                                                 │
```

- Spine → name → meta line → avatars → stamp.
- Meta line order is fixed: division (hue, bold) · team (team hue) · ID (`soft`) ·
  margin rule · "for {requester}" (`soft`). Missing team just drops out.
- **Alternate rows**: odd rows `paper`, even rows `paper-alt`. The step is meant to be
  barely visible — enough to track a row across, not enough to read as stripes.
  Avatar rings take the row's own background.
- Hover darkens the row one step (`#EEF0F3`); there is no hover lift or shadow.

## Controls

- **Primary button**: graphite fill, white Atkinson 700 13px, 2px corners, 8px 14px padding.
  One per view.
- **Secondary button**: paper fill, 1px `line` border, graphite text.
- **Quiet action** (edit, revive, reply, cancel): plain `soft` text, underline on hover
  (`button.quiet` on the semantic pages).
- **Destructive quiet action** (retire, revoke, reject): rust text (`button.quiet.danger`).
- **Inputs**: paper, 1px `line` border, 2px corners, graphite focus ring (2px, 2px offset).
  Labels above in Atkinson 13px `soft`, sentence case.
- **Tabs**: sentence-case Atkinson 13px; the current tab is graphite and bold with a 2px
  graphite underline. No pills, no all-caps.

## Pages

- **Board / Home lists**: one ruled sheet per list. Section headings in Bricolage 18 above
  the sheet. Counts ("2 open, 4 in progress") are plain Atkinson text beside the heading,
  not a display-size number.
- **Task detail**: header has the spine down its left edge, the task name in Bricolage 28,
  the row's meta line beneath it, and the stamp on the right. The sidebar is a ruled sheet
  of label / value rows; claimants are its first rows, then the margin rule, then details.
  History is a ruled sheet of events; comments sit in the event's row, not in nested cards.
- **Admin**: every table is a ruled sheet with alternate rows. Inline-editable cells stay
  editable as they are today, but inputs inside a sheet drop their border until hovered or
  focused, so a table reads as text first.
- **Auth pages**: a single small sheet on the board, under the app header's wordmark. The "or" divider between password and Discord sign-in is a plain 1px `line`
  rule, not the margin rule. Continue with Discord is a secondary button with the Discord
  mark in its brand colour; no blurple fill.
- **App header**: the wordmark in Bricolage 19, nav links in Atkinson 13. The current page
  is graphite and bold with a 2px underline, the same treatment as tabs.
- **Admin name cells** carry the division or team colour as a 3px left edge, the same
  spine as task rows.
- **Permissions**: never a role × action grid. A searchable role list (standalone,
  divisions, teams; teams collapsed) beside one role's grants, grouped by resource, with
  each action named in words and its code name in `soft`. "By action" flips it: pick an
  action, see every role holding it. Both views edit one working copy; nothing saves until
  **Save changes**, in a save bar that floats (float shadow) at the bottom of the sheet.
  An unsaved row gets a 3px **rust** left edge and its old scope struck through beneath
  it; roles and actions with unsaved edits carry a small rust dot. "Not granted" and a
  target still to pick use the dashed outline. Every scope picker has a tooltip (`.hint`)
  saying exactly what the scope lets the person do.
