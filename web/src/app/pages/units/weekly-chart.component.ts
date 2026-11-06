import { Component, computed, input, signal } from '@angular/core';
import { UnitStats } from '../../core/api.types';

/** Two series, validated together (dataviz validate_palette, light surface). */
const CREATED = '#5B6FB0';
const COMPLETED = '#3E9470';

const H = 140;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const BAR = 10;
const GAP = 2;

/**
 * Created vs completed per week, as paired columns. Hovering a week shows its
 * numbers; the same data is available as a table underneath.
 */
@Component({
  selector: 'weekly-chart',
  standalone: true,
  template: `
    <div class="flex items-center gap-5 text-[13px] text-ink-soft mb-2">
      <span class="flex items-center gap-1.5"><span class="swatch" [style.background]="created"></span>Created</span>
      <span class="flex items-center gap-1.5"><span class="swatch" [style.background]="completed"></span>Completed</span>
    </div>
    <div class="relative">
      <svg [attr.viewBox]="'0 0 ' + width() + ' ' + h" class="w-full block" role="img"
           [attr.aria-label]="'Tasks created and completed per week, ' + total().created + ' created and ' + total().completed + ' completed in all'">
        <line [attr.x1]="0" [attr.x2]="width()" [attr.y1]="base" [attr.y2]="base" stroke="#D5D8DD" stroke-width="1" />
        @for (w of bars(); track w.x; let i = $index) {
          @if (w.created > 0) { <path [attr.d]="column(w.x, w.createdH)" [attr.fill]="created" /> }
          @if (w.completed > 0) { <path [attr.d]="column(w.x + bar + gap, w.completedH)" [attr.fill]="completed" /> }
          @if (i % labelEvery() === 0) {
            <text [attr.x]="w.x + bar + gap / 2" [attr.y]="h - 6" text-anchor="middle" class="axis">{{ w.label }}</text>
          }
          <rect [attr.x]="w.x - slotPad()" [attr.y]="0" [attr.width]="slot()" [attr.height]="h" fill="transparent"
                (mouseenter)="hover.set(i)" (mouseleave)="hover.set(null)" />
        }
      </svg>
      @if (hovered(); as w) {
        <div class="tip" [style.left.%]="(w.x + bar) / width() * 100">
          <div class="font-bold">Week of {{ w.label }}</div>
          <div>{{ w.created }} created</div>
          <div>{{ w.completed }} completed</div>
        </div>
      }
    </div>
    <details class="mt-2 text-[13px]">
      <summary class="text-ink-soft cursor-pointer hover:text-ink">Show as a table</summary>
      <table class="mt-2 w-full">
        <thead><tr class="text-ink-soft text-left"><th class="font-normal py-1">Week of</th><th class="font-normal">Created</th><th class="font-normal">Completed</th></tr></thead>
        <tbody>
          @for (w of bars(); track w.x) {
            <tr class="border-t border-line"><td class="py-1">{{ w.label }}</td><td>{{ w.created }}</td><td>{{ w.completed }}</td></tr>
          }
        </tbody>
      </table>
    </details>
  `,
  styles: [
    `.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
     .axis { font-size: 11px; fill: #62666E; font-family: inherit; }
     .tip { position: absolute; top: 0; transform: translateX(-50%); background: var(--paper); border: 1px solid var(--line);
            border-radius: 2px; padding: 6px 9px; font-size: 12px; white-space: nowrap; pointer-events: none;
            box-shadow: 0 18px 40px -16px rgba(42, 45, 50, 0.35); }`,
  ],
})
export class WeeklyChartComponent {
  readonly weeks = input.required<UnitStats['weekly']>();

  readonly created = CREATED;
  readonly completed = COMPLETED;
  readonly h = H;
  readonly base = H - PAD_BOTTOM;
  readonly bar = BAR;
  readonly gap = GAP;
  readonly hover = signal<number | null>(null);

  readonly slot = computed(() => 2 * BAR + GAP + 14);
  readonly slotPad = computed(() => (this.slot() - 2 * BAR - GAP) / 2);
  readonly width = computed(() => Math.max(1, this.weeks().length) * this.slot());
  readonly labelEvery = computed(() => (this.weeks().length > 8 ? 2 : 1));
  readonly total = computed(() =>
    this.weeks().reduce((t, w) => ({ created: t.created + w.created, completed: t.completed + w.completed }), { created: 0, completed: 0 }),
  );

  readonly bars = computed(() => {
    const weeks = this.weeks();
    const max = Math.max(1, ...weeks.map((w) => Math.max(w.created, w.completed)));
    const span = H - PAD_TOP - PAD_BOTTOM;
    return weeks.map((w, i) => ({
      x: i * this.slot() + this.slotPad(),
      created: w.created,
      completed: w.completed,
      createdH: (w.created / max) * span,
      completedH: (w.completed / max) * span,
      label: new Date(w.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    }));
  });
  readonly hovered = computed(() => {
    const i = this.hover();
    return i === null ? null : (this.bars()[i] ?? null);
  });

  /** A column from the baseline: square at the base, 4px rounded top (less when short). */
  column(x: number, height: number): string {
    const r = Math.min(4, height / 2, BAR / 2);
    const top = this.base - height;
    return [
      `M${x},${this.base}`,
      `V${top + r}`,
      `Q${x},${top} ${x + r},${top}`,
      `H${x + BAR - r}`,
      `Q${x + BAR},${top} ${x + BAR},${top + r}`,
      `V${this.base}`,
      'Z',
    ].join(' ');
  }
}
