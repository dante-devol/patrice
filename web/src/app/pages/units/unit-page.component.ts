import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { OrgApi, UnitKind } from '../../core/api/org.api';
import { AssignableRole, Member, UnitRoleAssignment, UnitStats } from '../../core/api.types';
import { LookupStore } from '../../core/lookup.store';
import { errorMessage } from '../../core/errors';
import { ToastService } from '../../core/toast.service';
import { TaskListComponent } from '../tasks/task-list.component';
import { UserAvatarComponent } from '../tasks/user-avatar.component';
import { WeeklyChartComponent } from './weekly-chart.component';

interface LeadershipGroup {
  roleId: string;
  roleName: string;
  holders: UnitRoleAssignment[];
}

/**
 * The division page (`/divisions/:id`) and the team page (`/teams/:id`): the unit's
 * stats over the tasks you can see, its leadership (unit-role holders), its members
 * and its tasks. Assign and unassign controls appear only for the roles the API says
 * you may assign there.
 */
@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, TaskListComponent, UserAvatarComponent, WeeklyChartComponent],
  template: `
    <div class="tasks-board font-sans pb-12">
      @if (error()) { <p class="text-[13px] text-rust mb-3">{{ error() }}</p> }

      <!-- Header -->
      <div class="paper p-5 mb-6 relative overflow-hidden">
        <span class="absolute left-0 top-0 bottom-0 w-[3px]" [style.background]="spine()"></span>
        <div class="text-[13px] text-ink-soft">
          @if (kind() === 'team' && parentDivisionId()) {
            Team in <a [routerLink]="['/divisions', parentDivisionId()]" class="font-bold hover:underline"
                       [style.color]="spine()">{{ lookup.divisionName(parentDivisionId()!) }}</a>
          } @else {
            Division
          }
        </div>
        <h1 class="font-display font-bold text-[28px] leading-tight mt-0.5">{{ name() }}</h1>
        @if (kind() === 'division' && childTeams().length) {
          <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[13px]">
            @for (t of childTeams(); track t.id) {
              <a [routerLink]="['/teams', t.id]" class="hover:underline" [style.color]="lookup.teamColor(t.id)">{{ t.name }}</a>
            }
          </div>
        }
      </div>

      <!-- Stats -->
      @if (stats(); as s) {
        <div class="flex items-baseline gap-3 mb-2">
          <h2 class="font-display font-bold text-[18px]">Last 12 weeks</h2>
          <span class="text-[13px] text-ink-soft">Counts include only tasks you can see@if (s.truncated) {, and only the newest 5,000}</span>
        </div>
        <div class="paper p-5 mb-6">
          <dl class="flex flex-wrap gap-x-8 gap-y-3 text-[13px] mb-5">
            @for (c of counts(); track c.label) {
              <div>
                <dt class="text-ink-soft">{{ c.label }}</dt>
                <dd class="font-display font-bold text-[20px] leading-tight mt-0.5">{{ c.value }}</dd>
              </div>
            }
            <div class="border-l-[3px] border-double border-margin pl-8 flex flex-wrap gap-x-8 gap-y-3">
              @for (m of medians(); track m.label) {
                <div>
                  <dt class="text-ink-soft">{{ m.label }}</dt>
                  <dd class="font-display font-bold text-[20px] leading-tight mt-0.5">{{ m.value }}</dd>
                </div>
              }
            </div>
          </dl>
          <weekly-chart [weeks]="s.weekly" />
        </div>

        @if (s.teams?.length) {
          <h2 class="font-display font-bold text-[18px] mb-2">Teams</h2>
          <div class="sheet mb-6">
            @for (t of s.teams; track t.teamId) {
              <a [routerLink]="['/teams', t.teamId]" class="sheet-row--link flex items-center justify-between px-4 py-2.5 relative">
                <span class="absolute left-0 top-0 bottom-0 w-[3px]" [style.background]="lookup.teamColor(t.teamId)"></span>
                <span class="font-display font-bold text-[16px]">{{ t.name }}</span>
                <span class="text-[13px] text-ink-soft">{{ t.open }} open, {{ t.completed }} done</span>
              </a>
            }
          </div>
        }
      }

      <!-- Leadership -->
      <div class="flex items-baseline gap-3 mb-2">
        <h2 class="font-display font-bold text-[18px]">Leadership</h2>
        @if (kind() === 'team' && parentDivisionId()) {
          <span class="text-[13px] text-ink-soft">The division's leads also lead this team</span>
        }
      </div>
      <div class="sheet mb-2">
        @for (g of leadership(); track g.roleId) {
          <div class="px-4 py-2.5 flex items-start gap-4">
            <span class="text-[13px] text-ink-soft w-32 shrink-0 pt-1">{{ g.roleName }}</span>
            <div class="flex flex-wrap gap-x-5 gap-y-2">
              @for (a of g.holders; track a.id) {
                <span class="flex items-center gap-2 text-[13px]">
                  <user-avatar [name]="lookup.userName(a.userId)" [seed]="a.userId" [size]="24" [imageUrl]="lookup.userAvatar(a.userId)" />
                  {{ lookup.userName(a.userId) }}
                  @if (canAssign(a.roleId)) {
                    <button class="quiet danger text-[13px]" (click)="unassign(a)" [disabled]="busy()">Remove</button>
                  }
                </span>
              }
            </div>
          </div>
        } @empty {
          <div class="px-4 py-4 text-[13px] text-ink-soft">No one holds a role here yet.</div>
        }
      </div>
      @if (assignable().length) {
        <div class="flex flex-wrap items-end gap-3 mb-6 text-[13px]">
          <label class="block">
            <span class="text-ink-soft">Person</span>
            <select [(ngModel)]="pickUser" class="field mt-1" aria-label="Person">
              <option [ngValue]="''">Choose a person</option>
              @for (u of lookup.userList(); track u.id) { <option [ngValue]="u.id">{{ u.displayName }}</option> }
            </select>
          </label>
          <label class="block">
            <span class="text-ink-soft">Role</span>
            <select [(ngModel)]="pickRole" class="field mt-1" aria-label="Role">
              @for (r of assignable(); track r.id) { <option [ngValue]="r.id">{{ r.name }}</option> }
            </select>
          </label>
          <button class="rounded border border-line bg-paper font-bold px-3.5 py-2 hover:bg-paper-hover disabled:opacity-50"
                  (click)="assign()" [disabled]="busy() || !pickUser || !pickRole">Assign</button>
          <span class="text-ink-soft pb-2">Assigning someone also makes them a member.</span>
        </div>
      } @else {
        <div class="mb-6"></div>
      }

      <!-- Members -->
      <h2 class="font-display font-bold text-[18px] mb-2">Members <span class="font-sans font-normal text-[13px] text-ink-soft">{{ members().length }}</span></h2>
      <div class="sheet mb-8">
        @if (members().length) {
          <div class="px-4 py-3 flex flex-wrap gap-x-5 gap-y-2">
            @for (m of members(); track m.userId) {
              <span class="flex items-center gap-2 text-[13px]">
                <user-avatar [name]="lookup.userName(m.userId)" [seed]="m.userId" [size]="22" [imageUrl]="lookup.userAvatar(m.userId)" />
                {{ lookup.userName(m.userId) }}
              </span>
            }
          </div>
        } @else {
          <div class="px-4 py-4 text-[13px] text-ink-soft">No members yet.</div>
        }
      </div>

      <!-- Tasks: recreated per unit so the presets apply. -->
      @for (key of [unitKey()]; track key) {
        @if (kind() === 'division') {
          <task-list [embedded]="true" [division]="id()" />
        } @else if (parentDivisionId()) {
          <task-list [embedded]="true" [division]="parentDivisionId()!" [team]="id()" />
        }
      }
    </div>
  `,
  styles: [
    `.field { padding: 7px 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 2px; color: var(--ink); font: inherit; min-width: 200px; }
     .field:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }`,
  ],
})
export class UnitPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly orgApi = inject(OrgApi);
  private readonly toast = inject(ToastService);
  readonly lookup = inject(LookupStore);

  readonly kind = signal<UnitKind>('division');
  readonly id = signal('');
  readonly unitKey = computed(() => `${this.kind()}:${this.id()}`);
  readonly stats = signal<UnitStats | null>(null);
  readonly assignments = signal<UnitRoleAssignment[]>([]);
  readonly assignable = signal<AssignableRole[]>([]);
  readonly members = signal<Member[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  pickUser = '';
  pickRole = '';

  readonly parentDivisionId = computed(() =>
    this.kind() === 'team' ? (this.lookup.teamList().find((t) => t.id === this.id())?.divisionId ?? null) : this.id(),
  );
  readonly name = computed(() =>
    this.kind() === 'division' ? this.lookup.divisionName(this.id()) : this.lookup.teamName(this.id()),
  );
  readonly spine = computed(() => {
    const div = this.parentDivisionId();
    return div ? this.lookup.divisionColor(div) : '#a7aba3';
  });
  readonly childTeams = computed(() => this.lookup.teamList().filter((t) => t.divisionId === this.id()));

  readonly counts = computed(() => {
    const s = this.stats();
    if (!s) return [];
    return [
      { label: 'Open', value: s.byStatus.open },
      { label: 'Claimed', value: s.byStatus.claimed },
      { label: 'In review', value: s.byStatus.review },
      { label: 'Revising', value: s.byStatus.revising },
      { label: 'Approved', value: s.byStatus.approved },
      { label: 'Done', value: s.completed },
    ];
  });
  readonly medians = computed(() => {
    const s = this.stats();
    if (!s) return [];
    return [
      { label: 'Median time to finish', value: days(s.medianDaysToComplete) },
      { label: 'Oldest open task', value: days(s.openAge.oldestDays) },
      { label: 'Median review wait', value: days(s.medianReviewDays) },
    ];
  });

  readonly leadership = computed<LeadershipGroup[]>(() => {
    const groups = new Map<string, LeadershipGroup>();
    for (const a of this.assignments()) {
      let g = groups.get(a.roleId);
      if (!g) {
        g = { roleId: a.roleId, roleName: a.roleName, holders: [] };
        groups.set(a.roleId, g);
      }
      g.holders.push(a);
    }
    return [...groups.values()].sort((x, y) => x.roleName.localeCompare(y.roleName));
  });

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((params) => {
      this.kind.set(this.route.snapshot.data['kind'] as UnitKind);
      this.id.set(params.get('id') ?? '');
      void this.load();
    });
  }

  canAssign(roleId: string): boolean {
    return this.assignable().some((r) => r.id === roleId);
  }

  private async load(): Promise<void> {
    const kind = this.kind();
    const id = this.id();
    this.error.set(null);
    this.stats.set(null);
    try {
      await this.lookup.ensureLoaded();
      const [stats, assignments, assignable, members] = await Promise.all([
        firstValueFrom(this.orgApi.unitStats(kind, id)),
        firstValueFrom(this.orgApi.listRoleAssignments(kind, id)),
        firstValueFrom(this.orgApi.assignableRoles(kind, id)),
        firstValueFrom(this.orgApi.listUnitMembers(kind, id)),
      ]);
      this.stats.set(stats);
      this.assignments.set(assignments);
      this.assignable.set(assignable);
      this.members.set(members);
      this.pickRole = assignable[0]?.id ?? '';
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private async refreshPeople(): Promise<void> {
    const [assignments, members] = await Promise.all([
      firstValueFrom(this.orgApi.listRoleAssignments(this.kind(), this.id())),
      firstValueFrom(this.orgApi.listUnitMembers(this.kind(), this.id())),
    ]);
    this.assignments.set(assignments);
    this.members.set(members);
  }

  async assign(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.orgApi.assignRole(this.kind(), this.id(), this.pickUser, this.pickRole));
      this.pickUser = '';
      await this.refreshPeople();
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async unassign(a: UnitRoleAssignment): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.orgApi.unassignRole(this.kind(), this.id(), a.id));
      await this.refreshPeople();
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

function days(n: number | null): string {
  if (n === null) return '—';
  return n === 1 ? '1 day' : `${n} days`;
}
