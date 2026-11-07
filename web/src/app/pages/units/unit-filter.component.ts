import { Component, computed, inject, input, output } from '@angular/core';
import { TaskState } from '../../core/api.types';
import { LookupStore } from '../../core/lookup.store';
import { STATE_COLOR, STATE_LABEL, STATE_ORDER } from './status-chart.component';

/** What the division and team pages are narrowed to. Empty lists mean "any". */
export interface UnitFilter {
  states: TaskState[];
  teams: string[];
  claimants: string[];
  requesters: string[];
}

/** Retired work piles up forever, so it starts hidden. */
export const DEFAULT_STATES: TaskState[] = STATE_ORDER.filter((s) => s !== 'retired');

export function defaultFilter(): UnitFilter {
  return { states: [...DEFAULT_STATES], teams: [], claimants: [], requesters: [] };
}

/** How many filters differ from the default (shown on the Filter button). */
export function activeFilterCount(f: UnitFilter): number {
  const statesChanged = f.states.length !== DEFAULT_STATES.length || DEFAULT_STATES.some((s) => !f.states.includes(s));
  return (statesChanged ? 1 : 0) + (f.teams.length ? 1 : 0) + (f.claimants.length ? 1 : 0) + (f.requesters.length ? 1 : 0);
}

/**
 * The filter panel for a unit page: statuses, teams (a division page only), and
 * claimants and requesters. Every change is emitted whole; the page applies it to the
 * stats, the chart, the table and the task list.
 */
@Component({
  selector: 'unit-filter',
  standalone: true,
  template: `
    <div class="grid gap-x-8 gap-y-4 text-[13px]" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))">
      <fieldset>
        <legend class="text-ink-soft mb-1.5">Status</legend>
        @for (s of order; track s) {
          <label class="flex items-center gap-2 py-0.5 cursor-pointer">
            <input type="checkbox" class="m-0" [checked]="value().states.includes(s)" (change)="toggle('states', s)" />
            <span class="swatch" [style.background]="color(s)"></span>{{ label(s) }}
          </label>
        }
      </fieldset>

      @if (teams().length) {
        <fieldset>
          <legend class="text-ink-soft mb-1.5">Team <span class="text-faint">(none ticked = all)</span></legend>
          @for (t of teams(); track t.id) {
            <label class="flex items-center gap-2 py-0.5 cursor-pointer">
              <input type="checkbox" class="m-0" [checked]="value().teams.includes(t.id)" (change)="toggle('teams', t.id)" />
              <span [style.color]="lookup.teamColor(t.id)" class="font-bold">{{ t.name }}</span>
            </label>
          }
        </fieldset>
      }

      @for (f of people; track f.key) {
        <fieldset>
          <legend class="text-ink-soft mb-1.5">{{ f.label }}</legend>
          <div class="flex flex-wrap gap-1.5 mb-1.5">
            @for (id of value()[f.key]; track id) {
              <span class="chip">{{ lookup.userName(id) }}
                <button type="button" class="chip-x" (click)="toggle(f.key, id)" [attr.aria-label]="'Remove ' + lookup.userName(id)">×</button>
              </span>
            } @empty { <span class="text-faint">Anyone</span> }
          </div>
          <select class="pick" [attr.aria-label]="'Add ' + f.label.toLowerCase()" (change)="add(f.key, $event)">
            <option value="">Add someone</option>
            @for (u of lookup.userList(); track u.id) {
              @if (!value()[f.key].includes(u.id)) { <option [value]="u.id">{{ u.displayName }}</option> }
            }
          </select>
        </fieldset>
      }
    </div>
    <div class="mt-3 flex items-center gap-4 text-[13px]">
      <span class="text-ink-soft">{{ summary() }}</span>
      <button type="button" class="quiet" (click)="changed.emit(reset())">Reset filters</button>
    </div>
  `,
  styles: [
    `.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
     .chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 2px; padding: 1px 4px 1px 8px; background: var(--paper); }
     .chip-x { background: none; border: 0; padding: 0 3px; color: var(--ink-soft); cursor: pointer; }
     .chip-x:hover { color: var(--ink); }
     .pick { padding: 5px 8px; background: var(--paper); border: 1px solid var(--line); border-radius: 2px; font: inherit; color: var(--ink); max-width: 100%; }
     fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }`,
  ],
})
export class UnitFilterComponent {
  readonly lookup = inject(LookupStore);
  readonly value = input.required<UnitFilter>();
  /** The division's teams; empty on a team page. */
  readonly teams = input<{ id: string; name: string }[]>([]);
  readonly changed = output<UnitFilter>();

  readonly order = [...STATE_ORDER].reverse();
  readonly people: { key: 'claimants' | 'requesters'; label: string }[] = [
    { key: 'claimants', label: 'Claimed by' },
    { key: 'requesters', label: 'Requested by' },
  ];

  readonly summary = computed(() => {
    const n = activeFilterCount(this.value());
    return n === 0 ? 'Showing every task you can see, except retired ones.' : `${n} filter${n === 1 ? '' : 's'} applied.`;
  });

  toggle(key: keyof UnitFilter, id: string): void {
    const cur = this.value()[key] as string[];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    this.changed.emit({ ...this.value(), [key]: next });
  }

  add(key: 'claimants' | 'requesters', e: Event): void {
    const el = e.target as HTMLSelectElement;
    if (el.value) this.toggle(key, el.value);
    el.value = '';
  }

  reset(): UnitFilter {
    return defaultFilter();
  }

  color(s: TaskState): string {
    return STATE_COLOR[s];
  }
  label(s: TaskState): string {
    return STATE_LABEL[s];
  }
}
