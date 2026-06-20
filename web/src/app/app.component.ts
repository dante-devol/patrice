import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet, Router } from '@angular/router';
import { AuthStore } from './core/auth.store';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav class="appbar">
      <strong>Patrice</strong>
      @if (auth.isAuthenticated()) {
        <a routerLink="/home">Home</a>
        @if (auth.canInvite()) {
          <a routerLink="/invitations">Invitations</a>
        }
        @if (auth.canManageOrg()) {
          <a routerLink="/admin">Admin</a>
        }
      }
      <span class="spacer"></span>
      @if (auth.isAuthenticated()) {
        <span class="muted">{{ auth.user()?.displayName }}</span>
        <button class="secondary" (click)="logout()">Log out</button>
      } @else {
        <a routerLink="/login">Log in</a>
      }
    </nav>
    <div class="container">
      <router-outlet />
    </div>
  `,
})
export class AppComponent {
  readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigate(['/login']);
  }
}
