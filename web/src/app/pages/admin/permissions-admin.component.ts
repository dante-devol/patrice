import { AccessApi, OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActionInfo, Division, Grant, Role, ScopeKind, Team } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { ToastService } from '../../core/toast.service';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { SaveBarComponent } from './save-bar.component';
import { ScopeOption, ScopeSelectComponent } from './scope-select.component';
import { LoadingRowsComponent } from '../../shared/loading';
import { divisionColor, teamColor } from '../tasks/task-presentation';
import {
  NOT_GRANTED,
  actionDescription,
  actionLabel,
  groupActions,
  isTargeted,
  scopeHint,
  scopeLabel,
} from './permission-labels';
import {
  DraftGrant,
  changedCells,
  diffDrafts,
  draftsFrom,
  isIncomplete,
  withScope,
} from './permissions-draft';

type View = 'role' | 'action';

/** What each role kind is, for the group headers and the role header's tooltip. */
const ROLE_KINDS: { kind: Role['kind']; name: string; label: string; hint: string }[] = [
  {
    kind: 'baseline',
    name: 'Everyone',
    label: 'Held by everyone',
    hint:
      "Every signed-in person holds Everyone. It can't be given or taken away, and isn't shown on " +
      'people; edit here what it lets everyone do.',
  },
  { kind: 'org', name: 'Org roles', label: 'Org role', hint: 'Given to people across the whole organization.' },
  {
    kind: 'unit',
    name: 'Unit roles',
    label: 'Unit role',
    hint: 'Held at a division or team, and only applies there. Divisions and teams give their default unit role to people who join.',
  },
];

/**
 * Permissions editor. Pick a role and edit its grants, grouped by resource ("By
 * role"), or pick an action and see every role that holds it ("By action"). Both
 * views edit one working copy; nothing is sent until Save changes, which applies
 * the whole difference in one all-or-nothing `POST /grants/batch`.
 */
@Component({
  selector: 'permissions-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, SaveBarComponent, LoadingRowsComponent, ScopeSelectComponent],
  styles: [`
    :host { display: block; font-size: 13px; }
    .pick { font: inherit; font-size: 13px; color: var(--ink); background: var(--paper);
            border: 1px solid var(--line); border-radius: 2px; padding: 4px 8px; margin: 0; width: auto; }
    .pick:hover { border-color: var(--faint); }
    .pick:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
    .pick--unset { color: var(--ink-soft); border-style: dashed; border-color: var(--faint); }
    .pick--changed { border-color: var(--rust); }
    .find { width: 100%; }
    .row-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px;
                background: none; border: 0; border-radius: 0; margin: 0; color: var(--ink);
                font: inherit; font-weight: 400; text-align: left; cursor: pointer; }
    .row-item:hover { background: var(--paper-hover); }
    .row-item.is-current { background: var(--paper-hover); font-weight: 700; box-shadow: inset 3px 0 0 var(--ink); }
    /* Category headers: a board-tinted band under a darker rule, a full step below the
       alternating rows, so a category never reads as one more line entry. */
    .group-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px 8px;
                  background: color-mix(in srgb, var(--board) 60%, var(--paper));
                  border: 0; border-top: 1px solid var(--faint); border-radius: 0; margin: 0;
                  color: var(--ink); font: inherit; font-weight: 400; text-align: left; cursor: pointer; }
    .group-head:first-child { border-top: 0; }
    .group-head:hover { background: color-mix(in srgb, var(--board) 85%, var(--paper)); }
    .group-name { font-family: var(--font-display); font-weight: 700; font-size: 14px; }
    .group-count { color: var(--ink-soft); }
    .perm-row { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; }
    .perm-row--changed { box-shadow: inset 3px 0 0 var(--rust); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--rust); flex: none; }
    .was { font-size: 12px; color: var(--ink-soft); text-decoration: line-through; }
    .add { font-size: 16px; line-height: 1; padding: 2px 6px; margin: 0; }
  `],
  template: `
    <div class="flex items-baseline gap-4 mb-3">
      <h2 class="font-display font-bold text-[18px] m-0">Permissions</h2>
      <span class="flex-1"></span>
      <nav class="flex gap-1" aria-label="Permissions view">
        @for (v of views; track v.id) {
          <button class="admin-tab" [class.is-active]="view() === v.id"
                  [attr.aria-pressed]="view() === v.id" (click)="view.set(v.id)">{{ v.name }}</button>
        }
      </nav>
    </div>

    @if (loadError()) { <p class="error">{{ loadError() }}</p> }

    <div class="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)] items-start">
      <!-- Left: what you pick — a role or an action. -->
      <div>
        @if (!loaded()) {
          <loading-rows [label]="view() === 'role' ? 'Loading roles' : 'Loading actions'" [rows]="8" [detail]="false" [compact]="true" />
        } @else if (view() === 'role') {
          <input class="pick find mb-2" type="search" placeholder="Find a role" aria-label="Find a role"
                 [ngModel]="roleQuery()" (ngModelChange)="roleQuery.set($event)" />
          <div class="sheet">
            @for (g of roleGroups(); track g.kind) {
              <!-- Everyone is one role on its own: no group header, just the row. -->
              @if (g.kind !== 'baseline') {
                <button class="group-head" (click)="toggle('roles:' + g.kind)" [attr.aria-expanded]="!isCollapsed('roles:' + g.kind)"
                        [title]="g.hint">
                  <span class="group-name">{{ g.name }}</span><span class="group-count">{{ g.roles.length }}</span>
                  <span class="flex-1"></span><span aria-hidden="true">{{ isCollapsed('roles:' + g.kind) ? '+' : '−' }}</span>
                </button>
              }
              @if (g.kind === 'baseline' || !isCollapsed('roles:' + g.kind)) {
                @for (r of g.roles; track r.id) {
                  <button class="row-item" [class.is-current]="r.id === selectedRoleId()"
                          [style.box-shadow]="r.id === selectedRoleId() ? null : roleEdge(r)"
                          [title]="r.kind === 'baseline' ? g.hint : ''"
                          (click)="selectedRoleId.set(r.id)">
                    <span class="min-w-0 truncate">{{ r.name }}</span><span class="flex-1"></span>
                    @if (dirtyRoles().has(r.id)) { <span class="dot" aria-label="Unsaved changes"></span> }
                    <span class="text-ink-soft font-normal">{{ grantCount(r.id) }}</span>
                  </button>
                }
              }
            } @empty { <p class="px-3 py-2 text-ink-soft m-0">No roles match.</p> }
          </div>
        } @else {
          <input class="pick find mb-2" type="search" placeholder="Find an action" aria-label="Find an action"
                 [ngModel]="actionQuery()" (ngModelChange)="actionQuery.set($event)" />
          <div class="sheet">
            @for (g of actionPickGroups(); track g.name) {
              <button class="group-head" (click)="toggle('actions:' + g.name)" [attr.aria-expanded]="!isCollapsed('actions:' + g.name)">
                <span class="group-name">{{ g.name }}</span><span class="group-count">{{ g.actions.length }}</span>
                <span class="flex-1"></span><span aria-hidden="true">{{ isCollapsed('actions:' + g.name) ? '+' : '−' }}</span>
              </button>
              @if (!isCollapsed('actions:' + g.name)) {
                @for (a of g.actions; track a.action) {
                  <button class="row-item" [class.is-current]="a.action === selectedAction()" [title]="describe(a.action)" (click)="selectedAction.set(a.action)">
                    <span class="min-w-0 truncate">{{ label(a.action) }}</span><span class="flex-1"></span>
                    @if (dirtyActions().has(a.action)) { <span class="dot" aria-label="Unsaved changes"></span> }
                    <span class="text-ink-soft font-normal">{{ holderCount(a.action) }}</span>
                  </button>
                }
              }
            } @empty { <p class="px-3 py-2 text-ink-soft m-0">No actions match.</p> }
          </div>
        }
      </div>

      <!-- Right: the grants for what's picked. -->
      <div class="min-w-0">
        @if (!loaded()) {
          <loading-rows label="Loading permissions" [rows]="6" />
        } @else if (view() === 'role') {
          @let r = selectedRole();
          @if (r) {
            <div class="sheet">
              <div class="px-3 py-2.5">
                <div class="font-display font-bold text-[18px] leading-tight">{{ r.name }}</div>
                <div class="text-ink-soft mt-0.5">
                  <span class="hint hint--start" [attr.data-hint]="kindHint(r)" tabindex="0">{{ kindLabel(r) }}</span>,
                  {{ grantCount(r.id) }} {{ grantCount(r.id) === 1 ? 'grant' : 'grants' }}
                </div>
                @if (r.kind === 'baseline') {
                  <p class="mt-1.5 mb-0 max-w-[60ch]">
                    Every signed-in person holds this role. Anything granted here applies to everyone, so keep it to what
                    anyone may do; work in a division or team comes from unit roles such as Member.
                  </p>
                }
                <div class="flex flex-wrap items-center gap-3 mt-2">
                  <input class="pick flex-1 min-w-[160px]" type="search" placeholder="Filter actions" aria-label="Filter actions"
                         [ngModel]="actionQuery()" (ngModelChange)="actionQuery.set($event)" />
                  <label class="inline-flex items-center gap-1.5 m-0 text-ink cursor-pointer">
                    <input type="checkbox" class="m-0" [ngModel]="grantedOnly()" (ngModelChange)="grantedOnly.set($event)" />
                    Granted only
                  </label>
                </div>
              </div>
              @for (g of roleActionGroups(); track g.name) {
                <button class="group-head" (click)="toggle('grants:' + g.name)" [attr.aria-expanded]="!isCollapsed('grants:' + g.name)">
                  <span class="group-name">{{ g.name }}</span>
                  <span class="group-count">{{ g.granted }} of {{ g.total }}</span>
                  <span class="flex-1"></span>
                  <span aria-hidden="true">{{ isCollapsed('grants:' + g.name) ? '+' : '−' }}</span>
                </button>
                @if (!isCollapsed('grants:' + g.name)) {
                  @for (a of g.actions; track a.action) {
                    <ng-container *ngTemplateOutlet="grantRow; context: { roleId: r.id, a: a, title: label(a.action), sub: a.action, desc: describe(a.action) }" />
                  }
                }
              } @empty {
                <p class="px-3 py-3 text-ink-soft m-0">{{ grantedOnly() ? 'This role has no grants that match.' : 'No actions match.' }}</p>
              }
            </div>
          } @else {
            <p class="text-ink-soft">Pick a role to see what it can do.</p>
          }
        } @else {
          @let a = selectedActionInfo();
          @if (a) {
            <div class="sheet">
              <div class="px-3 py-2.5">
                <div class="font-display font-bold text-[18px] leading-tight">{{ label(a.action) }}</div>
                <p class="mt-1 mb-0 max-w-[60ch]">{{ describe(a.action) }}</p>
                <div class="text-ink-soft mt-1">{{ a.action }}, held by {{ holderCount(a.action) }} of {{ activeRoles().length }} roles</div>
              </div>
              @for (r of holders(); track r.id) {
                <ng-container *ngTemplateOutlet="grantRow; context: { roleId: r.id, a: a, title: r.name, sub: kindLabel(r) }" />
              }
              <div class="px-3 py-2 flex items-center gap-2">
                <select #grantPick class="pick pick--unset" aria-label="Grant to another role" (change)="grantToRole(a, grantPick.value); grantPick.value = ''">
                  <option value="">Grant to another role</option>
                  @for (r of nonHolders(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
                </select>
              </div>
            </div>
          } @else {
            <p class="text-ink-soft">Pick an action to see which roles can do it.</p>
          }
        }

        <save-bar [count]="changes().length" [where]="dirtyRoleNames()" [saving]="saving()" [error]="saveError()" [stale]="stale()"
                  (save)="save()" (discard)="discard()" (reload)="reload()" />
      </div>
    </div>

    <!-- One role × action: its grants (0..n), each a scope picker plus a target picker. -->
    <ng-template #grantRow let-roleId="roleId" let-a="a" let-title="title" let-sub="sub" let-desc="desc">
      @let ds = cellDrafts(roleId, a.action);
      @let changed = isChanged(roleId, a.action);
      <div class="perm-row" [class.perm-row--changed]="changed">
        <div class="min-w-0 flex-1 pt-1">
          <div>
            @if (desc) {
              <span class="hint hint--start" [attr.data-hint]="desc" tabindex="0">{{ title }}</span>
            } @else { {{ title }} }
            <span class="text-ink-soft ml-1">{{ sub }}</span>
          </div>
          @if (changed) { <div class="was">{{ savedSummary(roleId, a) }}</div> }
        </div>
        <div class="flex flex-col items-end gap-1.5">
          @for (d of ds; track d.key; let last = $last) {
            <div class="flex flex-wrap justify-end items-center gap-1.5">
              @if (last && scopesFor(roleId, a).length > 1) {
                <button class="quiet add" (click)="addAnother(roleId, a)" aria-label="Add another scope"
                        title="Add another scope">+</button>
              }
              @if (d.effect === 'forbid') { <span class="text-rust" title="This grant denies the action instead of allowing it.">Denies</span> }
              <scope-select [options]="scopeOptions(roleId, a)" [value]="d.scopeKind" [hint]="hint(d, a)"
                            [changed]="changed" [label]="title + ': scope'" (valueChange)="setScope(d, $any($event))" />
              @if (d.scopeKind === 'specific_division') {
                <select class="pick" [class.pick--unset]="!d.scopeDivisionId" aria-label="Division"
                        [ngModel]="d.scopeDivisionId ?? ''" (ngModelChange)="setTarget(d, 'scopeDivisionId', $event)">
                  <option value="" disabled>Pick a division</option>
                  @for (x of divisions(); track x.id) { <option [value]="x.id">{{ x.name }}</option> }
                </select>
              } @else if (d.scopeKind === 'specific_team') {
                <select class="pick" [class.pick--unset]="!d.scopeTeamId" aria-label="Team"
                        [ngModel]="d.scopeTeamId ?? ''" (ngModelChange)="setTarget(d, 'scopeTeamId', $event)">
                  <option value="" disabled>Pick a team</option>
                  @for (x of teams(); track x.id) { <option [value]="x.id">{{ x.name }}</option> }
                </select>
              } @else if (d.scopeKind === 'role') {
                <select class="pick" [class.pick--unset]="!d.scopeRoleId" aria-label="Role"
                        [ngModel]="d.scopeRoleId ?? ''" (ngModelChange)="setTarget(d, 'scopeRoleId', $event)">
                  <option value="" disabled>Pick a role</option>
                  <!-- Everyone is never given or taken away, so it isn't a target. -->
                  @for (x of activeRoles(); track x.id) { @if (x.kind !== 'baseline') { <option [value]="x.id">{{ x.name }}</option> } }
                </select>
              }
            </div>
          } @empty {
            <scope-select [options]="scopeOptions(roleId, a)" value="" [unset]="true" [changed]="changed"
                          [label]="title + ': scope'" (valueChange)="add(roleId, a, $any($event))" />
          }
        </div>
      </div>
    </ng-template>
  `,
})
export class PermissionsAdminComponent implements OnDestroy {
  private readonly accessApi = inject(AccessApi);
  private readonly orgApi = inject(OrgApi);
  private readonly toast = inject(ToastService);
  private readonly unsaved = inject(UnsavedChangesService);

  readonly views: { id: View; name: string }[] = [
    { id: 'role', name: 'By role' },
    { id: 'action', name: 'By action' },
  ];

  readonly roles = signal<Role[]>([]);
  readonly saved = signal<Grant[]>([]);
  readonly drafts = signal<DraftGrant[]>([]);
  readonly catalog = signal<ActionInfo[]>([]);
  readonly divisions = signal<Division[]>([]);
  readonly teams = signal<Team[]>([]);
  readonly loadError = signal<string | null>(null);
  /** The first load has finished (or failed): until then both lists show placeholders. */
  readonly loaded = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);
  readonly saving = signal(false);

  readonly view = signal<View>('role');
  readonly selectedRoleId = signal<string | null>(null);
  readonly selectedAction = signal<string | null>(null);
  readonly roleQuery = signal('');
  readonly actionQuery = signal('');
  readonly grantedOnly = signal(false);
  /** Collapsed sections, keyed `roles:<kind>` / `actions:<group>` / `grants:<group>`. */
  private readonly collapsed = signal(new Set<string>(['roles:team']));
  private nextKey = 1;

  readonly activeRoles = computed(() => this.roles().filter((r) => r.lifecycleState === 'active'));
  readonly changes = computed(() => diffDrafts(this.saved(), this.drafts()));
  readonly cells = computed(() => changedCells(this.saved(), this.drafts()));
  readonly dirtyRoles = computed(() => new Set([...this.cells()].map((c) => c.split('|')[0])));
  readonly dirtyActions = computed(() => new Set([...this.cells()].map((c) => c.split('|')[1])));
  readonly dirtyRoleNames = computed(() => {
    const names = this.activeRoles().filter((r) => this.dirtyRoles().has(r.id)).map((r) => r.name);
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  });

  readonly selectedRole = computed(() => this.activeRoles().find((r) => r.id === this.selectedRoleId()) ?? null);
  readonly selectedActionInfo = computed(() => this.catalog().find((a) => a.action === this.selectedAction()) ?? null);

  readonly roleGroups = computed(() => {
    const q = this.roleQuery().trim().toLowerCase();
    return ROLE_KINDS.map((k) => ({
      ...k,
      roles: this.activeRoles()
        .filter((r) => r.kind === k.kind && (!q || r.name.toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.roles.length > 0);
  });

  private matchesQuery(a: ActionInfo): boolean {
    const q = this.actionQuery().trim().toLowerCase();
    return !q || a.action.includes(q) || actionLabel(a.action).toLowerCase().includes(q);
  }

  readonly actionPickGroups = computed(() =>
    groupActions(this.catalog().filter((a) => this.matchesQuery(a))),
  );

  readonly roleActionGroups = computed(() => {
    const role = this.selectedRoleId();
    if (!role) return [];
    return groupActions(this.catalog().filter((a) => this.scopesFor(role, a).length > 0))
      .map((g) => {
        const shown = g.actions.filter(
          (a) =>
            this.matchesQuery(a) &&
            (!this.grantedOnly() || this.cellDrafts(role, a.action).length > 0 || this.isChanged(role, a.action)),
        );
        return {
          name: g.name,
          total: g.actions.length,
          granted: g.actions.filter((a) => this.cellDrafts(role, a.action).length > 0).length,
          actions: shown,
        };
      })
      .filter((g) => g.actions.length > 0);
  });

  /** Roles holding the selected action now, plus any whose grant on it was just removed. */
  readonly holders = computed(() => {
    const action = this.selectedAction();
    return this.activeRoles().filter(
      (r) => this.cellDrafts(r.id, action ?? '').length > 0 || this.isChanged(r.id, action ?? ''),
    );
  });
  readonly nonHolders = computed(() => {
    const held = new Set(this.holders().map((r) => r.id));
    const a = this.selectedActionInfo();
    return this.activeRoles()
      .filter((r) => !held.has(r.id) && (!a || this.scopesFor(r.id, a).length > 0))
      .sort((x, y) => x.name.localeCompare(y.name));
  });

  constructor() {
    effect(() => this.unsaved.pending.set(this.changes().length));
    void this.load();
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.changes().length > 0) e.preventDefault();
  }

  private async load(): Promise<void> {
    try {
      const [roles, grants, actions, divisions, teams] = await Promise.all([
        firstValueFrom(this.orgApi.listRoles()),
        firstValueFrom(this.accessApi.listGrants()),
        firstValueFrom(this.accessApi.listActions()),
        firstValueFrom(this.orgApi.listDivisions()),
        firstValueFrom(this.orgApi.listTeams()),
      ]);
      this.roles.set(roles);
      this.catalog.set(actions.catalog);
      this.divisions.set(divisions.filter((d) => d.lifecycleState === 'active'));
      this.teams.set(teams.filter((t) => t.lifecycleState === 'active'));
      this.setSaved(grants);
      if (!this.selectedRoleId()) this.selectedRoleId.set(this.roleGroups()[0]?.roles[0]?.id ?? null);
      if (!this.selectedAction()) this.selectedAction.set(actions.catalog[0]?.action ?? null);
      this.loadError.set(null);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    } finally {
      this.loaded.set(true);
    }
  }

  private setSaved(grants: Grant[]): void {
    this.saved.set(grants);
    this.drafts.set(draftsFrom(grants));
  }

  // ── Reading the working copy ────────────────────────────────────────────

  cellDrafts(roleId: string, action: string): DraftGrant[] {
    return this.drafts().filter((d) => d.roleId === roleId && d.action === action);
  }
  isChanged(roleId: string, action: string): boolean {
    return this.cells().has(`${roleId}|${action}`);
  }
  grantCount(roleId: string): number {
    return this.drafts().filter((d) => d.roleId === roleId).length;
  }
  holderCount(action: string): number {
    return new Set(this.drafts().filter((d) => d.action === action).map((d) => d.roleId)).size;
  }

  label(action: string): string {
    return actionLabel(action);
  }
  describe(action: string): string {
    return actionDescription(action);
  }
  /** "Not granted" plus the scopes this role may use, each named and explained. */
  scopeOptions(roleId: string, a: ActionInfo): ScopeOption[] {
    return [
      { value: '', ...NOT_GRANTED },
      ...this.scopesFor(roleId, a).map((s) => ({
        value: s,
        name: scopeLabel(s, a),
        description: scopeHint(s, a, undefined, this.isUnitRole(roleId)),
      })),
    ];
  }
  hint(d: DraftGrant, a: ActionInfo): string {
    return scopeHint(d.scopeKind, a, this.targetName(d) ?? undefined, this.isUnitRole(d.roleId));
  }
  kindLabel(r: Role): string {
    return ROLE_KINDS.find((k) => k.kind === r.kind)?.label ?? 'Role';
  }
  kindHint(r: Role): string {
    return ROLE_KINDS.find((k) => k.kind === r.kind)?.hint ?? '';
  }
  private isUnitRole(roleId: string): boolean {
    return this.activeRoles().find((r) => r.id === roleId)?.kind === 'unit';
  }

  /**
   * The scopes a role may use for an action: a unit role `assigned`, or `own` limited
   * to its unit (unit actions only); org roles and Everyone everything else.
   */
  scopesFor(roleId: string, a: ActionInfo): ScopeKind[] {
    if (!this.isUnitRole(roleId)) return a.scopes.filter((s) => s !== 'assigned');
    return a.scopes.includes('assigned') ? a.scopes.filter((s) => s === 'assigned' || s === 'own') : [];
  }
  /** Roles carry no unit colour any more (units are memberships). */
  roleEdge(_r: Role): string | null {
    return null;
  }

  private targetName(d: Pick<DraftGrant, 'scopeDivisionId' | 'scopeTeamId' | 'scopeRoleId'>): string | null {
    if (d.scopeDivisionId) return this.divisions().find((x) => x.id === d.scopeDivisionId)?.name ?? null;
    if (d.scopeTeamId) return this.teams().find((x) => x.id === d.scopeTeamId)?.name ?? null;
    if (d.scopeRoleId) return this.roles().find((x) => x.id === d.scopeRoleId)?.name ?? null;
    return null;
  }

  /** What this role/action had before the unsaved edits, for the struck-through "was" line. */
  savedSummary(roleId: string, a: ActionInfo): string {
    const saved = this.saved().filter((g) => g.roleId === roleId && g.action === a.action);
    if (saved.length === 0) return 'Not granted';
    return saved
      .map((g) => {
        const t = this.targetName(g);
        return t ? `${scopeLabel(g.scopeKind, a)}: ${t}` : scopeLabel(g.scopeKind, a);
      })
      .join(', ');
  }

  isCollapsed(key: string): boolean {
    // Searching opens every section, so a match is never hidden in a collapsed one.
    if (key.startsWith('roles:') && this.roleQuery().trim()) return false;
    if (!key.startsWith('roles:') && this.actionQuery().trim()) return false;
    return this.collapsed().has(key);
  }
  toggle(key: string): void {
    const next = new Set(this.collapsed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.collapsed.set(next);
  }

  // ── Editing the working copy ────────────────────────────────────────────

  private newDraft(roleId: string, action: string, scopeKind: ScopeKind): DraftGrant {
    return withScope(
      {
        key: `new:${this.nextKey++}`,
        id: null,
        version: null,
        roleId,
        action,
        effect: 'permit',
        scopeKind,
        scopeDivisionId: null,
        scopeTeamId: null,
        scopeRoleId: null,
      },
      scopeKind,
    );
  }

  private edit(fn: (drafts: DraftGrant[]) => DraftGrant[]): void {
    this.drafts.set(fn(this.drafts()));
    this.saveError.set(null);
    this.stale.set(false);
  }

  add(roleId: string, a: ActionInfo, scope: ScopeKind | ''): void {
    if (!scope) return;
    this.edit((ds) => [...ds, this.restoreOrNew(roleId, a.action, scope)]);
  }

  /**
   * Re-picking a scope that the cell had when last saved restores that saved grant
   * (same id), so undoing an edit by hand leaves no change behind.
   */
  private restoreOrNew(roleId: string, action: string, scope: ScopeKind): DraftGrant {
    const inUse = new Set(this.drafts().map((d) => d.id));
    const saved = this.saved().find(
      (g) => g.roleId === roleId && g.action === action && g.scopeKind === scope && !inUse.has(g.id),
    );
    return saved ? draftsFrom([saved])[0] : this.newDraft(roleId, action, scope);
  }

  addAnother(roleId: string, a: ActionInfo): void {
    const used = new Set(this.cellDrafts(roleId, a.action).map((d) => d.scopeKind));
    const scopes = this.scopesFor(roleId, a);
    const scope = scopes.find((s) => !used.has(s) || isTargeted(s)) ?? scopes[0];
    this.edit((ds) => [...ds, this.newDraft(roleId, a.action, scope)]);
  }

  setScope(d: DraftGrant, scope: ScopeKind | ''): void {
    if (!scope) {
      this.edit((ds) => ds.filter((x) => x.key !== d.key));
      return;
    }
    const savedTwin = d.id ? this.saved().find((g) => g.id === d.id) : undefined;
    const next = savedTwin && savedTwin.scopeKind === scope ? draftsFrom([savedTwin])[0] : withScope(d, scope);
    this.edit((ds) => ds.map((x) => (x.key === d.key ? next : x)));
  }

  setTarget(d: DraftGrant, field: 'scopeDivisionId' | 'scopeTeamId' | 'scopeRoleId', id: string): void {
    this.edit((ds) => ds.map((x) => (x.key === d.key ? { ...x, [field]: id || null } : x)));
  }

  grantToRole(a: ActionInfo, roleId: string): void {
    if (!roleId) return;
    const scopes = this.scopesFor(roleId, a);
    const scope = (['own', 'own_division', 'global', 'assigned'] as ScopeKind[]).find((s) => scopes.includes(s)) ?? scopes[0];
    this.add(roleId, a, scope);
  }

  // ── Save / discard ──────────────────────────────────────────────────────

  discard(): void {
    this.drafts.set(draftsFrom(this.saved()));
    this.saveError.set(null);
    this.stale.set(false);
  }

  async reload(): Promise<void> {
    this.saveError.set(null);
    this.stale.set(false);
    await this.load();
  }

  async save(): Promise<void> {
    const incomplete = this.drafts().filter(isIncomplete).length;
    if (incomplete > 0) {
      this.saveError.set(
        `Pick a division, team or role for ${incomplete === 1 ? 'the scope' : `${incomplete} scopes`} marked with a dashed outline.`,
      );
      return;
    }
    const n = this.changes().length;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      this.setSaved(await firstValueFrom(this.accessApi.saveGrants(this.changes())));
      this.toast.success(`Saved ${n} permission ${n === 1 ? 'change' : 'changes'}`);
      this.unsaved.markSaved();
    } catch (e) {
      this.stale.set(e instanceof HttpErrorResponse && e.status === 409 && e.error?.error?.code === 'STALE_GRANT');
      this.saveError.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}
