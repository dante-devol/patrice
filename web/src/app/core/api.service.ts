import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AdminUser,
  BootstrapStatus,
  CreatedInvitation,
  CurrentUser,
  Division,
  Grant,
  InvitationListItem,
  InviteView,
  OrgSettings,
  Role,
  ScopeKind,
  Team,
} from './api.types';

/**
 * The OpenAPI data layer (hand-written for Slice 1 — see api.types.ts note). All
 * calls are same-origin with credentials; the interceptors attach cookies + CSRF.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  bootstrapStatus(): Promise<BootstrapStatus> {
    return firstValueFrom(this.http.get<BootstrapStatus>('/api/bootstrap'));
  }

  me(): Promise<CurrentUser> {
    return firstValueFrom(this.http.get<CurrentUser>('/api/me'));
  }

  login(email: string, password: string): Promise<CurrentUser> {
    return firstValueFrom(
      this.http.post<CurrentUser>('/api/auth/login', { email, password }),
    );
  }

  logout(): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/auth/logout', {}));
  }

  viewInvite(token: string): Promise<InviteView> {
    return firstValueFrom(this.http.get<InviteView>(`/api/invite/${token}`));
  }

  acceptInvite(
    token: string,
    body: { passcode?: string; email: string; password: string; displayName: string },
  ): Promise<CurrentUser> {
    return firstValueFrom(
      this.http.post<CurrentUser>(`/api/invite/${token}/accept`, body),
    );
  }

  createInvitation(body: { email?: string }): Promise<CreatedInvitation> {
    return firstValueFrom(this.http.post<CreatedInvitation>('/api/invitations', body));
  }

  listInvitations(): Promise<InvitationListItem[]> {
    return firstValueFrom(this.http.get<InvitationListItem[]>('/api/invitations'));
  }

  revokeInvitation(id: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/invitations/${id}/revoke`, {}));
  }

  requestPasswordReset(email: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/password-reset', { email }),
    );
  }

  confirmPasswordReset(token: string, password: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/password-reset/confirm', { token, password }),
    );
  }

  confirmVerification(token: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/verify-email/confirm', { token }),
    );
  }

  resendVerification(email: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/verify-email/resend', { email }),
    );
  }

  // ---- Slice 2: org configuration ----------------------------------------

  listRoles(): Promise<Role[]> {
    return firstValueFrom(this.http.get<Role[]>('/api/roles'));
  }
  createRole(name: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>('/api/roles', { name }));
  }
  updateRole(id: string, name: string): Promise<Role> {
    return firstValueFrom(this.http.patch<Role>(`/api/roles/${id}`, { name }));
  }
  retireRole(id: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>(`/api/roles/${id}/retire`, {}));
  }
  reviveRole(id: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>(`/api/roles/${id}/revive`, {}));
  }

  listDivisions(): Promise<Division[]> {
    return firstValueFrom(this.http.get<Division[]>('/api/divisions'));
  }
  createDivision(body: Partial<Division> & { name: string }): Promise<Division> {
    return firstValueFrom(this.http.post<Division>('/api/divisions', body));
  }
  updateDivision(id: string, body: Partial<Division>): Promise<Division> {
    return firstValueFrom(this.http.patch<Division>(`/api/divisions/${id}`, body));
  }
  retireDivision(id: string): Promise<Division> {
    return firstValueFrom(this.http.post<Division>(`/api/divisions/${id}/retire`, {}));
  }
  reviveDivision(id: string): Promise<Division> {
    return firstValueFrom(this.http.post<Division>(`/api/divisions/${id}/revive`, {}));
  }

  listTeams(): Promise<Team[]> {
    return firstValueFrom(this.http.get<Team[]>('/api/teams'));
  }
  createTeam(body: { name: string; restrictClaims?: boolean }): Promise<Team> {
    return firstValueFrom(this.http.post<Team>('/api/teams', body));
  }
  updateTeam(id: string, body: Partial<Team>): Promise<Team> {
    return firstValueFrom(this.http.patch<Team>(`/api/teams/${id}`, body));
  }
  retireTeam(id: string): Promise<Team> {
    return firstValueFrom(this.http.post<Team>(`/api/teams/${id}/retire`, {}));
  }
  reviveTeam(id: string): Promise<Team> {
    return firstValueFrom(this.http.post<Team>(`/api/teams/${id}/revive`, {}));
  }

  listActions(): Promise<{ actions: string[] }> {
    return firstValueFrom(this.http.get<{ actions: string[] }>('/api/actions'));
  }
  listGrants(): Promise<Grant[]> {
    return firstValueFrom(this.http.get<Grant[]>('/api/grants'));
  }
  createGrant(body: {
    roleId: string;
    action: string;
    scopeKind: ScopeKind;
    scopeDivisionId?: string;
    scopeTeamId?: string;
    scopeRoleId?: string;
  }): Promise<Grant> {
    return firstValueFrom(this.http.post<Grant>('/api/grants', body));
  }
  retireGrant(id: string): Promise<Grant> {
    return firstValueFrom(this.http.post<Grant>(`/api/grants/${id}/retire`, {}));
  }

  listUsers(): Promise<AdminUser[]> {
    return firstValueFrom(this.http.get<AdminUser[]>('/api/users'));
  }
  grantUserRole(userId: string, roleId: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/api/users/${userId}/roles`, { roleId }),
    );
  }
  revokeUserRole(userId: string, roleId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/users/${userId}/roles/${roleId}`));
  }
  deactivateUser(userId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/users/${userId}/deactivate`, {}));
  }
  reactivateUser(userId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/users/${userId}/reactivate`, {}));
  }

  getConfig(): Promise<OrgSettings> {
    return firstValueFrom(this.http.get<OrgSettings>('/api/config'));
  }
  updateConfig(body: Partial<OrgSettings>): Promise<OrgSettings> {
    return firstValueFrom(this.http.patch<OrgSettings>('/api/config', body));
  }
}
