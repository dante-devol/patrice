import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { InvitationListItem } from '../core/api.types';
import { errorMessage } from '../core/errors';

@Component({
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    @if (auth.canInvite()) {
      <div class="panel">
        <h2>Create invitation</h2>
        <label>Email (optional — binds the invite to this address)</label>
        <input type="email" [(ngModel)]="email" placeholder="invitee@example.com" />
        <button [disabled]="busy()" (click)="create()">Create invitation</button>
        @if (lastUrl()) {
          <p class="muted">Share this link: <code>{{ lastUrl() }}</code></p>
        }
        @if (error()) { <p class="error">{{ error() }}</p> }
      </div>
    }

    <div class="panel">
      <table>
        <thead>
          <tr><th>Email</th><th>Status</th><th>Uses</th><th>Expires</th><th></th></tr>
        </thead>
        <tbody>
          @for (inv of invites(); track inv.id) {
            <tr>
              <td>{{ inv.email ?? '—' }}</td>
              <td><span class="badge">{{ inv.status }}</span></td>
              <td>{{ inv.useCount }}/{{ inv.maxUses }}</td>
              <td>{{ inv.expiresAt | date: 'short' }}</td>
              <td>
                @if (inv.status === 'pending') {
                  <button class="secondary" (click)="revoke(inv.id)">Revoke</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="muted">No invitations yet.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class InvitationsComponent {
  private readonly api = inject(ApiService);
  readonly auth = inject(AuthStore);

  email = '';
  readonly invites = signal<InvitationListItem[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly lastUrl = signal<string | null>(null);

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.invites.set(await this.api.listInvitations());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.api.createInvitation({
        email: this.email || undefined,
      });
      this.lastUrl.set(created.url);
      this.email = '';
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(id: string): Promise<void> {
    try {
      await this.api.revokeInvitation(id);
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
