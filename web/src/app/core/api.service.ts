import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BootstrapStatus,
  CreatedInvitation,
  CurrentUser,
  InvitationListItem,
  InviteView,
} from './api.types';

/**
 * The OpenAPI data layer (hand-written for Slice 1 — see api.types.ts note). All
 * calls are same-origin with credentials; the interceptors attach cookies + CSRF.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  bootstrapStatus(): Promise<BootstrapStatus> {
    return firstValueFrom(this.http.get<BootstrapStatus>('/bootstrap'));
  }

  me(): Promise<CurrentUser> {
    return firstValueFrom(this.http.get<CurrentUser>('/me'));
  }

  login(email: string, password: string): Promise<CurrentUser> {
    return firstValueFrom(
      this.http.post<CurrentUser>('/auth/login', { email, password }),
    );
  }

  logout(): Promise<void> {
    return firstValueFrom(this.http.post<void>('/auth/logout', {}));
  }

  viewInvite(token: string): Promise<InviteView> {
    return firstValueFrom(this.http.get<InviteView>(`/invite/${token}`));
  }

  acceptInvite(
    token: string,
    body: { passcode?: string; email: string; password: string; displayName: string },
  ): Promise<CurrentUser> {
    return firstValueFrom(
      this.http.post<CurrentUser>(`/invite/${token}/accept`, body),
    );
  }

  createInvitation(body: { email?: string }): Promise<CreatedInvitation> {
    return firstValueFrom(this.http.post<CreatedInvitation>('/invitations', body));
  }

  listInvitations(): Promise<InvitationListItem[]> {
    return firstValueFrom(this.http.get<InvitationListItem[]>('/invitations'));
  }

  revokeInvitation(id: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/invitations/${id}/revoke`, {}));
  }

  requestPasswordReset(email: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/auth/password-reset', { email }),
    );
  }

  confirmPasswordReset(token: string, password: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/auth/password-reset/confirm', { token, password }),
    );
  }

  confirmVerification(token: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/auth/verify-email/confirm', { token }),
    );
  }

  resendVerification(email: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/auth/verify-email/resend', { email }),
    );
  }
}
