import { AuthApi } from './api/auth.api';
import { firstValueFrom } from 'rxjs';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CurrentUser } from './api.types';

/**
 * Signal store holding the current user (the web tier's identity reflection).
 * Permissions are reflected for UX only — the API re-authorizes every action.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly authApi = inject(AuthApi);

  private readonly _user = signal<CurrentUser | null>(null);
  private readonly _loaded = signal(false);

  readonly user = this._user.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  /** Whether `/me` reports the org-wide `action` as allowed. UX hint only — the API
   *  is the authority and may still 403. */
  can(action: string): boolean {
    return this._user()?.allowedActions.includes(action) === true;
  }

  /** Reflected `invite:create`. */
  readonly canInvite = computed(() => this.can('invite:create'));

  /** Reflected authority gating the admin area (org configuration). */
  readonly canManageOrg = computed(() => this.can('config:update'));

  /** True while `requireDiscordLink` blocks this user's task access. */
  readonly taskAccessBlockedByDiscord = computed(
    () => this._user()?.taskAccessBlockedByDiscord === true,
  );

  /** Load /me once (e.g. on app start / guard). Swallows 401 into a null user. */
  async ensureLoaded(): Promise<void> {
    if (this._loaded()) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this._user.set(await firstValueFrom(this.authApi.me()));
    } catch {
      this._user.set(null);
    } finally {
      this._loaded.set(true);
    }
  }

  setUser(user: CurrentUser): void {
    this._user.set(user);
    this._loaded.set(true);
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.authApi.logout()).catch(() => undefined);
    this._user.set(null);
  }
}
