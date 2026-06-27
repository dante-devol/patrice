import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { Division, Team } from './api.types';
import {
  divisionColor as computeDivColor,
  teamColor as computeTeamColor,
} from '../pages/tasks/task-presentation';

/** Shorten an id for display when its name can't be resolved. */
function short(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Best-effort name resolution for divisions/teams/users (Slice 4 web). The list
 * endpoints are admin-gated, so for non-admins these calls 403 and we fall back to
 * shortened ids — Permission Reflection: the UI degrades, it never enforces. Loaded
 * once and cached for the session.
 */
@Injectable({ providedIn: 'root' })
export class LookupStore {
  private readonly api = inject(ApiService);

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
      this.api.listDivisions().catch(() => [] as Division[]),
      this.api.listTeams().catch(() => [] as Team[]),
      this.api.listUsers().catch(() => []),
    ]);
    this.divisionList.set(divs);
    this.teamList.set(teams);
    this.divisionNames.set(new Map(divs.map((d) => [d.id, d.name])));
    this.teamNames.set(new Map(teams.map((t) => [t.id, t.name])));
    this.userNames.set(new Map(users.map((u) => [u.id, u.displayName])));
    this.userAvatars.set(new Map(users.map((u) => [u.id, u.avatarUrl])));
  }

  divisionName(id: string): string {
    return this.divisionNames().get(id) ?? short(id);
  }
  teamName(id: string | null): string {
    return id ? (this.teamNames().get(id) ?? short(id)) : '—';
  }
  /** A senderless (null) id renders as "System" — for system messages. */
  userName(id: string | null): string {
    if (!id) return 'System';
    return this.userNames().get(id) ?? short(id);
  }

  /**
   * Discord avatar URL for a user, or null (→ initials fallback). Sourced from the
   * admin-gated user list like {@link userName}, so for non-admins it degrades to
   * the initials avatar — Permission Reflection, never enforcement (#52).
   */
  userAvatar(id: string | null): string | null {
    if (!id) return null;
    return this.userAvatars().get(id) ?? null;
  }

  /** Resolved division color: stored hex overrides the computed name-hash fallback. */
  divisionColor(id: string): string {
    const d = this.divisionList().find((div) => div.id === id);
    return d ? (d.color ?? computeDivColor(d.name)) : '#a7aba3';
  }

  /** Resolved team color: stored hex overrides the computed name-hash fallback. */
  teamColor(id: string | null): string {
    if (!id) return '#a7aba3';
    const t = this.teamList().find((tm) => tm.id === id);
    return t ? (t.color ?? computeTeamColor(t.name)) : '#a7aba3';
  }
}
