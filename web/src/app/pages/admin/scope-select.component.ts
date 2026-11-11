import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';

/** One choice in a {@link ScopeSelectComponent}. */
export interface ScopeOption {
  value: string;
  name: string;
  description: string;
}

let nextId = 0;

/**
 * A dropdown whose options each carry a description, shown under the option's name
 * in the list and as a tooltip on the closed control. Native `<select>` options can't
 * show more than their name, which left the permission scopes unexplained.
 *
 * Keyboard: the button is a combobox; ↑/↓ (or Alt+↓) open the list and move through
 * it, Home/End jump, Enter or Space picks, Escape and Tab close.
 */
@Component({
  selector: 'scope-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span [class.hint]="!open()" [attr.data-hint]="open() ? null : tooltip()">
      <button type="button" class="pick ss__btn" [class.pick--unset]="unset()" [class.pick--changed]="changed()"
              role="combobox" aria-haspopup="listbox" [attr.aria-expanded]="open()" [attr.aria-controls]="listId"
              [attr.aria-label]="label()" [attr.aria-description]="tooltip()"
              [attr.aria-activedescendant]="open() ? optionId(active()) : null"
              (click)="toggle()" (keydown)="onKey($event)">
        <span class="ss__value">{{ current()?.name ?? placeholder() }}</span><span class="ss__caret" aria-hidden="true">▾</span>
      </button>
    </span>
    @if (open()) {
      <ul class="ss__menu" role="listbox" [id]="listId" [attr.aria-label]="label()">
        @for (o of options(); track o.value; let i = $index) {
          <li role="option" class="ss__opt" [id]="optionId(i)" [class.is-active]="i === active()"
              [attr.aria-selected]="o.value === value()" (mousedown)="$event.preventDefault()"
              (mouseenter)="active.set(i)" (click)="pick(o.value)">
            <span class="ss__name"><span class="ss__tick" aria-hidden="true">{{ o.value === value() ? '✓' : '' }}</span>{{ o.name }}</span>
            <span class="ss__desc">{{ o.description }}</span>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; }
    /* The editor's quiet picker look; a global rule makes every button a dark one. */
    .ss__btn { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; text-align: left;
               font: inherit; font-size: 13px; font-weight: 400; color: var(--ink); background: var(--paper);
               border: 1px solid var(--line); border-radius: 2px; padding: 4px 8px; margin: 0; }
    .ss__btn:hover { background: var(--paper); border-color: var(--faint); }
    .ss__btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
    .ss__btn.pick--unset { color: var(--ink-soft); border-style: dashed; border-color: var(--faint); }
    .ss__btn.pick--changed { border-color: var(--rust); }
    .ss__caret { color: var(--ink-soft); font-size: 11px; }
    .ss__menu {
      position: absolute; z-index: 30; top: calc(100% + 4px); right: 0; width: 22rem; max-width: calc(100vw - 32px);
      max-height: 22rem; overflow: auto; margin: 0; padding: 4px 0; list-style: none;
      background: var(--paper); border: 1px solid var(--line); border-radius: 2px; box-shadow: var(--float-shadow);
    }
    .ss__opt { display: flex; flex-direction: column; gap: 2px; padding: 7px 12px 7px 10px; cursor: pointer; }
    .ss__opt.is-active { background: var(--paper-hover); }
    .ss__opt[aria-selected='true'] .ss__name { font-weight: 700; }
    .ss__name { color: var(--ink); font-size: 13px; display: flex; gap: 6px; }
    .ss__tick { width: 12px; flex: none; }
    .ss__desc { color: var(--ink-soft); font-size: 12px; line-height: 1.4; padding-left: 18px; white-space: normal; }
  `,
})
export class ScopeSelectComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly options = input.required<ScopeOption[]>();
  readonly value = input.required<string>();
  /** Accessible name for the control. */
  readonly label = input.required<string>();
  /** Tooltip for the closed control; defaults to the chosen option's description. */
  readonly hint = input<string | null>(null);
  readonly placeholder = input('Choose…');
  readonly changed = input(false);
  readonly unset = input(false);
  readonly valueChange = output<string>();

  readonly open = signal(false);
  readonly active = signal(0);
  readonly listId = `scope-select-${nextId++}`;

  readonly current = computed(() => this.options().find((o) => o.value === this.value()) ?? null);
  readonly tooltip = computed(() => this.hint() ?? this.current()?.description ?? null);

  optionId(i: number): string {
    return `${this.listId}-${i}`;
  }

  toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  private show(): void {
    const i = this.options().findIndex((o) => o.value === this.value());
    this.active.set(Math.max(0, i));
    this.open.set(true);
    queueMicrotask(() => this.scrollActive());
  }

  close(): void {
    this.open.set(false);
  }

  pick(value: string): void {
    this.close();
    if (value !== this.value()) this.valueChange.emit(value);
  }

  onKey(e: KeyboardEvent): void {
    const n = this.options().length;
    if (!this.open()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        this.show();
      }
      return;
    }
    const move = (i: number) => {
      e.preventDefault();
      this.active.set((i + n) % n);
      this.scrollActive();
    };
    switch (e.key) {
      case 'ArrowDown': return move(this.active() + 1);
      case 'ArrowUp': return move(this.active() - 1);
      case 'Home': return move(0);
      case 'End': return move(n - 1);
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.pick(this.options()[this.active()].value);
        return;
      case 'Escape':
        e.preventDefault();
        this.close();
        return;
      case 'Tab':
        this.close();
        return;
    }
  }

  private scrollActive(): void {
    this.host.nativeElement.querySelector(`#${this.optionId(this.active())}`)?.scrollIntoView({ block: 'nearest' });
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.close();
  }
}
