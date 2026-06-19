# Slice 5 — Submissions & Review Lifecycle

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** Slice 4 (tasks, claimants, messages, attachments) and
Slice 3 (the `validateSubmission` function).*

**Goal.** Complete the work lifecycle: claimants **submit** answers to the task's questionnaire, the
requester **reviews** each submission (approve / return / reject), claimants **resubmit** new
versions, and **task status follows the min-rule** to **Approved** — plus **manual completion**,
**retire-submission**, and the **system messages** that record it all.

**Acceptance demo.**
1. A claimant on a Writing task fills the questionnaire (a Detail-Text answer) and **submits** → their
   submission is **Review**; task status_cache becomes **Review** (single claimant).
2. The requester **returns** it with feedback (a message in that submission's thread) → submission
   **Revising**; status **Revising**.
3. The claimant **resubmits** (a new **version**, referencing the prior; surfaces as a new top-level
   message with its own thread) → **Review** → requester **approves** → submission **Approved**; task
   **Approved**.
4. Multi-claimant Testing task with `openings=3`: three submit; requester approves two and **rejects**
   one (excluded) → task **Approved** (rejected excluded from the min).
5. A requester **manually completes** a task with an outstanding submission → **Approved** (bypass).
6. Editing a task's questionnaire after the first submission is **refused** (locked).

**In scope.** `submission`, `answer` tables; `attachment.answer_id` (resource answers); `task:submit`
(validated), `task:review` (approve/return/reject a submission), `task:complete` (manual),
`task:retire_submission`; **versioned** resubmission; the **status min-rule** (full); the submission
**state-machine guard**; **system messages** for submit/review/complete; the questionnaire
**lock-at-first-submission**.

## Schema (add)
```
submission  id, task_id→task, claimant_user_id→app_user,
            submission_no int,                        -- the resubmission counter (v1, v2, v3); part of identity
            prev_submission_id uuid null,             -- resubmission chain
            state ('review'|'revising'|'approved'|'rejected'),
            submitted_at, reviewed_by uuid null, reviewed_at null,
            lifecycle_state, retired_at,
            version int default 0,                    -- optimistic lock (global convention)
            created_at
            UNIQUE(task_id, claimant_user_id, submission_no)
answer      id, submission_id→submission, question_id→question, value jsonb null, attachment_id uuid null
```
Add FK: `attachment.answer_id → answer(id)`; `message.submission_id → submission(id)`.

**Naming note:** `submission_no` replaces the earlier `version int` field for the resubmission
counter — the column is part of the row's identity and never changes after insert. The separate
`version` column is the **optimistic-lock counter** per the global convention; `task:review`
writes use the version-guarded UPDATE pattern and return `409 STALE_SUBMISSION` on 0 rows.
(Architecture §5.4 is updated to match.)

**Submission Cedar entity** exposes `claimantUserId` as an attribute — used by both the
`own_as_claimant` template (for `task:submit` resubmissions) and the conditional self-review
forbid policy below.

## Submission cycle & status min-rule (the heart of this slice)
- **`task:submit`** (own=claimant): build a `submission` (next `submission_no`, `prev_submission_id`
  = the claimant's prior, if any), with `answer` rows; **validate** via the Slice-3
  `validateSubmission` (reject `422` on failure); set `state='review'`; mark
  `task_claimant.has_submitted=true`; emit a **system message** (`kind='system'`, `submission_id`
  set → its thread is that submission's discussion) "X submitted v{n}". **Lock** the task's
  questionnaire (first submission — enforced by a guard on `task:configure_questionnaire`:
  reject `409` if any non-retired submission exists for the task).
- **`task:review`** (own=requester, or lead/admin scope): `{decision:'approve'|'return'|'reject',
  comment?}` on a submission. `approve→approved`, `return→revising`, `reject→rejected`. Each emits a
  system message **as a reply under the submission's top-level "X submitted v{n}" message**, so
  the requester's review conversation lives in that submission's thread. Resubmit (`task:submit`
  again from `revising`) → new `submission` row with the next `submission_no` → new top-level
  system message → `review`. Write uses the version-guarded UPDATE pattern (`409 STALE_SUBMISSION`
  on 0 rows).
- **`task:retire_submission`** (own = requester per the action→`own` map; **requires a non-empty
  `reason` string, 5..500 chars** — `422` if missing): in one transaction —
  1. Insert a **task-level audit message** (`kind='system'`, `submission_id=NULL`,
     `parent_message_id=NULL`, structured body `{verb:'submission_retired', submissionNo,
     claimantUserId, retiredBy, reason}`). This message survives submission GC.
  2. Soft-retire the submission row (`lifecycle_state='retired'`, `retired_at=now()`).
  3. Soft-retire M1 + every reply with `submission_id = sub.id` (the cascade — these drop from
     default views immediately).
  4. **Revert the claimant slot:** `UPDATE task_claimant SET has_submitted=false WHERE
     task_id=$task AND user_id=$claimant`. The slot becomes claimable again (subject to
     `claims_closed` and `openings`).
  5. Recompute `status_cache`.
  6. Write `activity` `verb='submission.retired'`, `payload={taskId, submissionId,
     claimantUserId, reason}` (the org-level audit, distinct from the task-thread audit
     message).
- **`task:complete`** (own=requester/lead/admin): force task to **Approved** regardless of submission
  states (bypass). Emits a system message; outstanding submissions stay in their current state
  (UI surfaces them as "no longer required").
- **Status min-rule (compute `status_cache`):** each claimant **slot** contributes a status — open
  spot (claims open) ⇒ `open`; claimed-unsubmitted ⇒ `claimed`; submitted ⇒ the submission's `state`;
  **rejected** submissions and **closed-unfilled** spots are **excluded**. Task `status_cache = lowest`
  over the contributing slots, ordering `open < claimed < revising < review < approved`. A task is
  **`approved`** only when **(a)** every counted slot is `approved` **AND (b)** there is at least
  one Approved counted slot. **If the contributing set is empty** (e.g. one slot, single
  submission rejected; or all slots rejected/closed-unfilled), `status_cache = 'claimed'` — the
  requester must act (`task:complete`, `task:retire_submission` to free a slot, add openings via
  `task:manage_claims`, or `task:retire`). Vacuous-truth Approval is explicitly excluded.
  Recompute on every submit/review/claim/leave/close/retire_submission.
- **Two gates per transition:** Cedar (*who*) + a **state-machine guard** (is the transition valid from
  the submission's current `state`) — reject `409` on an invalid transition. Once `state`
  transitions out of `review` it is terminal for that submission row; further iteration creates a
  new submission row with a new `submission_no`.
- **Self-review:** enforced **in Cedar**, not as an app-level check. When
  `organization.settings.selfReviewAllowed = false`, the projector emits a conditional static
  forbid: `forbid(principal, action == Action::"task:review", resource) when {
  resource.claimantUserId == principal.id };`. Toggling the flag patches the policy set and bumps
  `config_version` (Slice 2's settings endpoint).

## API endpoints
```
POST  /tasks/:id/submissions               (task:submit, own)        {answers:[{questionId, value?, attachmentId?}]}
GET   /tasks/:id/submissions               -- list (claimant's own + requester/leads see all)
GET   /submissions/:id                     -- with answers + its thread
POST  /submissions/:id/review              (task:review)             {decision, comment?}
POST  /submissions/:id/retire              (task:retire_submission)  {reason: string (5..500)}   -- 422 if reason missing/short
POST  /tasks/:id/complete                  (task:complete)           -- manual approve
```

## Web (Angular)
- **Answer mode** of the questionnaire renderer (Slice 3) for claimants on the task detail page →
  submit. Show the claimant's current submission + version history.
- **Reviewer panel** for the requester: each submission with its answers (text rendered, files
  downloadable) + approve/return/reject controls + the per-submission thread.
- Task header status reflects the min-rule live.

## Tests
- Single-claimant full cycle: submit→return→resubmit(v2)→approve; status tracks the submission.
- Validation: required-missing / out-of-range / wrong-attachment-type submission → 422.
- Multi-claimant min-rule: {approved,approved,revising} ⇒ task `revising`; reject excludes; all-approved ⇒ `approved`.
- Manual complete bypasses outstanding submissions.
- Questionnaire **locked** after first submission (edit → 409/refused).
- Invalid state transition (review an already-approved submission) → 409.
- Self-review honored per `selfReviewAllowed`.

**Done when** the demo passes — the complete request→claim→submit→review→approve lifecycle works for
single- and multi-claimant tasks.
