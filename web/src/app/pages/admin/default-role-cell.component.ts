import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Role } from '../../core/api.types';
import { OrgApi } from '../../core/api/org.api';
import { errorMessage } from '../../core/errors';
import { ToastService } from '../../core/toast.service';

/**
 * A division's or team's default role (ADR 0022): the unit role people get when they
 * join. Picking one is staged with the rest of the row; "Give to members" hands the
 * saved default to people who joined before it was set, straight away.
 */
@Component({
  selector: 'default-role-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <span class="hint hint--start" data-hint="The unit role people get when they join. Leaving takes it back; roles they were appointed to stay.">
      <select [class.is-changed]="changed()" [ngModel]="value()" (ngModelChange)="valueChange.emit($event)" aria-label="Default role">
        <option value="">None</option>
        @for (r of roles(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
      </select>
    </span>
    @if (savedValue() && !changed() && unitId()) {
      <button class="quiet" [disabled]="busy()" (click)="give()"
              title="Give this role to current members who joined before it was the default">Give to members</button>
    }
  `,
  styles: `:host { display: inline-flex; align-items: center; gap: 6px; } select { width: auto; margin: 0; }`,
})
export class DefaultRoleCellComponent {
  private readonly orgApi = inject(OrgApi);
  private readonly toast = inject(ToastService);

  /** Active unit roles to choose from. */
  readonly roles = input.required<Role[]>();
  /** The staged value: a role id, or '' for none. */
  readonly value = input.required<string>();
  /** The saved value, which "Give to members" hands out. */
  readonly savedValue = input<string>('');
  readonly changed = input(false);
  readonly unitType = input.required<'division' | 'team'>();
  /** Unset for a unit that isn't saved yet. */
  readonly unitId = input<string | null>(null);
  readonly valueChange = output<string>();
  readonly busy = signal(false);

  async give(): Promise<void> {
    const id = this.unitId();
    if (!id) return;
    this.busy.set(true);
    try {
      const { given } = await firstValueFrom(this.orgApi.giveDefaultRole(this.unitType(), id));
      const name = this.roles().find((r) => r.id === this.savedValue())?.name ?? 'The default role';
      this.toast.success(given === 0 ? 'Every member already holds it' : `${name} given to ${given} ${given === 1 ? 'member' : 'members'}`);
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
