import { Component, ElementRef, HostListener, computed, inject, input, output } from '@angular/core';
import { Division } from '../../core/api.types';

/**
 * A team's divisions as one comparable string, so staged edits can tell a change by
 * `===`: `"all"`, or the sorted division ids joined by commas (`""` for none yet).
 */
export function divisionsKey(t: { allDivisions: boolean; divisionIds: readonly string[] }): string {
  return t.allDivisions ? 'all' : [...t.divisionIds].sort().join(',');
}

/** The API body for a key from {@link divisionsKey}. */
export function fromDivisionsKey(key: string): { allDivisions: true } | { divisionIds: string[] } {
  return key === 'all' ? { allDivisions: true } : { divisionIds: key ? key.split(',') : [] };
}

/**
 * Picks the divisions a team supports: any set of divisions, or "All divisions"
 * (which includes divisions created later). Offers active divisions, plus any retired
 * one the team already lists, so it can be kept or dropped.
 */
@Component({
  selector: 'division-picker',
  standalone: true,
  template: `
    <details class="dp" [class.is-changed]="changed()">
      <summary [attr.aria-label]="'Divisions: ' + summary()">
        <span [class.muted]="!value()">{{ summary() }}</span>
      </summary>
      <div class="dp__menu" role="group" aria-label="Divisions the team supports">
        <label class="dp__opt">
          <input type="checkbox" [checked]="isAll()" (change)="setAll(box($event))" />
          <span>All divisions <span class="muted">(new ones too)</span></span>
        </label>
        <div class="dp__rule"></div>
        @for (d of offered(); track d.id) {
          <label class="dp__opt" [class.muted]="isAll()">
            <input type="checkbox" [disabled]="isAll()" [checked]="isAll() || ids().includes(d.id)" (change)="toggle(d.id, box($event))" />
            <span>{{ d.name }}@if (d.lifecycleState === 'retired') { <span class="muted"> (retired)</span> }</span>
          </label>
        } @empty { <p class="muted dp__empty">No divisions yet.</p> }
      </div>
    </details>
  `,
  styles: `
    :host { display: block; min-width: 11rem; }
    .dp { position: relative; }
    .dp > summary {
      list-style: none; cursor: pointer; padding: 6px 26px 6px 8px; border: 1px solid var(--line);
      border-radius: 2px; background: var(--paper); position: relative; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 16rem;
    }
    .dp > summary::-webkit-details-marker { display: none; }
    .dp > summary::after { content: '▾'; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--ink-soft); }
    .dp.is-changed > summary { border-color: var(--ink); box-shadow: inset 3px 0 0 var(--ink); }
    .dp__menu {
      position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 100%; max-height: 18rem; overflow: auto;
      background: var(--paper); border: 1px solid var(--line); border-radius: 2px; box-shadow: var(--float-shadow); padding: 6px 0;
    }
    .dp__opt { display: flex; gap: 8px; align-items: center; padding: 5px 12px; white-space: nowrap; cursor: pointer;
               color: var(--ink); font-size: 13px; margin: 0; }
    .dp__opt.muted { color: var(--ink-soft); }
    .dp__opt:hover { background: var(--paper-hover); }
    .dp__opt input { width: auto; margin: 0; }
    .dp__rule { border-top: 1px solid var(--line); margin: 4px 0; }
    .dp__empty { padding: 4px 12px; margin: 0; }
  `,
})
export class DivisionPickerComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Every division (retired ones are offered only when already chosen). */
  readonly divisions = input.required<Division[]>();
  /** A key from {@link divisionsKey}. */
  readonly value = input.required<string>();
  /** Marks the picker as holding an unsaved change. */
  readonly changed = input(false);
  readonly valueChange = output<string>();

  readonly isAll = computed(() => this.value() === 'all');
  readonly ids = computed(() => (this.isAll() || !this.value() ? [] : this.value().split(',')));
  readonly offered = computed(() =>
    this.divisions()
      .filter((d) => d.lifecycleState === 'active' || this.ids().includes(d.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  readonly summary = computed(() => {
    if (this.isAll()) return 'All divisions';
    const names = this.divisions()
      .filter((d) => this.ids().includes(d.id))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    return names.length ? names.join(', ') : 'Divisions…';
  });

  box(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  setAll(on: boolean): void {
    this.valueChange.emit(on ? 'all' : '');
  }

  toggle(id: string, on: boolean): void {
    const next = on ? [...this.ids(), id] : this.ids().filter((x) => x !== id);
    this.valueChange.emit(divisionsKey({ allDivisions: false, divisionIds: next }));
  }

  /** Close the menu on a click elsewhere, or Escape. */
  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
    if (!this.host.nativeElement.contains(e.target as Node)) this.close();
  }

  @HostListener('keydown.escape')
  close(): void {
    this.host.nativeElement.querySelector('details')?.removeAttribute('open');
  }
}
