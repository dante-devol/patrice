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
      .notif-btn { background: none; border: 0; cursor: pointer; font-size: 1.2rem; position: relative; }
      .notif-badge {
        position: absolute; top: -4px; right: -6px; background: #d33; color: #fff;
        border-radius: 999px; font-size: 0.7rem; padding: 0 5px; line-height: 1.4;
      }
      .notif-panel {
        position: absolute; right: 0; top: 2rem; width: 320px; max-height: 420px;
        overflow-y: auto; background: #fff; border: 1px solid #ccc; border-radius: 6px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.15); z-index: 50;
      }
      .notif-panel header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee;
      }
      .notif-panel ul { list-style: none; margin: 0; padding: 0; }
      .notif-panel li {
        display: flex; justify-content: space-between; gap: 0.5rem; cursor: pointer;
        padding: 0.5rem 0.75rem; border-bottom: 1px solid #f2f2f2;
      }
      .notif-panel li.unread { background: #f4f8ff; font-weight: 600; }
      .notif-panel li:hover { background: #eef; }
      .notif-panel time { color: #888; font-size: 0.75rem; white-space: nowrap; }
      .notif-empty { padding: 1rem 0.75rem; }
      .link { background: none; border: 0; color: #06c; cursor: pointer; font-size: 0.8rem; }
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
      default:
        return n.type;
    }
  }
}
