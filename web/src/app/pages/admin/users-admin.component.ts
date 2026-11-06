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
import { MembershipDraft, UnitRef, unitKey } from './membership-draft';
import { StagedOp, isStale, runStaged, stagedErrorMessage } from './staged';

type LifecycleOp = 'deactivate' | 'reactivate' | 'retire' | 'revive';

const LIFECYCLE_NOTE: Record<LifecycleOp, string> = {
  deactivate: 'Deactivated on save',
  reactivate: 'Reactivated on save',
  retire: 'Retired on save',
  revive: 'Revived on save',
};

/** The left list: Overall, then each division with its teams under it. */
type Pick = { kind: 'overall' } | ({ kind: 'unit' } & UnitRef);

/**
 * Users: who holds which roles, their lifecycle, and which divisions and teams they
 * belong to. A two-list editor: pick "Overall" (everyone, with roles and lifecycle) or a
 * division or team (its members, to add and remove). Every change is staged until Save;
 * membership changes save all-or-nothing through `POST /memberships/batch`.
 */
@Component({
  selector: 'users-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UserAvatarComponent, SaveBarComponent],
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
  `],
  template: `
    <h2 class="font-display font-bold text-[18px] m-0 mb-3">Users</h2>
    @if (loadError()) { <p class="error">{{ loadError() }}</p> }

    <div class="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)] items-start">
      <!-- Left: Overall, then every division with its teams. -->
      <div class="sheet">
        <button class="row-item" [class.is-current]="selected().kind === 'overall'" (click)="selected.set({ kind: 'overall' })">
          <span class="flex-1">Overall</span>
          @if (rolesOrLifecycleChanged()) { <span class="dot" aria-label="Unsaved changes"></span> }
          <span class="text-ink-soft font-normal">{{ users().length }}</span>
        </button>
        <div class="group-head"><span class="group-name">Divisions and teams</span></div>
        @for (d of divisions(); track d.id) {
          @let du = unit('division', d.id);
          <button class="row-item" [class.is-current]="isSelected(du)" [style.box-shadow]="isSelected(du) ? null : edge(divisionColor(d.name))" (click)="selectUnit(du)">
            <span class="flex-1 min-w-0 truncate">{{ d.name }}</span>
            @if (memberships.changedUnits().has(key(du))) { <span class="dot" aria-label="Unsaved changes"></span> }
            <span class="text-ink-soft font-normal">{{ memberships.memberCount(du) }}</span>
          </button>
          @for (t of teamsOf(d.id); track t.id) {
            @let tu = unit('team', t.id);
            <button class="row-item row-item--team" [class.is-current]="isSelected(tu)" [style.box-shadow]="isSelected(tu) ? null : edge(teamColor(t.name))" (click)="selectUnit(tu)">
              <span class="flex-1 min-w-0 truncate">{{ t.name }}</span>
              @if (memberships.changedUnits().has(key(tu))) { <span class="dot" aria-label="Unsaved changes"></span> }
              <span class="text-ink-soft font-normal">{{ memberships.memberCount(tu) }}</span>
            </button>
          }
        } @empty { <p class="px-3 py-2 text-ink-soft m-0">No divisions yet.</p> }
      </div>

      <!-- Right: the people in what's picked. -->
      <div class="min-w-0">
        @let sel = selected();
        @if (sel.kind === 'overall') {
          <div class="sheet">
            <div class="px-3 py-2.5">
              <div class="font-display font-bold text-[18px] leading-tight">Everyone</div>
              <div class="text-ink-soft mt-0.5">{{ users().length }} people. Roles and account state are set here; pick a division or team to change who's in it.</div>
            </div>
            @for (u of users(); track u.id) {
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
                    } @empty { <span class="text-ink-soft">No roles</span> }
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
            } @empty { <p class="px-3 py-3 text-ink-soft m-0">No users.</p> }
          </div>
        } @else {
          @let canManage = canManageUnit(sel);
          <div class="sheet">
            <div class="px-3 py-2.5">
              <div class="font-display font-bold text-[18px] leading-tight">{{ unitName(sel) }}</div>
              <div class="text-ink-soft mt-0.5">
                {{ sel.unitType === 'division' ? 'Division' : 'Team in ' + parentDivisionName(sel.unitId) }},
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
            @for (id of memberships.shown(sel); track id) {
              @let st = memberships.staged(sel, id);
              @let u = userById(id);
              <div class="person" [class.person--changed]="!!st" [class.person--removed]="st === 'removed'">
                <user-avatar [name]="u?.displayName ?? 'Unknown'" [seed]="id" [size]="24" [imageUrl]="u?.avatarUrl ?? null" />
                <div class="min-w-0 flex-1">
                  <span class="person-name">{{ u?.displayName ?? 'Unknown user' }}</span>
                  <span class="text-ink-soft"> {{ u?.email }}</span>
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
            } @empty { <p class="px-3 py-3 text-ink-soft m-0">Nobody is in this {{ sel.unitType }} yet.</p> }
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
  readonly lifecycle = signal<Record<string, LifecycleOp>>({});

  readonly selected = signal<Pick>({ kind: 'overall' });
  readonly busy = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);

  readonly divisionColor = divisionColor;
  readonly teamColor = teamColor;
  readonly key = unitKey;

  readonly count = computed(
    () => this.memberships.count() + this.roleGrants().size + this.roleRevokes().size + Object.keys(this.lifecycle()).length,
  );
  readonly rolesOrLifecycleChanged = computed(
    () => this.roleGrants().size + this.roleRevokes().size + Object.keys(this.lifecycle()).length > 0,
  );
  readonly where = computed(() => {
    const parts = [...this.memberships.changedUnits()].map((k) => {
      const [unitType, unitId] = k.split(':') as [UnitRef['unitType'], string];
      return this.unitName({ unitType, unitId });
    });
    const people = new Set(
      [...this.roleGrants(), ...this.roleRevokes()].map((k) => k.split('|')[0]).concat(Object.keys(this.lifecycle())),
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
    }
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
  teamsOf(divisionId: string): Team[] {
    return this.teams().filter((t) => t.divisionId === divisionId);
  }
  canManageUnit(u: UnitRef): boolean {
    return this.manageable().has(unitKey(u));
  }
  unitName(u: UnitRef): string {
    const list: { id: string; name: string }[] = u.unitType === 'division' ? this.divisions() : this.teams();
    return list.find((x) => x.id === u.unitId)?.name ?? 'Unknown';
  }
  parentDivisionName(teamId: string): string {
    const t = this.teams().find((x) => x.id === teamId);
    return this.divisions().find((d) => d.id === t?.divisionId)?.name ?? 'a division';
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
    return this.roles().filter((r) => r.lifecycleState === 'active' && !held.has(r.id));
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
      [...this.roleGrants(), ...this.roleRevokes()].some((k) => k.startsWith(`${u.id}|`))
    );
  }

  // ── Memberships (staged) ───────────────────────────────────────────────

  addMember(u: UnitRef, userId: string): void {
    if (userId) this.memberships.add(u, userId);
  }

  // ── Save / Cancel ──────────────────────────────────────────────────────

  private discardUserChanges(): void {
    this.roleGrants.set(new Set());
    this.roleRevokes.set(new Set());
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
    // Then roles (revokes before grants) and lifecycle, each checked by the API as it lands;
    // a revoke that would leave no admin is refused there.
    for (const k of this.roleRevokes()) {
      const [userId, roleId] = k.split('|');
      ops.push({ run: () => firstValueFrom(this.accessApi.revokeUserRole(userId, roleId)), clear: () => drop(this.roleRevokes, k) });
    }
    for (const k of this.roleGrants()) {
      const [userId, roleId] = k.split('|');
      ops.push({ run: () => firstValueFrom(this.accessApi.grantUserRole(userId, roleId)), clear: () => drop(this.roleGrants, k) });
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
