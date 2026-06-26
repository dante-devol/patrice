import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { LookupStore } from '../../core/lookup.store';
import { ActivityFilters, ActivityItem, AdminUser } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** A filterable category → verb-prefix (matches `verb LIKE 'prefix%'` server-side). */
const CATEGORIES: { label: string; prefix: string }[] = [
  { label: 'All activity', prefix: '' },
  { label: 'Tasks', prefix: 'task' },
  { label: 'Messages', prefix: 'message' },
  { label: 'Submissions', prefix: 'submission' },
  { label: 'Attachments', prefix: 'attachment' },
  { label: 'Users & roles', prefix: 'user' },
  { label: 'Roles', prefix: 'role' },
  { label: 'Permissions (grants)', prefix: 'grant' },
  { label: 'Divisions', prefix: 'division' },
  { label: 'Teams', prefix: 'team' },
  { label: 'Invitations', prefix: 'invite' },
  { label: 'Questionnaires', prefix: 'questionnaire' },
  { label: 'Configuration', prefix: 'config' },
  { label: 'Integrations (Discord)', prefix: 'integration' },
  { label: 'Account links & mappings', prefix: 'external' },
  { label: 'Discord sign-in', prefix: 'auth' },
  { label: 'Garbage collection', prefix: 'gc' },
  { label: 'Bootstrap', prefix: 'bootstrap' },
  { label: 'Security (admin guard)', prefix: 'last_admin' },
];

/** Human-readable label per verb; unknown verbs fall back to a prettified string. */
const VERB_LABELS: Record<string, string> = {
  'task.created': 'created a task',
  'task.updated': 'edited a task',
  'task.retired': 'retired a task',
  'task.revived': 'revived a task',
  'task.claimed': 'claimed a task',
  'task.left': 'left a task',
  'task.claims_updated': 'updated claim openings',
  'task.requester_changed': 'changed the requester',
  'task.completed': 'completed a task',
  'task_questionnaire.updated': 'edited a task questionnaire',
  'message.created': 'posted a comment',
  'message.updated': 'edited a comment',
  'message.retired': 'removed a comment',
  'message.revived': 'restored a comment',
  'attachment.created': 'uploaded an attachment',
  'attachment.retired': 'removed an attachment',
  'attachment.revived': 'restored an attachment',
  'submission.submitted': 'submitted work',
  'submission.reviewed': 'reviewed a submission',
  'submission.retired': 'retired a submission',
  'user.registered': 'registered',
  'user.updated': 'updated a user',
  'user.deactivated': 'deactivated a user',
  'user.reactivated': 'reactivated a user',
  'user.retired': 'retired a user',
  'user.revived': 'revived a user',
  'user_role.granted': 'granted a role',
  'user_role.revoked': 'revoked a role',
  'role.created': 'created a role',
  'role.updated': 'edited a role',
  'role.retired': 'retired a role',
  'role.revived': 'revived a role',
  'grant.created': 'added a permission',
  'grant.updated': 'edited a permission',
  'grant.retired': 'removed a permission',
  'grant.revived': 'restored a permission',
  'division.created': 'created a division',
  'division.updated': 'edited a division',
  'division.retired': 'retired a division',
  'division.revived': 'revived a division',
  'team.created': 'created a team',
  'team.updated': 'edited a team',
  'team.retired': 'retired a team',
  'team.revived': 'revived a team',
  'invite.created': 'created an invitation',
  'invite.redeemed': 'redeemed an invitation',
  'invite.revoked': 'revoked an invitation',
  'invite.auto_revoked_on_issuer_retired': 'auto-revoked an invitation',
  'questionnaire.updated': 'edited a division questionnaire',
  'config.updated': 'changed configuration',
  'bootstrap.completed': 'completed bootstrap',
  'last_admin_refused': 'was blocked (last-admin guard)',
  'gc.task_collected': 'garbage-collected a task',
  'gc.role_collected': 'garbage-collected a role',
  'gc.division_collected': 'garbage-collected a division',
  'gc.team_collected': 'garbage-collected a team',
  'gc.user_scrubbed': 'scrubbed a user',
  'gc.user_collected': 'deleted a user',
  'gc.blocked': 'GC blocked (live reference)',
  'gc.blob_reconciled': 'reconciled orphaned blobs',
  // Slice 8 — integrations, links, gateway + sync lifecycle.
  'integration.connected': 'connected an integration',
  'integration.updated': 'updated an integration',
  'integration.retired': 'disconnected an integration',
  'integration.revived': 'reconnected an integration',
  'integration.token_rotated': 'rotated the bot token',
  'integration.synced': 'synced roles',
  'integration.sync_started': 'started a sync',
  'integration.reconcile_scheduled': 'scheduled a reconcile',
  'integration.broken': 'flagged a broken mapping',
  'integration.removed': 'removed a synced role',
  'integration.token_invalid': 'bot token was rejected',
  'integration.mapping_retried': 'retried a broken mapping',
  'integration.gateway_connected': 'Gateway connected',
  'integration.gateway_disconnected': 'Gateway disconnected',
  'integration.gateway_degraded': 'Gateway degraded',
  'external_identity.linked': 'linked a Discord account',
  'external_identity.unlinked': 'unlinked a Discord account',
  'external_group_mapping.created': 'added a role mapping',
  'external_group_mapping.updated': 'edited a role mapping',
  'external_group_mapping.retired': 'removed a role mapping',
  'auth.discord_linked': 'enabled Discord sign-in',
  'auth.discord_unlinked': 'removed Discord sign-in',
};

/** A clickable target derived from an activity row, when one applies. */
interface Target {
  label: string;
  /** Router link as a commands array, or null when the entity has no page. */
  link: string[] | null;
}

/**
 * Org audit log (admin). A filterable, paginated, read-only view over the activity
 * feed. Payloads are IDs-only, so names/links are resolved client-side via the
 * LookupStore (divisions/teams/users) and the payload's task ids (→ task detail).
 */
@Component({
  selector: 'activity-admin',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel">
      <h2>Activity log</h2>
      <p class="muted">The org-wide audit trail — configuration changes, lifecycle events, and security signals.</p>

      <div class="filters">
        <label>
          Category
          <select [(ngModel)]="category" (ngModelChange)="apply()">
            @for (c of categories; track c.prefix) {
              <option [value]="c.prefix">{{ c.label }}</option>
            }
          </select>
        </label>
        <label>
          Actor
          <select [(ngModel)]="actorUserId" (ngModelChange)="apply()">
            <option value="">Anyone</option>
            <option value="__system__">System</option>
            @for (u of users(); track u.id) {
              <option [value]="u.id">{{ u.displayName }}</option>
            }
          </select>
        </label>
        <label>
          Source
          <select [(ngModel)]="source" (ngModelChange)="apply()">
            <option value="">Any source</option>
            <option value="patrice">Patrice</option>
            <option value="integration">Integration</option>
            <option value="system">System</option>
          </select>
        </label>
        <label>
          From
          <input type="date" [(ngModel)]="from" (ngModelChange)="apply()" />
        </label>
        <label>
          To
          <input type="date" [(ngModel)]="to" (ngModelChange)="apply()" />
        </label>
        <button class="secondary" (click)="reset()">Clear</button>
      </div>

      @if (error()) { <p class="error">{{ error() }}</p> }

      <table>
        <thead>
          <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Source</th></tr>
        </thead>
        <tbody>
          @for (a of items(); track a.id) {
            <tr>
              <td class="ts" [title]="a.createdAt">{{ when(a.createdAt) }}</td>
              <td>{{ a.actorName ?? 'System' }}</td>
              <td>
                {{ label(a.verb) }}
                <span class="muted verb">{{ a.verb }}</span>
              </td>
              <td>
                @if (target(a); as t) {
                  @if (t.link) {
                    <a [routerLink]="t.link">{{ t.label }}</a>
                  } @else {
                    {{ t.label }}
                  }
                }
              </td>
              <td><span class="badge">{{ a.source }}</span></td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="muted">No activity matches these filters.</td></tr>
          }
        </tbody>
      </table>

      <div class="more">
        @if (cursor()) {
          <button class="secondary" (click)="loadMore()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        } @else if (items().length > 0) {
          <span class="muted">End of log.</span>
        }
      </div>
    </div>
  `,
  styles: [
    `.filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin-bottom: 1rem; }
     .filters label { display: flex; flex-direction: column; font-size: 0.85rem; gap: 0.25rem; }
     .ts { white-space: nowrap; }
     .verb { font-size: 0.75rem; margin-left: 0.4rem; }
     .more { margin-top: 0.75rem; }`,
  ],
})
export class ActivityAdminComponent {
  private readonly api = inject(ApiService);
  private readonly lookup = inject(LookupStore);

  readonly categories = CATEGORIES;
  readonly items = signal<ActivityItem[]>([]);
  readonly users = signal<AdminUser[]>([]);
  readonly cursor = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Filter model (bound to the controls).
  category = '';
  actorUserId = '';
  source = '';
  from = '';
  to = '';

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    await this.lookup.ensureLoaded();
    this.users.set(await this.api.listUsers(true).catch(() => []));
    await this.apply();
  }

  private filters(): ActivityFilters {
    const f: ActivityFilters = {};
    if (this.category) f.verbPrefix = this.category;
    if (this.actorUserId && this.actorUserId !== '__system__') f.actorUserId = this.actorUserId;
    if (this.source) f.source = this.source as ActivityFilters['source'];
    if (this.from) f.from = new Date(`${this.from}T00:00:00`).toISOString();
    if (this.to) f.to = new Date(`${this.to}T23:59:59`).toISOString();
    return f;
  }

  /** Re-run from the top with the current filters. */
  async apply(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.listActivity(this.filters(), { limit: 50 });
      // The "System" pseudo-filter is applied client-side (actorUserId is null).
      const items =
        this.actorUserId === '__system__'
          ? res.items.filter((a) => a.actorUserId === null)
          : res.items;
      this.items.set(items);
      this.cursor.set(res.nextCursor);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const after = this.cursor();
    if (!after) return;
    this.loading.set(true);
    try {
      const res = await this.api.listActivity(this.filters(), { after, limit: 50 });
      const more =
        this.actorUserId === '__system__'
          ? res.items.filter((a) => a.actorUserId === null)
          : res.items;
      this.items.update((cur) => [...cur, ...more]);
      this.cursor.set(res.nextCursor);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  reset(): void {
    this.category = '';
    this.actorUserId = '';
    this.source = '';
    this.from = '';
    this.to = '';
    void this.apply();
  }

  label(verb: string): string {
    return VERB_LABELS[verb] ?? verb.replace(/[._]/g, ' ');
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /**
   * Derive a human label + a deep link for the row's target. Task-anchored entities
   * (tasks, messages, submissions, attachments) link to the task detail page; config
   * entities resolve to their names via the LookupStore but have no standalone page.
   */
  target(a: ActivityItem): Target {
    const p = a.payload ?? {};
    const taskId =
      (p['taskId'] as string) ?? (a.subjectType === 'task' ? a.subjectId : undefined);
    if (taskId) {
      const what =
        a.subjectType === 'message' || a.verb.startsWith('message')
          ? 'comment'
          : a.subjectType === 'submission' || a.verb.startsWith('submission')
            ? 'submission'
            : a.subjectType === 'attachment' || a.verb.startsWith('attachment')
              ? 'attachment'
              : 'task';
      return { label: `${what} on task ${this.short(taskId)}`, link: ['/tasks', taskId] };
    }

    switch (a.subjectType) {
      case 'division':
        return { label: this.lookup.divisionName(a.subjectId), link: null };
      case 'team':
        return { label: this.lookup.teamName(a.subjectId), link: null };
      case 'user':
        return { label: this.lookup.userName(a.subjectId), link: null };
      default:
        return { label: `${a.subjectType} ${this.short(a.subjectId)}`, link: null };
    }
  }

  private short(id: string): string {
    return id.length > 8 ? `${id.slice(0, 8)}…` : id;
  }
}
