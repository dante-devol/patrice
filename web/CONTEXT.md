# Web

The Angular frontend tier. Renders Patrice's domain state, drives user flows over the OpenAPI client, and **reflects** API permissions for UX (never enforces them — every action is re-authorized server-side, per `docs/ARCHITECTURE.md §2.3`).

## Language

This file holds *web-tier-specific* vocabulary. Cross-cutting domain terms (Task, Submission, Division, Role, Status, Effective Admin, etc.) live in `docs/ARCHITECTURE.md §2.1` and the API CONTEXT today; this file extends them only where the web tier needs its own precise word.

**Questionnaire Renderer**:
The single component family that walks the seven question types (Detail Text, Multiline, Text, Numeric, Dropdown, Radio, Attachment) to draw controls. Operates in two modes — *Authoring* (an admin or testing requester builds the question set) and *Answer* (a claimant fills it in for submission). The mode is a top-level prop on the renderer; the type-per-question switch is identical in both.
_Avoid_: Question Form, Survey Component

**Permission Reflection**:
The UX-only display of what the current user may do — used to enable/disable controls, hide menu items, and route-guard navigation. **Reflects, never enforces** — a reflected `false` is a hint; the API is the authority and may still 403. Lives in the application/behavior layer (signal stores), not in presentational components.
_Avoid_: Permission Check, Authorization (these imply enforcement)

**Reconcile-on-Connect**:
The `NotificationStore` delivery model (Slice 6). An `EventSource` on `/notifications/stream` carries content-free **sync** pings; each ping (and every connect/reconnect) triggers a pull of the durable rows from `GET /notifications`. The stream never carries payloads — the table is the source of truth, so a dropped/reconnected stream loses nothing. `unreadCount` (computed) drives the header badge.
_Avoid_: Live Feed, Push Notifications (the payload is pulled, not pushed)

*(More terms will land here as code arrives — keep additions opinionated and tight per `docs/agents/domain.md`.)*
