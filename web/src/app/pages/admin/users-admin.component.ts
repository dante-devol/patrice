import { AccessApi, OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminUser, Division, Role, Team } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { UserAvatarComponent } from '../tasks/user-avatar.component';
import { divisionColor, teamColor } from '../tasks/task-presentation';
import { SaveBarComponent } from './save-bar.component';
import { LoadingRowsComponent } from '../../shared/loading';
import { MembershipDraft, UnitRef, unitKey } from './membership-draft';
import { supports } from '../../core/lookup.store';
import { StagedOp, isStale, runStaged, stagedErrorMessage } from './staged';

type LifecycleOp = 'deactivate' | 'reactivate' | 'retire' | 'revive';

/** A unit role as the editor shows it: saved (with its assignment id) or staged. */
interface UnitRoleChip {
  /** The assignment id when saved; the staged key when not. */
  key: string;
  roleId: string;
  unit: UnitRef;
  staged: 'added' | 'removed' | null;
}

const LIFECYCLE_NOTE: Record<LifecycleOp, string> = {
  deactivate: 'Deactivated on save',
  reactivate: 'Reactivated on save',
  retire: 'Retired on save',
  revive: 'Revived on save',
};

/**
 * The left list: Overall; each division with the teams that support it under it; then
 * every team, flat. A team is the same pick wherever it's clicked.
 */
type Pick = { kind: 'overall' } | ({ kind: 'unit' } & UnitRef);

/**
 * Users: who holds which roles, their lifecycle, and which divisions and teams they
 * belong to. A two-list editor: pick "Overall" (everyone, with roles and lifecycle) or a
 * division or team (its members, to add and remove). Every change is staged until Save;
 * membership changes save all-or-nothing through `POST /memberships/batch`.
 *
 * Org roles are given on Overall and apply org-wide. Unit roles are given to a member
 * inside a division or team and apply only there; Overall lists them too, to take away.
 */
@Component({
  selector: 'users-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UserAvatarComponent, SaveBarComponent, LoadingRowsComponent],
  styles: [`
    :host { display: block; font-size: 13px; }
    .pick { font: inherit; font-size: 13px; color: var(--ink); background: var(--paper); border: 1px solid var(--line);
            border-radius: 2px; padding: 4px 8px; margin: 0; width: auto; }
    .pick:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
    .pick--unset { color: var(--ink-soft); border-style: dashed; border-color: var(--faint); }
    .row-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; background: none; border: 0;
                border-radius: 0; margin: 0; color: var(--ink); font: inherit; font-weight: 400; text-align: left; cursor: pointer; }
    .row-item:hover { background: var(--paper-hover); }
    .row-item.is-current { background: var(--paper-hover); font-weight: 700; box-shadow: inset 3px 0 0 var(--ink); }
    .row-item--team { padding-left: 24px; }
    .group-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 8px; color: var(--ink);
                  background: color-mix(in srgb, var(--board) 60%, var(--paper)); border-top: 1px solid var(--faint); }
    .group-name { font-family: var(--font-display); font-weight: 700; font-size: 14px; }
    .person { display: flex; align-items: center; gap: 10px; padding: 8px 12px; }
    .person button { margin: 0; }
    .person--changed { box-shadow: inset 3px 0 0 var(--rust); }
    .person--removed .person-name { text-decoration: line-through; color: var(--ink-soft); }
    .chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 2px;
            padding: 1px 6px; font-size: 12px; background: var(--paper); }
    .chip--added { border-color: var(--rust); }
    .chip--removed { text-decoration: line-through; color: var(--ink-soft); }
    .chip button { background: none; border: 0; padding: 0 2px; margin: 0; color: var(--ink-soft); font: inherit; cursor: pointer; }
    .chip button:hover { color: var(--rust); background: none; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--rust); flex: none; }
    .synced { font-size: 12px; color: var(--ink-soft); border: 1px dashed var(--faint); border-radius: 2px; padding: 0 5px; }
    .search { display: flex; align-items: center; gap: 10px; }
    .search input { flex: 1; min-width: 0; margin: 0; padding: 7px 10px; background: var(--paper); border: 1px solid var(--line);
                    border-radius: 2px; color: var(--ink); font: inherit; }
    .search input:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
    /* One way to clear the search (the Clear button), in every browser. */
    .search input::-webkit-search-cancel-button { display: none; }
    .search button { margin: 0; }
  `],
  template: `
    <h2 class="font-display font-bold text-[18px] m-0 mb-3">Users</h2>
    @if (loadError()) { <p class="error">{{ loadError() }}</p> }

    <div class="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)] items-start">
      <!-- Left: Overall, then every division with its teams. -->
      @if (!loaded()) {
        <loading-rows label="Loading divisions and teams" [rows]="7" [detail]="false" [compact]="true" />
      } @else {
      <div class="sheet">
        <button class="row-item" [class.is-current]="selected().kind === 'overall'" (click)="selected.set({ kind: 'overall' })">
          <span class="flex-1">Overall</span>
          @if (rolesOrLifecycleChanged()) { <span class="dot" aria-label="Unsaved changes"></span> }
          <span class="text-ink-soft font-normal">{{ users().length }}</span>
        </button>
        <div class="group-head"><span class="group-name">Divisions</span></div>
        @for (d of divisions(); track d.id) {
          @let du = unit('division', d.id);
          <button class="row-item" [class.is-current]="isSelected(du)" [style.box-shadow]="isSelected(du) ? null : edge(divisionColor(d.name))" (click)="selectUnit(du)">
            <span class="flex-1 min-w-0 truncate">{{ d.name }}</span>
            @if (memberships.changedUnits().has(key(du))) { <span class="dot" aria-label="Unsaved changes"></span> }
            <span class="text-ink-soft font-normal">{{ memberships.memberCount(du) }}</span>
          </button>
          @for (t of teamsOf(d.id); track t.id) {
            @let tu = unit('team', t.id);
            @let both = membersOfBoth(du, tu);
            <button class="row-item row-item--team" [class.is-current]="isSelected(tu)" [style.box-shadow]="isSelected(tu) ? null : edge(teamColor(t.name))" (click)="selectUnit(tu)">
              <span class="flex-1 min-w-0 truncate">{{ t.name }}</span>
              @if (memberships.changedUnits().has(key(tu))) { <span class="dot" aria-label="Unsaved changes"></span> }
              <span class="text-ink-soft font-normal" [title]="both + ' in both ' + d.name + ' and ' + t.name">{{ both }}</span>
            </button>
          }
        } @empty { <p class="px-3 py-2 text-ink-soft m-0">No divisions yet.</p> }
        <div class="group-head"><span class="group-name">Teams</span></div>
        @for (t of sortedTeams(); track t.id) {
          @let tu = unit('team', t.id);
          <button class="row-item" [class.is-current]="isSelected(tu)" [style.box-shadow]="isSelected(tu) ? null : edge(teamColor(t.name))" (click)="selectUnit(tu)">
            <span class="flex-1 min-w-0 truncate">{{ t.name }}</span>
            @if (memberships.changedUnits().has(key(tu))) { <span class="dot" aria-label="Unsaved changes"></span> }
            <span class="text-ink-soft font-normal">{{ memberships.memberCount(tu) }}</span>
          </button>
        } @empty { <p class="px-3 py-2 text-ink-soft m-0">No teams yet.</p> }
      </div>
      }

      <!-- Right: the people in what's picked, narrowed by the search. -->
      <div class="min-w-0">
        @let sel = selected();
        <div class="search mb-3">
          <input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Search people by name or email"
                 aria-label="Search people by name or email" [disabled]="!loaded()" />
          @if (query()) {
            <span class="text-ink-soft whitespace-nowrap" aria-live="polite">{{ searchSummary(sel) }}</span>
            <button class="quiet" (click)="query.set('')">Clear</button>
          }
        </div>
        @if (!loaded()) {
          <loading-rows label="Loading people" [rows]="6" />
        } @else if (sel.kind === 'overall') {
          <div class="sheet">
            <div class="px-3 py-2.5">
              <div class="font-display font-bold text-[18px] leading-tight">Everyone</div>
              <div class="text-ink-soft mt-0.5">{{ users().length }} people. Org roles and account state are set here; pick a division or team to change who's in it and their unit roles there.</div>
            </div>
            @for (u of shownUsers(); track u.id) {
              @let lc = lifecycle()[u.id];
              <div class="person" [class.person--changed]="userChanged(u)" [class.row--retired]="u.lifecycleState === 'retired'">
                <user-avatar [name]="u.displayName" [seed]="u.id" [size]="28" [imageUrl]="u.avatarUrl" />
                <div class="min-w-0 flex-1">
                  <div class="person-name">{{ u.displayName }} <span class="text-ink-soft">{{ u.email }}</span></div>
                  <div class="flex flex-wrap items-center gap-1.5 mt-1">
                    @for (rid of shownRoles(u); track rid) {
                      @let st = roleStaged(u, rid);
                      <span class="chip" [class.chip--added]="st === 'added'" [class.chip--removed]="st === 'removed'">
                        {{ roleName(rid) }}
                        @if (st) {
                          <button (click)="undoRole(u, rid)" [attr.aria-label]="'Undo ' + roleName(rid)">undo</button>
                        } @else {
                          <button (click)="revokeRole(u, rid)" [attr.aria-label]="'Take away ' + roleName(rid)">×</button>
                        }
                      </span>
                    }
                    @for (c of unitRoleChips(u); track c.key) {
                      <span class="chip" [class.chip--added]="c.staged === 'added'" [class.chip--removed]="c.staged === 'removed'"
                            [title]="unitRoleTitle(c)">
                        {{ roleName(c.roleId) }} at {{ unitName(c.unit) }}
                        @if (c.staged) {
                          <button (click)="undoUnitRole(c)" [attr.aria-label]="'Undo ' + roleName(c.roleId) + ' at ' + unitName(c.unit)">undo</button>
                        } @else {
                          <button (click)="unassignUnitRole(c)" [attr.aria-label]="'Take away ' + roleName(c.roleId) + ' at ' + unitName(c.unit)">×</button>
                        }
                      </span>
                    }
                    @if (shownRoles(u).length === 0 && unitRoleChips(u).length === 0) { <span class="text-ink-soft">No roles</span> }
                    <select #rolePick class="pick pick--unset" (change)="grantRole(u, rolePick.value); rolePick.value = ''" aria-label="Give a role">
                      <option value="">Give a role</option>
                      @for (r of grantableRoles(u); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
                    </select>
                  </div>
                  @if (unitsOf(u.id); as units) { <div class="text-ink-soft mt-1">In {{ units }}</div> }
                </div>
                <div class="flex flex-col items-end gap-1">
                  @if (lc) { <span class="staged-note">{{ lifecycleNote(lc) }}</span> }
                  @else { <span [class]="'stamp stamp--lc-' + u.lifecycleState">{{ u.lifecycleState }}</span> }
                  <div class="flex gap-1">
                    @if (lc) {
                      <button class="quiet" (click)="setLifecycle(u, lc)">Undo</button>
                    } @else if (u.lifecycleState === 'active') {
                      <button class="quiet" (click)="setLifecycle(u, 'deactivate')">Deactivate</button>
                      <button class="quiet danger" (click)="setLifecycle(u, 'retire')">Retire</button>
                    } @else if (u.lifecycleState === 'deactivated') {
                      <button class="quiet" (click)="setLifecycle(u, 'reactivate')">Reactivate</button>
                      <button class="quiet danger" (click)="setLifecycle(u, 'retire')">Retire</button>
                    } @else if (u.lifecycleState === 'retired') {
                      <button class="quiet" (click)="setLifecycle(u, 'revive')">Revive</button>
                    }
                  </div>
                </div>
              </div>
            } @empty {
              <p class="px-3 py-3 text-ink-soft m-0">@if (query()) { No one matches “{{ query() }}”. } @else { No users. }</p>
            }
          </div>
        } @else {
          @let canManage = canManageUnit(sel);
          <div class="sheet">
            <div class="px-3 py-2.5">
              <div class="font-display font-bold text-[18px] leading-tight">{{ unitName(sel) }}</div>
              <div class="text-ink-soft mt-0.5">
                {{ sel.unitType === 'division' ? 'Division,' : 'Team · ' + teamDivisionsName(sel.unitId) + '.' }}
                {{ memberships.memberCount(sel) }} {{ memberships.memberCount(sel) === 1 ? 'member' : 'members' }}.
                Membership grants nothing by itself; roles do.
              </div>
              @if (canManage) {
                <div class="mt-2">
                  <select #memberPick class="pick pick--unset" (change)="addMember(sel, memberPick.value); memberPick.value = ''" aria-label="Add someone">
                    <option value="">Add someone</option>
                    @for (u of nonMembers(sel); track u.id) { <option [value]="u.id">{{ u.displayName }}</option> }
                  </select>
                </div>
              } @else {
                <div class="text-ink-soft mt-2">You can see this {{ sel.unitType }}'s members but not change them.</div>
              }
            </div>
            @for (id of shownMembers(sel); track id) {
              @let st = memberships.staged(sel, id);
              @let u = userById(id);
              <div class="person" [class.person--changed]="!!st" [class.person--removed]="st === 'removed'">
                <user-avatar [name]="u?.displayName ?? 'Unknown'" [seed]="id" [size]="24" [imageUrl]="u?.avatarUrl ?? null" />
                <div class="min-w-0 flex-1">
                  <span class="person-name">{{ u?.displayName ?? 'Unknown user' }}</span>
                  <span class="text-ink-soft"> {{ u?.email }}</span>
                  @if (u) {
                    @let chips = unitRoleChips(u, sel);
                    @if (chips.length || (canManage && st !== 'removed' && unitRolesFor(u, sel).length)) {
                      <div class="flex flex-wrap items-center gap-1.5 mt-1">
                        @for (c of chips; track c.key) {
                          <span class="chip" [class.chip--added]="c.staged === 'added'" [class.chip--removed]="c.staged === 'removed'"
                                [title]="unitRoleTitle(c)">
                            {{ roleName(c.roleId) }}
                            @if (c.staged) {
                              <button (click)="undoUnitRole(c)" [attr.aria-label]="'Undo ' + roleName(c.roleId)">undo</button>
                            } @else if (canManage) {
                              <button (click)="unassignUnitRole(c)" [attr.aria-label]="'Take away ' + roleName(c.roleId)">×</button>
                            }
                          </span>
                        }
                        @if (canManage && st !== 'removed' && unitRolesFor(u, sel).length) {
                          <select #unitRolePick class="pick pick--unset" (change)="assignUnitRole(u, unitRolePick.value, sel); unitRolePick.value = ''"
                                  [attr.aria-label]="'Give ' + u.displayName + ' a unit role here'"
                                  [title]="'A unit role applies only in this ' + sel.unitType + (sel.unitType === 'division' ? ' and its single-division teams' : '')">
                            <option value="">Give a unit role</option>
                            @for (r of unitRolesFor(u, sel); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
                          </select>
                        }
                      </div>
                    }
                  }
                </div>
                @if (memberships.source(sel, id) === 'integration') {
                  <span class="synced" title="Added by a Discord sync. Removing it here may be undone by the next sync unless the mapping changes.">Synced</span>
                }
                @if (st) {
                  <span class="staged-note">{{ st === 'added' ? 'Added on save' : 'Removed on save' }}</span>
                  <button class="quiet" (click)="memberships.undo(sel, id)">Undo</button>
                } @else if (canManage) {
                  <button class="quiet danger" (click)="memberships.remove(sel, id)">Remove</button>
                }
              </div>
            } @empty {
              <p class="px-3 py-3 text-ink-soft m-0">
                @if (query()) { No one in this {{ sel.unitType }} matches “{{ query() }}”. } @else { Nobody is in this {{ sel.unitType }} yet. }
              </p>
            }
          </div>
        }
        <save-bar [count]="count()" [where]="where()" [saving]="busy()" [error]="saveError()" [stale]="stale()"
                  (save)="save()" (discard)="discard()" (reload)="reload()" />
      </div>
    </div>
  `,
})
export class UsersAdminComponent implements OnDestroy {
  private readonly accessApi = inject(AccessApi);
  private readonly orgApi = inject(OrgApi);
  private readonly unsaved = inject(UnsavedChangesService);

  readonly users = signal<AdminUser[]>([]);
  readonly roles = signal<Role[]>([]);
  readonly divisions = signal<Division[]>([]);
  readonly teams = signal<Team[]>([]);
  /** `type:id` of the units whose members the admin may change. */
  private readonly manageable = signal<ReadonlySet<string>>(new Set());
  readonly memberships = new MembershipDraft();

  /** Staged role changes, keyed `userId|roleId`. */
  readonly roleGrants = signal<ReadonlySet<string>>(new Set());
  readonly roleRevokes = signal<ReadonlySet<string>>(new Set());
  /** Staged unit-role assignments, keyed `userId|roleId|unitType|unitId`. */
  readonly unitAssigns = signal<ReadonlySet<string>>(new Set());
  /** Saved unit-role assignment ids staged to be taken away. */
  readonly unitUnassigns = signal<ReadonlySet<string>>(new Set());
  readonly lifecycle = signal<Record<string, LifecycleOp>>({});

  readonly selected = signal<Pick>({ kind: 'overall' });
  readonly busy = signal(false);
  /** The first load has finished (or failed): until then both lists show placeholders. */
  readonly loaded = signal(false);
  /** Search: narrows the people shown, on Everyone and in a division or team. */
  readonly query = signal('');
  private readonly needle = computed(() => this.query().trim().toLowerCase());
  readonly shownUsers = computed(() => this.users().filter((u) => this.matches(u)));
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);

  readonly divisionColor = divisionColor;
  readonly teamColor = teamColor;
  readonly key = unitKey;

  private readonly userChangeCount = computed(
    () =>
      this.roleGrants().size +
      this.roleRevokes().size +
      this.unitAssigns().size +
      this.unitUnassigns().size +
      Object.keys(this.lifecycle()).length,
  );
  readonly count = computed(() => this.memberships.count() + this.userChangeCount());
  readonly rolesOrLifecycleChanged = computed(() => this.userChangeCount() > 0);
  readonly where = computed(() => {
    const parts = [...this.memberships.changedUnits()].map((k) => {
      const [unitType, unitId] = k.split(':') as [UnitRef['unitType'], string];
      return this.unitName({ unitType, unitId });
    });
    const people = new Set(
      [...this.roleGrants(), ...this.roleRevokes(), ...this.unitAssigns()]
        .map((k) => k.split('|')[0])
        .concat(Object.keys(this.lifecycle()), [...this.unitUnassigns()].map((id) => this.assignmentOwner(id) ?? id)),
    ).size;
    if (people > 0) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
    return parts.join(', ') || null;
  });

  constructor() {
    effect(() => this.unsaved.pending.set(this.count()));
    void this.load(true);
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  /** Read everything; `discard` also drops what's staged. */
  private async load(discard: boolean): Promise<void> {
    try {
      const [users, roles, divisions, teams, memberships] = await Promise.all([
        // Include retired users so scrubbed tombstones stay visible in the admin roster.
        firstValueFrom(this.accessApi.listUsers(true)),
        firstValueFrom(this.orgApi.listRoles()),
        firstValueFrom(this.orgApi.listDivisions()),
        firstValueFrom(this.orgApi.listTeams()),
        firstValueFrom(this.orgApi.listMemberships()),
      ]);
      this.users.set(users);
      this.roles.set(roles);
      this.divisions.set(divisions);
      this.teams.set(teams);
      this.manageable.set(
        new Set(memberships.units.filter((u) => u.allowedActions.length > 0).map((u) => unitKey(u))),
      );
      if (discard) {
        this.memberships.reset(memberships.items);
        this.discardUserChanges();
      } else {
        this.memberships.saved.set(memberships.items);
      }
      this.loadError.set(null);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    } finally {
      this.loaded.set(true);
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────

  /** Whether someone matches the search: their name or email contains it. */
  matches(u: AdminUser | undefined): boolean {
    const q = this.needle();
    if (!q) return true;
    if (!u) return false;
    return u.displayName.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q);
  }

  /** A unit's members (as staged), narrowed by the search. */
  shownMembers(sel: UnitRef): string[] {
    const ids = this.memberships.shown(sel);
    return this.needle() ? ids.filter((id) => this.matches(this.userById(id))) : ids;
  }

  searchSummary(sel: Pick): string {
    const [shown, all] =
      sel.kind === 'overall'
        ? [this.shownUsers().length, this.users().length]
        : [this.shownMembers(sel).length, this.memberships.shown(sel).length];
    return `Showing ${shown} of ${all}`;
  }

  // ── Reading ────────────────────────────────────────────────────────────

  unit(unitType: UnitRef['unitType'], unitId: string): UnitRef {
    return { unitType, unitId };
  }
  isSelected(u: UnitRef): boolean {
    const s = this.selected();
    return s.kind === 'unit' && s.unitType === u.unitType && s.unitId === u.unitId;
  }
  selectUnit(u: UnitRef): void {
    this.selected.set({ kind: 'unit', ...u });
  }
  edge(color: string): string {
    return `inset 3px 0 0 ${color}`;
  }
  /** The teams that support a division (all-division teams included), by name. */
  teamsOf(divisionId: string): Team[] {
    return this.sortedTeams().filter((t) => supports(t, divisionId));
  }
  readonly sortedTeams = computed(() => [...this.teams()].sort((a, b) => a.name.localeCompare(b.name)));
  /** People in both a division and one of its teams (as staged). */
  membersOfBoth(division: UnitRef, team: UnitRef): number {
    return this.memberships
      .shown(team)
      .filter((id) => this.memberships.isMember(team, id) && this.memberships.isMember(division, id)).length;
  }
  canManageUnit(u: UnitRef): boolean {
    return this.manageable().has(unitKey(u));
  }
  unitName(u: UnitRef): string {
    const list: { id: string; name: string }[] = u.unitType === 'division' ? this.divisions() : this.teams();
    return list.find((x) => x.id === u.unitId)?.name ?? 'Unknown';
  }
  /** "Writing, Art", or "all divisions": what a team serves. */
  teamDivisionsName(teamId: string): string {
    const t = this.teams().find((x) => x.id === teamId);
    if (!t) return 'unknown divisions';
    if (t.allDivisions) return 'all divisions';
    return t.divisionIds
      .map((id) => this.divisions().find((d) => d.id === id)?.name ?? 'Unknown division')
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
  }
  userById(id: string): AdminUser | undefined {
    return this.users().find((u) => u.id === id);
  }
  /** Active people not (yet) in the unit. */
  nonMembers(u: UnitRef): AdminUser[] {
    return this.users().filter((x) => x.lifecycleState === 'active' && !this.memberships.isMember(u, x.id));
  }
  /** "Writing, USA": the units a person will be in after Save. */
  unitsOf(userId: string): string {
    const divisions = this.divisions().filter((d) => this.memberships.isMember(this.unit('division', d.id), userId));
    const teams = this.teams().filter((t) => this.memberships.isMember(this.unit('team', t.id), userId));
    return [...divisions, ...teams].map((x) => x.name).join(', ');
  }
  roleName(id: string): string {
    return this.roles().find((r) => r.id === id)?.name ?? id.slice(0, 8);
  }
  lifecycleNote(op: LifecycleOp): string {
    return LIFECYCLE_NOTE[op];
  }

  // ── Roles and lifecycle (staged) ───────────────────────────────────────

  private pair(u: AdminUser, roleId: string): string {
    return `${u.id}|${roleId}`;
  }
  /** Saved roles plus staged grants; staged revokes stay visible, struck through. */
  shownRoles(u: AdminUser): string[] {
    const granted = [...this.roleGrants()].filter((k) => k.startsWith(`${u.id}|`)).map((k) => k.split('|')[1]);
    return [...u.roleIds, ...granted];
  }
  roleStaged(u: AdminUser, roleId: string): 'added' | 'removed' | null {
    const k = this.pair(u, roleId);
    return this.roleGrants().has(k) ? 'added' : this.roleRevokes().has(k) ? 'removed' : null;
  }
  grantableRoles(u: AdminUser): Role[] {
    const held = new Set(this.shownRoles(u));
    // Org roles only: a unit role is given inside a division or team.
    return this.roles().filter((r) => r.kind === 'org' && r.lifecycleState === 'active' && !held.has(r.id));
  }
  grantRole(u: AdminUser, roleId: string): void {
    if (!roleId) return;
    this.roleGrants.set(new Set([...this.roleGrants(), this.pair(u, roleId)]));
  }
  revokeRole(u: AdminUser, roleId: string): void {
    this.roleRevokes.set(new Set([...this.roleRevokes(), this.pair(u, roleId)]));
  }
  undoRole(u: AdminUser, roleId: string): void {
    const k = this.pair(u, roleId);
    this.roleGrants.set(new Set([...this.roleGrants()].filter((x) => x !== k)));
    this.roleRevokes.set(new Set([...this.roleRevokes()].filter((x) => x !== k)));
  }
  /** Stage a lifecycle change; staging the same one again undoes it. */
  setLifecycle(u: AdminUser, op: LifecycleOp): void {
    const { [u.id]: current, ...others } = this.lifecycle();
    this.lifecycle.set(current === op ? others : { ...others, [u.id]: op });
  }
  userChanged(u: AdminUser): boolean {
    return (
      u.id in this.lifecycle() ||
      [...this.roleGrants(), ...this.roleRevokes(), ...this.unitAssigns()].some((k) => k.startsWith(`${u.id}|`)) ||
      u.unitRoles.some((a) => this.unitUnassigns().has(a.id))
    );
  }

  // ── Unit roles (staged) ────────────────────────────────────────────────

  private assignKey(userId: string, roleId: string, unit: UnitRef): string {
    return `${userId}|${roleId}|${unit.unitType}|${unit.unitId}`;
  }
  private sameUnit(a: UnitRef, b: UnitRef): boolean {
    return a.unitType === b.unitType && a.unitId === b.unitId;
  }
  private assignmentOwner(id: string): string | undefined {
    return this.users().find((u) => u.unitRoles.some((a) => a.id === id))?.id;
  }
  /** A person's unit roles, saved and staged, everywhere or at one unit. */
  unitRoleChips(u: AdminUser, at?: UnitRef): UnitRoleChip[] {
    const saved: UnitRoleChip[] = u.unitRoles.map((a) => ({
      key: a.id,
      roleId: a.roleId,
      unit: { unitType: a.unitType, unitId: a.unitId },
      staged: this.unitUnassigns().has(a.id) ? 'removed' : null,
    }));
    const added: UnitRoleChip[] = [...this.unitAssigns()]
      .filter((k) => k.startsWith(`${u.id}|`))
      .map((k) => {
        const [, roleId, unitType, unitId] = k.split('|');
        return { key: k, roleId, unit: { unitType: unitType as UnitRef['unitType'], unitId }, staged: 'added' as const };
      });
    const all = [...saved, ...added];
    return at ? all.filter((c) => this.sameUnit(c.unit, at)) : all;
  }
  /** Active unit roles this person doesn't already hold (or have staged) at the unit. */
  unitRolesFor(u: AdminUser, at: UnitRef): Role[] {
    const held = new Set(this.unitRoleChips(u, at).filter((c) => c.staged !== 'removed').map((c) => c.roleId));
    return this.roles().filter((r) => r.kind === 'unit' && r.lifecycleState === 'active' && !held.has(r.id));
  }
  unitRoleTitle(c: UnitRoleChip): string {
    const where = c.unit.unitType === 'division' ? `${this.unitName(c.unit)} and its teams` : this.unitName(c.unit);
    return `A unit role: its grants apply only in ${where}`;
  }
  assignUnitRole(u: AdminUser, roleId: string, at: UnitRef): void {
    if (!roleId) return;
    this.unitAssigns.set(new Set([...this.unitAssigns(), this.assignKey(u.id, roleId, at)]));
  }
  unassignUnitRole(c: UnitRoleChip): void {
    this.unitUnassigns.set(new Set([...this.unitUnassigns(), c.key]));
  }
  undoUnitRole(c: UnitRoleChip): void {
    this.unitAssigns.set(new Set([...this.unitAssigns()].filter((k) => k !== c.key)));
    this.unitUnassigns.set(new Set([...this.unitUnassigns()].filter((k) => k !== c.key)));
  }

  // ── Memberships (staged) ───────────────────────────────────────────────

  addMember(u: UnitRef, userId: string): void {
    if (userId) this.memberships.add(u, userId);
  }

  // ── Save / Cancel ──────────────────────────────────────────────────────

  private discardUserChanges(): void {
    this.roleGrants.set(new Set());
    this.roleRevokes.set(new Set());
    this.unitAssigns.set(new Set());
    this.unitUnassigns.set(new Set());
    this.lifecycle.set({});
  }

  discard(): void {
    this.memberships.discard();
    this.discardUserChanges();
    this.saveError.set(null);
    this.stale.set(false);
  }

  async reload(): Promise<void> {
    this.saveError.set(null);
    this.stale.set(false);
    await this.load(true);
  }

  async save(): Promise<void> {
    const drop = (sig: typeof this.roleGrants, k: string) => sig.set(new Set([...sig()].filter((x) => x !== k)));
    const ops: StagedOp[] = [];
    // Memberships first, all-or-nothing in one request.
    if (this.memberships.count() > 0) {
      const changes = this.memberships.changes();
      ops.push({
        run: async () => this.memberships.reset((await firstValueFrom(this.orgApi.saveMemberships(changes))).items),
        clear: () => undefined,
      });
    }
    // Then roles (take-aways before gives) and lifecycle, each checked by the API as it
    // lands; a revoke that would leave no admin is refused there.
    const dropAssign = (sig: typeof this.unitAssigns, k: string) => sig.set(new Set([...sig()].filter((x) => x !== k)));
    for (const id of this.unitUnassigns()) {
      const a = this.users().flatMap((u) => u.unitRoles).find((x) => x.id === id);
      if (!a) continue;
      ops.push({
        run: () => firstValueFrom(this.orgApi.unassignRole(a.unitType, a.unitId, a.id)),
        clear: () => dropAssign(this.unitUnassigns, id),
      });
    }
    for (const k of this.roleRevokes()) {
      const [userId, roleId] = k.split('|');
      ops.push({ run: () => firstValueFrom(this.accessApi.revokeUserRole(userId, roleId)), clear: () => drop(this.roleRevokes, k) });
    }
    for (const k of this.roleGrants()) {
      const [userId, roleId] = k.split('|');
      ops.push({ run: () => firstValueFrom(this.accessApi.grantUserRole(userId, roleId)), clear: () => drop(this.roleGrants, k) });
    }
    // A unit role also makes the person a member, so these follow the membership batch.
    for (const k of this.unitAssigns()) {
      const [userId, roleId, unitType, unitId] = k.split('|');
      ops.push({
        run: () => firstValueFrom(this.orgApi.assignRole(unitType as UnitRef['unitType'], unitId, userId, roleId)),
        clear: () => dropAssign(this.unitAssigns, k),
      });
    }
    for (const [userId, op] of Object.entries(this.lifecycle())) {
      ops.push({
        run: () => firstValueFrom(this.lifecycleCall(userId, op)),
        clear: () => {
          const { [userId]: _done, ...rest } = this.lifecycle();
          this.lifecycle.set(rest);
        },
      });
    }

    this.busy.set(true);
    this.saveError.set(null);
    this.stale.set(false);
    const result = await runStaged(ops);
    await this.load(false);
    if (result.error) {
      this.stale.set(isStale(result.error));
      this.saveError.set(stagedErrorMessage(result));
    } else {
      this.unsaved.markSaved();
    }
    this.busy.set(false);
  }

  private lifecycleCall(userId: string, op: LifecycleOp) {
    switch (op) {
      case 'deactivate': return this.accessApi.deactivateUser(userId);
      case 'reactivate': return this.accessApi.reactivateUser(userId);
      case 'retire': return this.accessApi.retireUser(userId);
      case 'revive': return this.accessApi.reviveUser(userId);
    }
  }
}
