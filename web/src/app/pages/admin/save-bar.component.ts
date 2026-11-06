import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * The admin editors' Save / Cancel bar. It appears once there is something unsaved (or a
 * save failed), floats at the bottom of the editor, and offers Reload when the failure
 * was someone else's change. One per admin tab; nothing on a tab applies before Save.
 */
@Component({
  selector: 'save-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; position: sticky; bottom: 12px; z-index: 5; margin-top: 12px; }
    .bar { background: var(--paper); border: 1px solid var(--ink); border-radius: 2px; box-shadow: var(--float-shadow); font-size: 13px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--rust); flex: none; }
  `],
  template: `
    @if (count() > 0 || error()) {
      <div class="bar" role="region" aria-label="Unsaved changes">
        <div class="flex flex-wrap items-center gap-3 px-3 py-2.5">
          @if (count() > 0) {
            <span class="dot"></span>
            <span><b>{{ count() }} unsaved {{ count() === 1 ? 'change' : 'changes' }}</b>
              @if (where()) { <span class="text-ink-soft"> in {{ where() }}</span> }</span>
          }
          <span class="flex-1"></span>
          <button class="quiet" (click)="discard.emit()" [disabled]="saving()">Cancel</button>
          <button class="!m-0" (click)="save.emit()" [disabled]="saving() || count() === 0">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
        @if (error(); as err) {
          <div class="px-3 py-2 text-rust whitespace-pre-line flex items-start gap-3 border-0 border-t border-solid border-line">
            <span class="flex-1">{{ err }}</span>
            @if (stale()) { <button class="quiet" (click)="reload.emit()">Reload</button> }
          </div>
        }
      </div>
    }
  `,
})
export class SaveBarComponent {
  readonly count = input.required<number>();
  /** What the changes touch ("Writing, Art"), shown after the count. */
  readonly where = input<string | null>(null);
  readonly saving = input(false);
  readonly error = input<string | null>(null);
  /** The error was someone else's change: offer Reload. */
  readonly stale = input(false);

  readonly save = output<void>();
  readonly discard = output<void>();
  readonly reload = output<void>();
}
