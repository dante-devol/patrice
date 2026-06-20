import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { CurrentUser } from './api.types';

/**
 * Signal store holding the current user (the web tier's identity reflection).
 * Permissions are reflected for UX only — the API re-authorizes every action.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(ApiService);

  private readonly _user = signal<CurrentUser | null>(null);
  private readonly _loaded = signal(false);

  readonly user = this._user.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  /** Reflected capability for `invite:create`, sourced from the API. UX hint only —
   *  the API is the authority and may still 403. */
  readonly canInvite = computed(() => this._user()?.capabilities?.inviteCreate === true);

  /** Load /me once (e.g. on app start / guard). Swallows 401 into a null user. */
  async ensureLoaded(): Promise<void> {
    if (this._loaded()) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this._user.set(await this.api.me());
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
    await this.api.logout().catch(() => undefined);
    this._user.set(null);
  }
}
