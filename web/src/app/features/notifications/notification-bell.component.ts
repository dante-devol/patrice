import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { NotificationStore } from '../../core/notification.store';
import { LookupStore } from '../../core/lookup.store';
import { Notification } from '../../core/api.types';

/**
 * Header notification bell (Slice 6 web). Shows the live unread badge from
 * {@link NotificationStore} and a dropdown feed; clicking an item marks it read and
 * navigates to its task. Labels join ids to names via {@link LookupStore} — the
 * payload itself is IDs-only (no PII rides the wire).
 */
@Component({
  selector: 'app-notification-bell',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="notif">
      <button
        class="notif-btn"
        type="button"
        (click)="toggle()"
        [attr.aria-label]="'Notifications: ' + store.unreadCount() + ' unread'"
      >
        🔔
        @if (store.hasUnread()) {
          <span class="notif-badge">{{ store.unreadCount() }}</span>
        }
      </button>

      @if (open()) {
        <div class="notif-panel">
          <header>
            <strong>Notifications</strong>
            @if (store.hasUnread()) {
              <button class="link" type="button" (click)="markAll()">
                Mark all read
              </button>
            }
          </header>
          @if (store.feed().length === 0) {
            <p class="muted notif-empty">You're all caught up.</p>
          } @else {
            <ul>
              @for (n of store.feed(); track n.id) {
                <li
                  [class.unread]="n.readAt === null"
                  (click)="openItem(n)"
                >
                  <span class="notif-text">{{ label(n) }}</span>
                  <time>{{ n.createdAt | date: 'short' }}</time>
                </li>
              }
            </ul>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .notif { position: relative; display: inline-block; }
      .notif-btn { background: none; border: 0; cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 4px; position: relative; }
      .notif-badge {
        position: absolute; top: -2px; right: -2px; background: #99492f; color: #fbfbf8;
        border-radius: 999px; font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem;
        padding: 0 5px; line-height: 1.5;
      }
      .notif-panel {
        position: absolute; right: 0; top: 2.4rem; width: 320px; max-height: 420px;
        overflow-y: auto; background: #fbfbf8; border: 1px solid #d3d5cc; border-radius: 10px;
        box-shadow: 0 10px 30px -10px rgba(25,27,25,0.25); z-index: 50;
      }
      .notif-panel header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.6rem 0.8rem; border-bottom: 1px solid #d3d5cc;
      }
      .notif-panel header strong { font-family: 'IBM Plex Serif', Georgia, serif; }
      .notif-panel ul { list-style: none; margin: 0; padding: 0; }
      .notif-panel li {
        display: flex; justify-content: space-between; gap: 0.5rem; cursor: pointer;
        padding: 0.55rem 0.8rem; border-bottom: 1px solid #e7e8e1;
      }
      .notif-panel li.unread { background: rgba(15,122,107,0.06); font-weight: 600; }
      .notif-panel li:hover { background: #e7e8e1; }
      .notif-text { font-size: 0.82rem; }
      .notif-panel time { color: #5b605c; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; white-space: nowrap; }
      .notif-empty { padding: 1rem 0.8rem; }
      .link { background: none; border: 0; color: #0a5249; cursor: pointer; font-size: 0.78rem; }
    `,
  ],
})
export class NotificationBellComponent {
  readonly store = inject(NotificationStore);
  private readonly lookup = inject(LookupStore);
  private readonly router = inject(Router);

  readonly open = signal(false);

  constructor() {
    void this.lookup.ensureLoaded();
  }

  toggle(): void {
    this.open.update((v) => !v);
  }

  async markAll(): Promise<void> {
    await this.store.markAllRead();
  }

  async openItem(n: Notification): Promise<void> {
    if (n.readAt === null) await this.store.markRead(n.id);
    this.open.set(false);
    const taskId = (n.payload as { taskId?: string }).taskId;
    if (taskId) void this.router.navigate(['/tasks', taskId]);
    else if (n.type === 'integration.push_failed') void this.router.navigate(['/admin']);
  }

  /** A human label for a notification, joining the actor id to a name where present. */
  label(n: Notification): string {
    const actorId = (n.payload as { actorUserId?: string }).actorUserId ?? null;
    const actor = this.lookup.userName(actorId);
    switch (n.type) {
      case 'task.submitted':
        return `${actor} submitted work for review`;
      case 'task.reviewed_approved':
        return 'Your submission was approved';
      case 'task.reviewed_returned':
        return 'Your submission was returned for revision';
      case 'task.reviewed_rejected':
        return 'Your submission was rejected';
      case 'task.completed':
        return 'A task you worked on was completed';
      case 'task.requester_changed':
        return 'A task’s requester changed';
      case 'task.claim_joined':
        return `${actor} claimed your task`;
      case 'task.claim_left':
        return `${actor} left your task`;
      case 'task.claims_closed':
        return 'Claims were closed on a task';
      case 'task.retired':
        return 'A task you claimed was retired';
      case 'message.posted':
        return `${actor} commented on a task`;
      case 'message.replied':
        return `${actor} replied to a thread`;
      case 'message.submission_thread_replied':
        return `${actor} replied on a submission`;
      case 'integration.push_failed': {
        const reason = (n.payload as { reason?: string }).reason;
        if (reason === 'permission')
          return 'Discord roles need attention — the bot can’t change roles. Check its permissions in your server.';
        if (reason === 'not_found')
          return 'Discord roles need attention — a mapped role no longer exists on your server.';
        return 'Discord roles need attention — a role change was refused.';
      }
      default:
        return n.type;
    }
  }
}
