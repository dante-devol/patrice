import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { NgxSonnerToaster } from 'ngx-sonner';
import { AuthStore } from './core/auth.store';
import { NotificationBellComponent } from './features/notifications/notification-bell.component';
import { avatarColor, initials } from './pages/tasks/task-presentation';

/**
 * App shell. The header carries the drafting-board identity app-wide: the PATRICE
 * wordmark (mono, boxed), the primary nav with an accent underline on the active
 * route, and the signed-in user's avatar. It's the design-spike header, wired to the
 * real auth/nav state. `.appshell` opts the header into the scoped element reset so
 * its Tailwind-styled controls aren't touched by the global semantic styles.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NotificationBellComponent, NgxSonnerToaster],
  template: `
    <header class="appshell border-b border-line bg-board/80 backdrop-blur sticky top-0 z-20">
      <div class="mx-auto max-w-[1080px] px-5 h-14 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <a routerLink="/home" class="font-mono text-[13px] font-semibold tracking-[0.18em] text-ink border border-ink/70 rounded px-2 py-1 leading-none">PATRICE</a>
          @if (auth.isAuthenticated()) {
            <nav class="hidden sm:flex items-center gap-5 text-[13.5px] text-ink-soft">
              <a routerLink="/home" routerLinkActive="text-ink font-medium border-b-2 border-accent" class="pb-[2px] hover:text-ink">Home</a>
              <a routerLink="/tasks" routerLinkActive="text-ink font-medium border-b-2 border-accent" class="pb-[2px] hover:text-ink">Tasks</a>
              @if (auth.canManageOrg()) {
                <a routerLink="/admin" routerLinkActive="text-ink font-medium border-b-2 border-accent" class="pb-[2px] hover:text-ink">Admin</a>
              }
            </nav>
          }
        </div>

        <div class="flex items-center gap-3.5 text-[13px] text-ink-soft">
          @if (auth.isAuthenticated()) {
            <app-notification-bell />
            <a routerLink="/account" routerLinkActive="text-ink" class="hidden sm:inline font-medium text-ink-soft hover:text-ink">{{ name() }}</a>
            <a routerLink="/account" title="Account" class="avatar w-7 h-7 text-[11px] overflow-hidden" [style.background]="avatarUrl() ? 'transparent' : avatarBg()">
              @if (avatarUrl()) {
                <img [src]="avatarUrl()" alt="avatar" class="w-7 h-7 rounded-full object-cover" />
              } @else {
                {{ avatarLabel() }}
              }
            </a>
            <button class="font-mono text-[12px] text-ink-soft hover:text-ink" (click)="logout()">log out</button>
          } @else {
            <a routerLink="/login" class="font-mono text-[12.5px] text-ink-soft hover:text-ink">log in</a>
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
