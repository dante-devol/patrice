import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { NgxSonnerToaster } from 'ngx-sonner';
import { AuthStore } from './core/auth.store';
import { NotificationBellComponent } from './features/notifications/notification-bell.component';
import { avatarColor, initials } from './pages/tasks/task-presentation';

/**
 * App shell. The header carries the identity app-wide (web/DESIGN.md → App header): the
 * Patrice wordmark in Bricolage, the primary nav with a graphite underline on the active
 * route, and the signed-in user's avatar, wired to the real auth/nav state. `.appshell` opts the header into the scoped element reset so
 * its Tailwind-styled controls aren't touched by the global semantic styles.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NotificationBellComponent, NgxSonnerToaster],
  template: `
    <header class="appshell border-b border-line bg-board sticky top-0 z-20">
      <div class="mx-auto max-w-[1080px] px-5 h-14 flex items-center justify-between">
        <div class="flex items-center gap-6">
          <a routerLink="/home" class="font-display font-bold text-[19px] text-ink leading-none">Patrice</a>
          @if (auth.isAuthenticated()) {
            <nav class="hidden sm:flex items-center gap-5 text-[13px] text-ink-soft">
              <a routerLink="/home" routerLinkActive="!text-ink font-bold !border-ink" class="py-1 border-b-2 border-transparent hover:text-ink">Home</a>
              <a routerLink="/tasks" routerLinkActive="!text-ink font-bold !border-ink" class="py-1 border-b-2 border-transparent hover:text-ink">Tasks</a>
              @if (auth.canManageOrg()) {
                <a routerLink="/admin" routerLinkActive="!text-ink font-bold !border-ink" class="py-1 border-b-2 border-transparent hover:text-ink">Admin</a>
              }
            </nav>
          }
        </div>

        <div class="flex items-center gap-3.5 text-[13px] text-ink-soft">
          @if (auth.isAuthenticated()) {
            <app-notification-bell />
            <a routerLink="/account" routerLinkActive="text-ink" class="hidden sm:inline font-bold text-ink-soft hover:text-ink">{{ name() }}</a>
            <a routerLink="/account" title="Account" class="avatar w-7 h-7 text-[11px] overflow-hidden" [style.background]="avatarUrl() ? 'transparent' : avatarBg()">
              @if (avatarUrl()) {
                <img [src]="avatarUrl()" alt="avatar" class="w-7 h-7 rounded-full object-cover" />
              } @else {
                {{ avatarLabel() }}
              }
            </a>
            <button class="text-ink-soft hover:text-ink hover:underline" (click)="logout()">Log out</button>
          } @else {
            <a routerLink="/login" class="text-ink-soft hover:text-ink hover:underline">Log in</a>
          }
        </div>
      </div>
    </header>

    <div class="container">
      <router-outlet />
    </div>

    <ngx-sonner-toaster position="bottom-right" />
  `,
})
export class AppComponent {
  readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  readonly name = computed(() => this.auth.user()?.displayName ?? '');
  readonly avatarLabel = computed(() => initials(this.name() || '?'));
  readonly avatarBg = computed(() => avatarColor(this.auth.user()?.id ?? this.name()));
  readonly avatarUrl = computed(() => this.auth.user()?.avatarUrl ?? null);

  async logout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigate(['/login']);
  }
}
