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

  // ---- Slice 2: org configuration ----------------------------------------

  listRoles(): Promise<Role[]> {
    return firstValueFrom(this.http.get<Role[]>('/roles'));
  }
  createRole(name: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>('/roles', { name }));
  }
  updateRole(id: string, name: string): Promise<Role> {
    return firstValueFrom(this.http.patch<Role>(`/roles/${id}`, { name }));
  }
  retireRole(id: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>(`/roles/${id}/retire`, {}));
  }
  reviveRole(id: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>(`/roles/${id}/revive`, {}));
  }

  listDivisions(): Promise<Division[]> {
    return firstValueFrom(this.http.get<Division[]>('/divisions'));
  }
  createDivision(body: Partial<Division> & { name: string }): Promise<Division> {
    return firstValueFrom(this.http.post<Division>('/divisions', body));
  }
  updateDivision(id: string, body: Partial<Division>): Promise<Division> {
    return firstValueFrom(this.http.patch<Division>(`/divisions/${id}`, body));
  }
  retireDivision(id: string): Promise<Division> {
    return firstValueFrom(this.http.post<Division>(`/divisions/${id}/retire`, {}));
  }
  reviveDivision(id: string): Promise<Division> {
    return firstValueFrom(this.http.post<Division>(`/divisions/${id}/revive`, {}));
  }

  listTeams(): Promise<Team[]> {
    return firstValueFrom(this.http.get<Team[]>('/teams'));
  }
  createTeam(body: { name: string; restrictClaims?: boolean }): Promise<Team> {
    return firstValueFrom(this.http.post<Team>('/teams', body));
  }
  updateTeam(id: string, body: Partial<Team>): Promise<Team> {
    return firstValueFrom(this.http.patch<Team>(`/teams/${id}`, body));
  }
  retireTeam(id: string): Promise<Team> {
    return firstValueFrom(this.http.post<Team>(`/teams/${id}/retire`, {}));
  }
  reviveTeam(id: string): Promise<Team> {
    return firstValueFrom(this.http.post<Team>(`/teams/${id}/revive`, {}));
  }

  listActions(): Promise<{ actions: string[] }> {
    return firstValueFrom(this.http.get<{ actions: string[] }>('/actions'));
  }
  listGrants(): Promise<Grant[]> {
    return firstValueFrom(this.http.get<Grant[]>('/grants'));
  }
  createGrant(body: {
    roleId: string;
    action: string;
    scopeKind: ScopeKind;
    scopeDivisionId?: string;
    scopeTeamId?: string;
    scopeRoleId?: string;
  }): Promise<Grant> {
    return firstValueFrom(this.http.post<Grant>('/grants', body));
  }
  retireGrant(id: string): Promise<Grant> {
    return firstValueFrom(this.http.post<Grant>(`/grants/${id}/retire`, {}));
  }

  listUsers(): Promise<AdminUser[]> {
    return firstValueFrom(this.http.get<AdminUser[]>('/users'));
  }
  grantUserRole(userId: string, roleId: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/users/${userId}/roles`, { roleId }),
    );
  }
  revokeUserRole(userId: string, roleId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/users/${userId}/roles/${roleId}`));
  }
  deactivateUser(userId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/users/${userId}/deactivate`, {}));
  }
  reactivateUser(userId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/users/${userId}/reactivate`, {}));
  }

  getConfig(): Promise<OrgSettings> {
    return firstValueFrom(this.http.get<OrgSettings>('/config'));
  }
  updateConfig(body: Partial<OrgSettings>): Promise<OrgSettings> {
    return firstValueFrom(this.http.patch<OrgSettings>('/config', body));
  }
}
