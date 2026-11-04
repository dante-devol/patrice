import { AuthApi } from '../core/api/auth.api';
import { firstValueFrom } from 'rxjs';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { errorMessage } from '../core/errors';

/** Confirms an email-change token from the link mailed to the new address. */
@Component({
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="panel auth">
      <h2>Confirm new email</h2>
      @if (confirming()) { <p class="muted">Confirming…</p> }
      @else if (confirmed()) {
        <p class="muted">Your email address has been changed. <a routerLink="/login">Log in</a>.</p>
      } @else {
        <p class="error">{{ error() }}</p>
      }
    </div>
  `,
})
export class ConfirmEmailChangeComponent {
  private readonly authApi = inject(AuthApi);
  private readonly route = inject(ActivatedRoute);

  readonly confirming = signal(true);
  readonly confirmed = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.confirm(this.route.snapshot.queryParamMap.get('token') ?? '');
  }

  private async confirm(token: string): Promise<void> {
    try {
      await firstValueFrom(this.authApi.confirmEmailChange(token));
      this.confirmed.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.confirming.set(false);
    }
  }
}
