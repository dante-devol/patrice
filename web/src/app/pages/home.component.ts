import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../core/auth.store';

@Component({
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="panel">
      <h2>Logged in as {{ auth.user()?.displayName }}</h2>
      <p class="muted">{{ auth.user()?.email }}</p>
      @if (auth.user()?.emailVerified === false) {
        <p class="error">
          Your email is not verified.
          <a routerLink="/verify-email">Resend verification.</a>
        </p>
      }
      @if (auth.canInvite()) {
        <p><a routerLink="/invitations">Manage invitations →</a></p>
      }
    </div>
  `,
})
export class HomeComponent {
  readonly auth = inject(AuthStore);
}
