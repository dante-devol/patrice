import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LookupStore } from '../../core/lookup.store';
import { Task } from '../../core/api.types';
import { UserAvatarComponent } from './user-avatar.component';
import { isMultiClaim, shortTaskId, stampClass, stampLabel } from './task-presentation';

/**
 * One task as a row on a ruled sheet (web/DESIGN.md → Rows): division spine, the name,
 * then the meta line — division, team, ID, the margin rule, "for {requester}" — with the
 * claimant avatars and the status stamp on the right. Used by the work board and Home.
 * The host element is the sheet's row, so it carries the alternate-row tint.
 */
@Component({
  selector: 'task-row',
  standalone: true,
  imports: [RouterLink, UserAvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block sheet-row--link' },
  template: `
    @let t = task();
    <a [routerLink]="['/tasks', t.id]" class="flex items-stretch gap-3.5 pr-4 min-h-[60px]"
       [style.--c]="lookup.divisionColor(t.divisionId)" [style.--tc]="lookup.teamColor(t.teamId)">
      <span class="spine"></span>
      <div class="min-w-0 flex-1 py-2.5">
        <h2 class="font-display font-bold text-[18px] leading-tight truncate">{{ t.name }}</h2>
        <div class="flex items-stretch gap-2.5 mt-1 text-[13px] flex-wrap">
          <span class="dtag">{{ lookup.divisionName(t.divisionId) }}</span>
          @if (t.teamId) { <span class="ttag">{{ lookup.teamName(t.teamId) }}</span> }
          <span class="text-ink-soft">{{ id() }}</span>
          <span class="margin-rule"></span>
          <span class="text-ink-soft">for {{ lookup.userName(t.requesterUserId) }}</span>
        </div>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <span class="avatar-stack">
          @for (uid of t.claimantUserIds; track uid) {
            <user-avatar [name]="lookup.userName(uid)" [seed]="uid" [size]="22" [imageUrl]="lookup.userAvatar(uid)" />
          }
          @for (p of openSlots(); track $index) {
            <user-avatar [empty]="true" [size]="22" />
          }
        </span>
        @if (multi()) {
          <span class="gauge-n -ml-1">{{ t.claimantUserIds.length }}/{{ t.openings }}</span>
        }
        <span class="stamp" [class]="stampMod()">{{ label() }}</span>
      </div>
    </a>
  `,
})
export class TaskRowComponent {
  readonly task = input.required<Task>();
  readonly lookup = inject(LookupStore);

  readonly id = computed(() => shortTaskId(this.task().id));
  readonly label = computed(() => stampLabel(this.task().statusCache));
  readonly stampMod = computed(() => stampClass(this.task().statusCache));
  readonly multi = computed(() => isMultiClaim(this.task()));
  /** Dashed circles for unclaimed openings (one for an unclaimed 1-of-1 task). */
  readonly openSlots = computed(() =>
    new Array(Math.max(0, this.task().openings - this.task().claimantUserIds.length)),
  );
}
