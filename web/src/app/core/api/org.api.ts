import { Injectable, inject } from '@angular/core';
import { ApiClient, RequestBody } from './client';

const retired = (includeRetired: boolean) => (includeRetired ? { include: 'retired' as const } : undefined);

/** Roles, divisions, teams and their memberships. */
@Injectable({ providedIn: 'root' })
export class OrgApi {
  private readonly api = inject(ApiClient);

  // ---- Roles
  listRoles(includeRetired = false) {
    return this.api.get('/roles', { query: retired(includeRetired) });
  }
  createRole(name: string) {
    return this.api.post('/roles', { name });
  }
  updateRole(id: string, body: RequestBody<'/roles/{id}', 'patch'>) {
    return this.api.patch('/roles/{id}', body, { path: { id } });
  }
  retireRole(id: string) {
    return this.api.post('/roles/{id}/retire', undefined, { path: { id } });
  }
  reviveRole(id: string) {
    return this.api.post('/roles/{id}/revive', undefined, { path: { id } });
  }

  // ---- Divisions
  listDivisions(includeRetired = false) {
    return this.api.get('/divisions', { query: retired(includeRetired) });
  }
  createDivision(body: RequestBody<'/divisions', 'post'>) {
    return this.api.post('/divisions', body);
  }
  updateDivision(id: string, body: RequestBody<'/divisions/{id}', 'patch'>) {
    return this.api.patch('/divisions/{id}', body, { path: { id } });
  }
  retireDivision(id: string) {
    return this.api.post('/divisions/{id}/retire', undefined, { path: { id } });
  }
  reviveDivision(id: string) {
    return this.api.post('/divisions/{id}/revive', undefined, { path: { id } });
  }
  listDivisionMembers(id: string) {
    return this.api.get('/divisions/{id}/members', { path: { id } });
  }
  addDivisionMember(id: string, userId: string) {
    return this.api.post('/divisions/{id}/members', { userId }, { path: { id } });
  }
  removeDivisionMember(id: string, userId: string) {
    return this.api.delete('/divisions/{id}/members/{userId}', { path: { id, userId } });
  }

  // ---- Teams
  listTeams(includeRetired = false) {
    return this.api.get('/teams', { query: retired(includeRetired) });
  }
  createTeam(body: RequestBody<'/teams', 'post'>) {
    return this.api.post('/teams', body);
  }
  updateTeam(id: string, body: RequestBody<'/teams/{id}', 'patch'>) {
    return this.api.patch('/teams/{id}', body, { path: { id } });
  }
  retireTeam(id: string) {
    return this.api.post('/teams/{id}/retire', undefined, { path: { id } });
  }
  reviveTeam(id: string) {
    return this.api.post('/teams/{id}/revive', undefined, { path: { id } });
  }
  listTeamMembers(id: string) {
    return this.api.get('/teams/{id}/members', { path: { id } });
  }
  addTeamMember(id: string, userId: string) {
    return this.api.post('/teams/{id}/members', { userId }, { path: { id } });
  }
  removeTeamMember(id: string, userId: string) {
    return this.api.delete('/teams/{id}/members/{userId}', { path: { id, userId } });
  }
}

/** Users and the permission matrix. */
@Injectable({ providedIn: 'root' })
export class AccessApi {
  private readonly api = inject(ApiClient);

  listActions() {
    return this.api.get('/actions');
  }
  /** Apply the permission editor's staged changes all-or-nothing; returns every grant. */
  saveGrants(changes: RequestBody<'/grants/batch', 'post'>['changes']) {
    return this.api.post('/grants/batch', { changes });
  }
  listGrants() {
    return this.api.get('/grants');
  }
  createGrant(body: RequestBody<'/grants', 'post'>) {
    return this.api.post('/grants', body);
  }
  /** Grants are deleted outright (audited); there is no revive. */
  deleteGrant(id: string) {
    return this.api.delete('/grants/{id}', { path: { id } });
  }

  listUsers(includeRetired = false) {
    return this.api.get('/users', { query: retired(includeRetired) });
  }
  grantUserRole(userId: string, roleId: string) {
    return this.api.post('/users/{id}/roles', { roleId }, { path: { id: userId } });
  }
  revokeUserRole(userId: string, roleId: string) {
    return this.api.delete('/users/{id}/roles/{roleId}', { path: { id: userId, roleId } });
  }
  deactivateUser(id: string) {
    return this.api.post('/users/{id}/deactivate', undefined, { path: { id } });
  }
  reactivateUser(id: string) {
    return this.api.post('/users/{id}/reactivate', undefined, { path: { id } });
  }
  retireUser(id: string) {
    return this.api.post('/users/{id}/retire', undefined, { path: { id } });
  }
  reviveUser(id: string) {
    return this.api.post('/users/{id}/revive', undefined, { path: { id } });
  }
}

/** Org settings, invitations, the audit feed and background-job health. */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly api = inject(ApiClient);

  getConfig() {
    return this.api.get('/config');
  }
  updateConfig(body: RequestBody<'/config', 'patch'>) {
    return this.api.patch('/config', body);
  }
  createInvitation(body: RequestBody<'/invitations', 'post'>) {
    return this.api.post('/invitations', body);
  }
  listInvitations() {
    return this.api.get('/invitations');
  }
  revokeInvitation(id: string) {
    return this.api.post('/invitations/{id}/revoke', undefined, { path: { id } });
  }
  /** The org audit feed, newest first; `filters` AND-compose server-side. */
  listActivity(filters: object = {}, opts: { after?: string; limit?: number } = {}) {
    return this.api.get('/activity', { query: { ...filters, ...opts } as never });
  }
  listDeadLetters() {
    return this.api.get('/jobs/dead-letters');
  }
}
