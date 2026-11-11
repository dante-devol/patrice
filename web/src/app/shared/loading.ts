import { Component, Input } from '@angular/core';

/**
 * Loading placeholders: grey shapes where content is about to appear, so a slow load
 * reads as "on its way" rather than "empty". They pulse gently (not at all under
 * prefers-reduced-motion; see `.skel` in styles.css), and announce themselves once to
 * screen readers through a polite status message.
 */

// Varied widths so placeholder rows don't read as a solid block.
const WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%', '58%', '69%'];
const SUB_WIDTHS = ['34%', '28%', '40%', '24%', '37%', '31%', '26%', '35%'];

/**
 * A ruled sheet of placeholder rows, shaped like task and list rows (a title line and
 * a detail line). Use it in place of the `.sheet` while its items load.
 *
 *   @if (loading()) { <loading-rows label="Loading tasks" /> } @else { <div class="sheet">…</div> }
 */
@Component({
  selector: 'loading-rows',
  standalone: true,
  template: `
    <span class="sr-only" role="status">{{ label }}…</span>
    <!-- The sheet holds only rows: its rules style every child as one. -->
    <div class="sheet" aria-hidden="true">
      @for (i of indexes; track i) {
        <div class="flex items-center gap-3.5" [class]="compact ? 'px-3 min-h-[36px] py-2' : 'px-5 min-h-[60px] py-2.5'" aria-hidden="true">
          <div class="flex-1 min-w-0 flex flex-col gap-2">
            <span class="skel h-[15px]" [style.width]="width(i)"></span>
            @if (detail) { <span class="skel h-[11px]" [style.width]="subWidth(i)"></span> }
          </div>
        </div>
      }
    </div>
  `,
})
export class LoadingRowsComponent {
  /** What's loading, for screen readers ("Loading users"). */
  @Input() label = 'Loading';
  @Input() set rows(n: number) {
    this.indexes = Array.from({ length: n }, (_, i) => i);
  }
  /** A second, shorter line per row (off for one-line lists). */
  @Input() detail = true;
  /** Short one-line rows, for side lists. */
  @Input() compact = false;
  indexes = [0, 1, 2, 3, 4];

  width(i: number): string {
    return WIDTHS[i % WIDTHS.length];
  }
  subWidth(i: number): string {
    return SUB_WIDTHS[i % SUB_WIDTHS.length];
  }
}

/**
 * Placeholder table rows, for a table's body while its rows load:
 *
 *   @if (!loaded()) { <tbody loadingRows [cols]="4" label="Loading roles"></tbody> }
 */
@Component({
  selector: 'tbody[loadingRows]',
  standalone: true,
  template: `
    @for (r of indexes; track r) {
      <tr class="skel-row">
        @for (c of colIndexes; track c) {
          <td>
            @if (r === 0 && c === 0) { <span class="sr-only" role="status">{{ label }}…</span> }
            <span class="skel h-[13px]" aria-hidden="true" [style.width]="width(r, c)"></span>
          </td>
        }
      </tr>
    }
  `,
})
export class LoadingTableRowsComponent {
  @Input() label = 'Loading';
  @Input() set rows(n: number) {
    this.indexes = Array.from({ length: n }, (_, i) => i);
  }
  @Input() set cols(n: number) {
    this.colIndexes = Array.from({ length: n }, (_, i) => i);
  }
  indexes = [0, 1, 2, 3, 4];
  colIndexes = [0, 1, 2];

  width(r: number, c: number): string {
    // The first column is the name: longest. Later columns are short values.
    return c === 0 ? WIDTHS[r % WIDTHS.length] : SUB_WIDTHS[(r + c) % SUB_WIDTHS.length];
  }
}

/** A placeholder for a single value, such as a count, while it loads. */
@Component({
  selector: 'loading-value',
  standalone: true,
  template: `<span class="skel" aria-hidden="true" [style.width]="width" [style.height]="height"></span>`,
  host: { class: 'inline-flex items-center align-middle' },
})
export class LoadingValueComponent {
  @Input() width = '1.6em';
  @Input() height = '0.8em';
}
