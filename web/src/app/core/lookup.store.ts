import { AccessApi, OrgApi } from './api/org.api';
import { firstValueFrom } from 'rxjs';
import { Injectable, inject, signal } from '@angular/core';
import { Division, Team } from './api.types';
import {
  divisionColor as computeDivColor,
  teamColor as computeTeamColor,
} from '../pages/tasks/task-presentation';


/**
 * Names for divisions, teams and users, from the read endpoints every member may
 * call (`division:read`, `team:read`, `user:read`). Loaded once and cached for the
 * session. A name that can't be resolved (the thing was collected, or the caller
 * may not see it) reads as "Unknown …", never as a raw id.
 */
@Injectable({ providedIn: 'root' })
export class LookupStore {
  private readonly accessApi = inject(AccessApi);
  private readonly orgApi = inject(OrgApi);

  readonly divisionList = signal<Division[]>([]);
  readonly teamList = signal<Team[]>([]);
  private readonly divisionNames = signal<Map<string, string>>(new Map());
  private readonly teamNames = signal<Map<string, string>>(new Map());
  private readonly userNames = signal<Map<string, string>>(new Map());
  private readonly userAvatars = signal<Map<string, string | null>>(new Map());
  private loading: Promise<void> | null = null;

  /** Load once and cache for the session (cheap name resolution on every page). */
  ensureLoaded(): Promise<void> {
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  /**
   * Force a re-fetch of the division/team/user lists. The store is a session-lived
   * singleton, so a list mutated elsewhere in the SPA (e.g. a division added in the
   * Admin pane) is otherwise invisible until a hard reload. Pages that present those
   * lists as live options (the task create form) call this on entry. (Cross-client
   * live updates are a separate concern — the future notifications slice, not this.)
   */
  refresh(): Promise<void> {
    this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const [divs, teams, users] = await Promise.all([
      firstValueFrom(this.orgApi.listDivisions()).catch(() => [] as Division[]),
      firstValueFrom(this.orgApi.listTeams()).catch(() => [] as Team[]),
      firstValueFrom(this.accessApi.listUsers()).catch(() => []),
    ]);
    this.divisionList.set(divs);
    this.teamList.set(teams);
    this.divisionNames.set(new Map(divs.map((d) => [d.id, d.name])));
    this.teamNames.set(new Map(teams.map((t) => [t.id, t.name])));
    this.userNames.set(new Map(users.map((u) => [u.id, u.displayName])));
    this.userAvatars.set(new Map(users.map((u) => [u.id, u.avatarUrl])));
  }

  divisionName(id: string): string {
    return this.divisionNames().get(id) ?? 'Unknown division';
  }
  teamName(id: string | null): string {
    return id ? (this.teamNames().get(id) ?? 'Unknown team') : '—';
  }
  /** A null id (an action no person took) reads as "System". */
  userName(id: string | null): string {
    if (!id) return 'System';
    return this.userNames().get(id) ?? 'Unknown user';
  }

  /** Discord avatar URL for a user, or null (→ initials). */
  userAvatar(id: string | null): string | null {
    if (!id) return null;
    return this.userAvatars().get(id) ?? null;
  }

  /** Division color, computed from its name (the API stores no colors). */
  divisionColor(id: string): string {
    const d = this.divisionList().find((div) => div.id === id);
    return d ? computeDivColor(d.name) : '#a7aba3';
  }

  /** Team color, computed from its name (the API stores no colors). */
  teamColor(id: string | null): string {
    if (!id) return '#a7aba3';
    const t = this.teamList().find((tm) => tm.id === id);
    return t ? computeTeamColor(t.name) : '#a7aba3';
  }
}
