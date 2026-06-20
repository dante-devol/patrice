import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { LookupStore } from '../../core/lookup.store';
import { Questionnaire, Task } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { MessageThreadComponent } from './message-thread.component';

/**
 * Task detail (Slice 4): header (division/team/status/requester/openings), editable
 * metadata, the questionnaire shown read-only (answering arrives in Slice 5), the
 * claim/leave/close/add-opening + change-requester controls (which the API
 * re-authorizes — non-permitted actions surface a 403), and the message thread.
 */
@Component({
  selector: 'task-detail',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, MessageThreadComponent],
  template: `
    <div class="panel">
      <a routerLink="/tasks">← All tasks</a>
      @if (error()) { <p class="error">{{ error() }}</p> }
      @if (task(); as t) {
        <div class="row title-row">
          <h2>{{ t.name }}</h2>
          <span class="badge">{{ t.statusCache ?? '—' }}</span>
        </div>
        <dl class="meta">
          <div><dt>Division</dt><dd>{{ lookup.divisionName(t.divisionId) }}</dd></div>
          <div><dt>Team</dt><dd>{{ lookup.teamName(t.teamId) }}</dd></div>
          <div><dt>Requester</dt><dd>{{ lookup.userName(t.requesterUserId) }}</dd></div>
          <div><dt>Openings</dt><dd>{{ t.openings }} @if (t.claimsClosed) { <span class="badge">claims closed</span> }</dd></div>
          <div><dt>Created</dt><dd>{{ t.createdAt | date: 'medium' }}</dd></div>
          <div><dt>State</dt><dd>{{ t.lifecycleState }}</dd></div>
        </dl>
        <div class="desc">{{ t.description || '(no description)' }}</div>

        <div class="actions">
          <button class="secondary" (click)="run(api.claimTask(t.id))">Claim</button>
          <button class="secondary" (click)="run(api.leaveTask(t.id))">Leave</button>
          <button class="secondary" (click)="run(api.manageClaims(t.id, { openingsDelta: 1 }))">+ Opening</button>
          <button class="secondary" (click)="run(api.manageClaims(t.id, { claimsClosed: !t.claimsClosed }))">
            {{ t.claimsClosed ? 'Reopen claims' : 'Close claims' }}
          </button>
          <button class="secondary" (click)="run(api.retireTask(t.id))">Retire task</button>
        </div>

        <div class="row reassign">
          <input [(ngModel)]="newRequesterId" placeholder="New requester user id" />
          <button class="secondary" (click)="reassign(t)" [disabled]="!newRequesterId.trim()">Change requester</button>
        </div>

        <details class="edit">
          <summary>Edit name / description</summary>
          <label>Name</label>
          <input [(ngModel)]="editName" />
          <label>Description</label>
          <textarea rows="3" [(ngModel)]="editDescription"></textarea>
          <button (click)="saveMeta(t)" [disabled]="busy()">Save</button>
        </details>
      } @else if (!error()) {
        <p class="muted">Loading…</p>
      }
    </div>

    @if (questionnaire(); as q) {
      <div class="panel">
        <h3>Questionnaire</h3>
        @for (qn of q.questions; track qn.id ?? $index) {
          <div class="q">
            <span class="badge">{{ qn.type }}</span>
            <span class="prompt">{{ qn.prompt }}</span>
            @if (qn.required) { <span class="req">*</span> }
          </div>
        } @empty { <p class="muted">Coordination-only task (no questions).</p> }
        <p class="muted">Answering arrives in Slice 5.</p>
      </div>
    }

    @if (task(); as t) { <message-thread [taskId]="t.id" /> }
  `,
  styles: [
    `.title-row { justify-content: flex-start; gap: 12px; }
     .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
     .meta dt { color: var(--muted); font-size: 12px; }
     .meta dd { margin: 0; }
     .desc { white-space: pre-wrap; margin: 12px 0; padding: 10px; background: #0d0f14; border-radius: 7px; }
     .actions { display: flex; gap: 8px; flex-wrap: wrap; }
     .reassign { justify-content: flex-start; gap: 8px; margin-top: 10px; }
     .reassign input { width: auto; flex: 1; }
     textarea { width: 100%; padding: 9px 10px; background: #0d0f14; border: 1px solid var(--border); border-radius: 7px; color: var(--text); }
     .q { padding: 6px 0; border-bottom: 1px solid var(--border); }
     .q .prompt { margin-left: 8px; }
     .req { color: var(--danger); margin-left: 4px; }`,
  ],
})
export class TaskDetailComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);
  private readonly route = inject(ActivatedRoute);

  readonly task = signal<Task | null>(null);
  readonly questionnaire = signal<Questionnaire | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  newRequesterId = '';
  editName = '';
  editDescription = '';

  ngOnInit(): void {
    void this.lookup.ensureLoaded();
    const id = this.route.snapshot.paramMap.get('id')!;
    void this.load(id);
  }

  private async load(id: string): Promise<void> {
    this.error.set(null);
    try {
      const t = await this.api.getTask(id);
      this.task.set(t);
      this.editName = t.name;
      this.editDescription = t.description;
      this.questionnaire.set(await this.api.getTaskQuestionnaire(id));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** Run a task mutation, then refresh the header from the returned task. */
  async run(p: Promise<Task>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.task.set(await p);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async reassign(t: Task): Promise<void> {
    await this.run(this.api.changeRequester(t.id, this.newRequesterId.trim()));
    this.newRequesterId = '';
  }

  async saveMeta(t: Task): Promise<void> {
    await this.run(
      this.api.updateTask(t.id, { name: this.editName, description: this.editDescription }),
    );
  }
}
