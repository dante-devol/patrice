import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { InviteView } from '../core/api.types';
import { errorMessage } from '../core/errors';

@Component({
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="panel">
      <h2>Accept invitation</h2>
      @if (loading()) {
        <p class="muted">Loading invitation…</p>
      } @else if (!invite()) {
        <p class="error">{{ error() }}</p>
      } @else if (invite()!.status !== 'pending') {
        <p class="error">This invitation is {{ invite()!.status }}.</p>
      } @else {
        @if (invite()!.requiresPasscode) {
          <label>Passcode</label>
          <input [(ngModel)]="passcode" autocomplete="off" />
        }
        <label>Display name</label>
        <input [(ngModel)]="displayName" />
        <label>Email</label>
        <input type="email" [(ngModel)]="email" autocomplete="username"
               [readonly]="!!invite()!.email" />
        <label>Password</label>
        <input type="password" [(ngModel)]="password" autocomplete="new-password" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button [disabled]="busy()" (click)="submit()">Create account</button>
      }
    </div>
  `,
})
export class AcceptInviteComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private token = '';
  readonly loading = signal(true);
  readonly invite = signal<InviteView | null>(null);

  passcode = '';
  displayName = '';
  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const view = await this.api.viewInvite(this.token);
      this.invite.set(view);
      if (view.email) this.email = view.email;
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const user = await this.api.acceptInvite(this.token, {
        passcode: this.invite()!.requiresPasscode ? this.passcode : undefined,
        email: this.email,
        password: this.password,
        displayName: this.displayName,
      });
      this.auth.setUser(user);
      void this.router.navigate(['/home']);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
