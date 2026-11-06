import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminApi } from './api/org.api';
import { AdminPresence } from './api.types';
import { AdminPresenceStore, EDITING_TTL_MS } from './admin-presence.store';

const ev = (over: Partial<AdminPresence> = {}): AdminPresence => ({
  page: 'permissions',
  userId: 'u-sam',
  displayName: 'Sam',
  state: 'editing',
  at: '2026-11-06T00:00:00.000Z',
  ...over,
});

describe('AdminPresenceStore', () => {
  let store: AdminPresenceStore;
  let api: { announcePresence: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    api = { announcePresence: jest.fn().mockReturnValue(of(undefined)) };
    TestBed.configureTestingModule({ providers: [{ provide: AdminApi, useValue: api }] });
    store = TestBed.inject(AdminPresenceStore);
  });

  afterEach(() => jest.useRealTimers());

  it('lists who is editing a page, and only that page', () => {
    store.receive(ev());
    store.receive(ev({ userId: 'u-kim', displayName: 'Kim', page: 'users' }));
    expect(store.forPage()('permissions').editing.map((e) => e.displayName)).toEqual(['Sam']);
    expect(store.forPage()('users').editing.map((e) => e.displayName)).toEqual(['Kim']);
  });

  it('replaces a person’s entry, and clears it on idle', () => {
    store.receive(ev());
    store.receive(ev({ state: 'saved' }));
    expect(store.forPage()('permissions')).toEqual({ editing: [], saved: [expect.objectContaining({ userId: 'u-sam' })] });
    store.receive(ev({ state: 'idle' }));
    expect(store.forPage()('permissions')).toEqual({ editing: [], saved: [] });
  });

  it('ages out an editing entry whose heartbeat stopped', () => {
    store.receive(ev());
    jest.advanceTimersByTime(EDITING_TTL_MS + 5_000);
    expect(store.forPage()('permissions').editing).toEqual([]);
  });

  it('clearSaved drops the saved notices for a page', () => {
    store.receive(ev({ state: 'saved' }));
    store.clearSaved('permissions');
    expect(store.forPage()('permissions').saved).toEqual([]);
  });

  it('reports through the API and swallows a failure', async () => {
    await store.report('settings', 'editing');
    expect(api.announcePresence).toHaveBeenCalledWith('settings', 'editing');
    api.announcePresence.mockReturnValue(throwError(() => new Error('offline')));
    await expect(store.report('settings', 'idle')).resolves.toBeUndefined();
  });
});
