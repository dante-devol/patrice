import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';
import { AuthStore } from './auth.store';
import { Notification } from './api.types';
import { NotificationStore } from './notification.store';

function notif(id: string, readAt: string | null = null): Notification {
  return {
    id,
    type: 'task.submitted',
    subjectType: 'task',
    subjectId: 't1',
    payload: {},
    readAt,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('NotificationStore', () => {
  let store: NotificationStore;
  let api: {
    notificationStreamUrl: string;
    listNotifications: jest.Mock;
    markNotificationRead: jest.Mock;
    markAllNotificationsRead: jest.Mock;
  };

  beforeEach(() => {
    api = {
      notificationStreamUrl: '/api/notifications/stream',
      listNotifications: jest.fn(),
      markNotificationRead: jest.fn(),
      markAllNotificationsRead: jest.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        NotificationStore,
        { provide: ApiService, useValue: api },
        // Unauthenticated → the SSE stream stays closed; we drive reconcile directly.
        { provide: AuthStore, useValue: { isAuthenticated: signal(false) } },
      ],
    });
    store = TestBed.inject(NotificationStore);
  });

  it('reconcile pulls the durable feed + unread count from the table', async () => {
    api.listNotifications.mockResolvedValue({
      items: [notif('a'), notif('b', '2026-01-02T00:00:00.000Z')],
      unreadCount: 1,
      nextCursor: null,
    });

    await store.reconcile();

    expect(api.listNotifications).toHaveBeenCalledWith({ limit: 50 });
    expect(store.feed().map((n) => n.id)).toEqual(['a', 'b']);
    expect(store.unreadCount()).toBe(1);
    expect(store.hasUnread()).toBe(true);
  });

  it('reconcile swallows a transient pull failure, keeping last-known state', async () => {
    api.listNotifications.mockResolvedValueOnce({
      items: [notif('a')],
      unreadCount: 1,
      nextCursor: null,
    });
    await store.reconcile();

    api.listNotifications.mockRejectedValueOnce(new Error('network'));
    await expect(store.reconcile()).resolves.toBeUndefined();
    expect(store.feed().map((n) => n.id)).toEqual(['a']); // unchanged
  });

  it('markRead flips only the matching unread row and updates the count', async () => {
    api.listNotifications.mockResolvedValue({
      items: [notif('a'), notif('b')],
      unreadCount: 2,
      nextCursor: null,
    });
    await store.reconcile();

    api.markNotificationRead.mockResolvedValue({ unreadCount: 1 });
    await store.markRead('a');

    expect(store.unreadCount()).toBe(1);
    expect(store.feed().find((n) => n.id === 'a')!.readAt).not.toBeNull();
    expect(store.feed().find((n) => n.id === 'b')!.readAt).toBeNull();
  });

  it('markAllRead clears unread across the feed', async () => {
    api.listNotifications.mockResolvedValue({
      items: [notif('a'), notif('b')],
      unreadCount: 2,
      nextCursor: null,
    });
    await store.reconcile();

    api.markAllNotificationsRead.mockResolvedValue({ unreadCount: 0 });
    await store.markAllRead();

    expect(store.unreadCount()).toBe(0);
    expect(store.feed().every((n) => n.readAt !== null)).toBe(true);
    expect(store.hasUnread()).toBe(false);
  });
});
