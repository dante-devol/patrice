import { Injectable, inject } from '@angular/core';
import { ApiClient, RequestBody } from './client';

export type UnitKind = 'division' | 'team';

const retired = (includeRetired: boolean) => (includeRetired ? { include: 'retired' as const } : undefined);

/** Roles, divisions, teams and their memberships. */
@Injectable({ providedIn: 'root' })
export class OrgApi {
  private readonly api = inject(ApiClient);

  // ---- Roles
  listRoles(includeRetired = false) {
    return this.api.get('/roles', { query: retired(includeRetired) });
  }
  createRole(name: string, kind: 'org' | 'unit' = 'org', assignableByLeads?: boolean) {
    return this.api.post('/roles', { name, kind, ...(kind === 'unit' && assignableByLeads ? { assignableByLeads } : {}) });
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

  // ---- Memberships (every unit at once, for the membership editor)
  listMemberships() {
    return this.api.get('/memberships');
  }
  /** Apply the membership editor's staged changes all-or-nothing; returns every membership. */
  saveMemberships(changes: RequestBody<'/memberships/batch', 'post'>['changes']) {
    return this.api.post('/memberships/batch', { changes });
  }

  /** The divisions and teams the caller belongs to or leads. */
  myUnits() {
    return this.api.get('/me/units');
  }

  // ---- Unit roles and stats, by unit kind (the division and team pages)
  listRoleAssignments(kind: UnitKind, id: string) {
    return kind === 'division'
      ? this.api.get('/divisions/{id}/role-assignments', { path: { id } })
      : this.api.get('/teams/{id}/role-assignments', { path: { id } });
  }
  /** The unit roles the caller may assign there; empty means no leadership controls. */
  assignableRoles(kind: UnitKind, id: string) {
    return kind === 'division'
      ? this.api.get('/divisions/{id}/assignable-roles', { path: { id } })
      : this.api.get('/teams/{id}/assignable-roles', { path: { id } });
  }
  assignRole(kind: UnitKind, id: string, userId: string, roleId: string) {
    return kind === 'division'
      ? this.api.post('/divisions/{id}/role-assignments', { userId, roleId }, { path: { id } })
      : this.api.post('/teams/{id}/role-assignments', { userId, roleId }, { path: { id } });
  }
  unassignRole(kind: UnitKind, id: string, assignmentId: string) {
    return kind === 'division'
      ? this.api.delete('/divisions/{id}/role-assignments/{assignmentId}', { path: { id, assignmentId } })
      : this.api.delete('/teams/{id}/role-assignments/{assignmentId}', { path: { id, assignmentId } });
  }
  /** Unit stats; each facet is a list of ids (empty = any), sent as `in:` lists. */
  unitStats(kind: UnitKind, id: string, facets: { team?: string[]; claimant?: string[]; requester?: string[] } = {}) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(facets)) if (v?.length) query[k] = `in:${v.join(',')}`;
    return kind === 'division'
      ? this.api.get('/divisions/{id}/stats', { path: { id }, query })
      : this.api.get('/teams/{id}/stats', { path: { id }, query });
  }
  listUnitMembers(kind: UnitKind, id: string) {
    return kind === 'division' ? this.listDivisionMembers(id) : this.listTeamMembers(id);
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
  /** Tell the other admins on `page` that this editor is changing it (or stopped, or saved). */
  announcePresence(page: RequestBody<'/admin/presence', 'post'>['page'], state: RequestBody<'/admin/presence', 'post'>['state']) {
    return this.api.post('/admin/presence', { page, state });
  }
}
