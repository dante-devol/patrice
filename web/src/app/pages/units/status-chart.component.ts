import { Component, computed, input, signal } from '@angular/core';
import { TaskState, UnitStats } from '../../core/api.types';

/**
 * The stack, bottom to top: finished work at the base, open work on top, retired
 * apart. The states are ordered stages, so they take one blue ramp (validated with
 * the dataviz validator, `--ordinal`, light surface), lightest for done so finished
 * work recedes; retired is a neutral grey outside the ramp.
 */
export const STATE_ORDER: readonly TaskState[] = ['done', 'approved', 'revising', 'review', 'claimed', 'open', 'retired'];
export const STATE_COLOR: Record<TaskState, string> = {
  done: '#86b6ef',
  approved: '#5598e7',
  revising: '#2a78d6',
  review: '#1c5cab',
  claimed: '#104281',
  open: '#0d2a52',
  retired: '#C9CCD1',
};
export const STATE_LABEL: Record<TaskState, string> = {
  open: 'Open',
  claimed: 'Claimed',
  review: 'In review',
  revising: 'Revising',
  approved: 'Approved',
  done: 'Done',
  retired: 'Retired',
};

const W = 720;
const H = 230;
const M = { top: 10, right: 12, bottom: 24, left: 40 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

interface Band {
  state: TaskState;
  path: string;
  edge: string;
}

/**
 * How many tasks were in each state over time, as a stacked area chart; in
 * proportional mode each point is scaled to 100%. Hovering shows that week's numbers.
 */
@Component({
  selector: 'status-chart',
  standalone: true,
  template: `
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-soft mb-2" aria-hidden="true">
      @for (s of legend(); track s) {
        <span class="flex items-center gap-1.5"><span class="swatch" [style.background]="color(s)"></span>{{ label(s) }}</span>
      }
    </div>
    @if (empty()) {
      <div class="px-4 py-10 text-center text-[13px] text-ink-soft border border-dashed border-faint rounded">No tasks match these filters in this range.</div>
    } @else {
      <div class="relative">
        <svg [attr.viewBox]="'0 0 ' + w + ' ' + h" class="w-full block" role="img" [attr.aria-label]="ariaLabel()">
          @for (t of ticks(); track t.y) {
            <line [attr.x1]="m.left" [attr.x2]="w - m.right" [attr.y1]="t.y" [attr.y2]="t.y" stroke="#EEF0F3" stroke-width="1" />
            <text [attr.x]="m.left - 6" [attr.y]="t.y + 4" text-anchor="end" class="axis">{{ t.label }}</text>
          }
          @for (b of bands(); track b.state) {
            <path [attr.d]="b.path" [attr.fill]="color(b.state)" />
          }
          <!-- 2px surface gaps between bands. -->
          @for (b of bands(); track b.state) {
            <path [attr.d]="b.edge" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round" />
          }
          <line [attr.x1]="m.left" [attr.x2]="w - m.right" [attr.y1]="h - m.bottom" [attr.y2]="h - m.bottom" stroke="#D5D8DD" stroke-width="1" />
          @for (x of xLabels(); track x.x) {
            <text [attr.x]="x.x" [attr.y]="h - 6" [attr.text-anchor]="x.anchor" class="axis">{{ x.label }}</text>
          }
          @if (hoverIndex() !== null) {
            <line [attr.x1]="xAt(hoverIndex()!)" [attr.x2]="xAt(hoverIndex()!)" [attr.y1]="m.top" [attr.y2]="h - m.bottom"
                  stroke="#2A2D32" stroke-width="1" stroke-dasharray="3 3" />
          }
          <rect [attr.x]="m.left" [attr.y]="m.top" [attr.width]="pw" [attr.height]="ph" fill="transparent"
                (mousemove)="onMove($event)" (mouseleave)="hoverIndex.set(null)" />
        </svg>
        @if (hovered(); as p) {
          <div class="tip" [style.left.%]="p.leftPct" [class.tip--left]="p.leftPct > 60">
            <div class="font-bold mb-0.5">{{ p.label }}</div>
            @for (r of p.rows; track r.state) {
              <div class="flex items-center gap-1.5">
                <span class="swatch" [style.background]="color(r.state)"></span>
                <span class="flex-1">{{ label(r.state) }}</span>
                <span class="font-bold tabular-nums">{{ r.value }}</span>
              </div>
            }
            <div class="flex justify-between border-t border-line mt-1 pt-1"><span>Total</span><span class="font-bold">{{ p.total }}</span></div>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
     .axis { font-size: 11px; fill: #62666E; font-family: inherit; }
     .tip { position: absolute; top: 4px; transform: translateX(12px); background: var(--paper); border: 1px solid var(--line);
            border-radius: 2px; padding: 7px 10px; font-size: 12px; min-width: 150px; pointer-events: none;
            box-shadow: 0 18px 40px -16px rgba(42, 45, 50, 0.35); }
     .tip--left { transform: translateX(calc(-100% - 12px)); }`,
  ],
})
export class StatusChartComponent {
  readonly series = input.required<UnitStats['series']>();
  /** The states to draw (the status filter). */
  readonly states = input.required<readonly TaskState[]>();
  readonly proportional = input(false);

  readonly w = W;
  readonly h = H;
  readonly m = M;
  readonly pw = PW;
  readonly ph = PH;
  readonly hoverIndex = signal<number | null>(null);

  readonly stack = computed(() => STATE_ORDER.filter((s) => this.states().includes(s)));
  /** Legend reads top to bottom, like the stack. */
  readonly legend = computed(() => [...this.stack()].reverse());
  readonly totals = computed(() => this.series().map((p) => this.stack().reduce((n, s) => n + p.counts[s], 0)));
  readonly empty = computed(() => this.totals().every((t) => t === 0));

  /** Whole-number ticks for counts (1, 2 or 5 × 10^n apart), quarters for shares. */
  private readonly yStep = computed(() => (this.proportional() ? 0.25 : niceStep(Math.max(1, ...this.totals()) / 4)));
  private readonly yMax = computed(() =>
    this.proportional() ? 1 : Math.ceil(Math.max(1, ...this.totals()) / this.yStep()) * this.yStep(),
  );

  /** A point's value for a state: a count, or its share of the point's total. */
  private value(i: number, s: TaskState): number {
    const v = this.series()[i].counts[s];
    if (!this.proportional()) return v;
    const t = this.totals()[i];
    return t ? v / t : 0;
  }

  xAt(i: number): number {
    const n = this.series().length;
    return M.left + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW);
  }
  private y(v: number): number {
    return M.top + PH - (v / this.yMax()) * PH;
  }

  readonly bands = computed<Band[]>(() => {
    const n = this.series().length;
    const base = new Array<number>(n).fill(0);
    const bands: Band[] = [];
    for (const s of this.stack()) {
      const lower = [...base];
      for (let i = 0; i < n; i++) base[i] += this.value(i, s);
      const top = base.map((v, i) => `${this.xAt(i)},${this.y(v)}`);
      const bottom = lower.map((v, i) => `${this.xAt(i)},${this.y(v)}`).reverse();
      bands.push({ state: s, path: `M${top.join(' L')} L${bottom.join(' L')} Z`, edge: `M${top.join(' L')}` });
    }
    return bands;
  });

  readonly ticks = computed(() => {
    const step = this.yStep();
    const steps = Math.round(this.yMax() / step);
    return Array.from({ length: steps + 1 }, (_, i) => {
      const v = step * i;
      return { y: this.y(v), label: this.proportional() ? `${Math.round(v * 100)}%` : `${Math.round(v)}` };
    });
  });

  readonly xLabels = computed(() => {
    const pts = this.series();
    const every = pts.length > 8 ? 2 : 1;
    return pts
      .map((p, i) => ({ i, p }))
      .filter(({ i }) => i % every === 0 || i === pts.length - 1)
      .filter(({ i }, k, arr) => !(i === pts.length - 1 && k > 0 && i - arr[k - 1].i < every)) // avoid a crowded last label
      .map(({ i, p }) => ({
        x: this.xAt(i),
        label: i === pts.length - 1 ? 'Now' : shortDate(p.at),
        anchor: i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle',
      }));
  });

  readonly hovered = computed(() => {
    const i = this.hoverIndex();
    if (i === null) return null;
    const p = this.series()[i];
    const total = this.totals()[i];
    return {
      leftPct: (this.xAt(i) / W) * 100,
      label: i === this.series().length - 1 ? 'Now' : `Week of ${shortDate(p.at)}`,
      total,
      rows: this.legend().map((s) => ({
        state: s,
        value: this.proportional() ? `${total ? Math.round((p.counts[s] / total) * 100) : 0}%` : String(p.counts[s]),
      })),
    };
  });

  readonly ariaLabel = computed(() => {
    const last = this.series().at(-1);
    if (!last) return 'No data';
    const parts = this.legend().map((s) => `${last.counts[s]} ${STATE_LABEL[s].toLowerCase()}`);
    return `Tasks by status over time${this.proportional() ? ', as shares' : ''}. Now: ${parts.join(', ')}.`;
  });

  onMove(e: MouseEvent): void {
    const svg = (e.target as SVGRectElement).ownerSVGElement!;
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const n = this.series().length;
    const i = Math.round(((x - M.left) / PW) * (n - 1));
    this.hoverIndex.set(Math.max(0, Math.min(n - 1, i)));
  }

  color(s: TaskState): string {
    return STATE_COLOR[s];
  }
  label(s: TaskState): string {
    return STATE_LABEL[s];
  }
}

export function shortDate(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The smallest round step (1, 2 or 5 × 10^n, at least 1) at or above `v`. */
function niceStep(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
