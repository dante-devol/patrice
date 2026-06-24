import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { ExternalGroupMapping, IntegrationConnection, Role, SyncDirection } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

interface ConnectionRow extends IntegrationConnection {
  mappings: ExternalGroupMapping[];
  expanded: boolean;
  syncBusy: boolean;
  _newRoleId: string;
  _newGroupId: string;
  _newDirection: SyncDirection | '';
}

/**
 * Discord integration management (Slice 8). Admins connect guild(s), manage
 * role↔group mappings, and trigger syncs. Users link their own Discord account
 * from profile settings (not here).
 */
@Component({
  selector: 'integrations-admin',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .status-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-weight: 600;
      letter-spacing: .03em;
    }
    .status-badge.active  { border-color: var(--ok);     color: var(--ok); }
    .status-badge.broken  { border-color: var(--danger);  color: var(--danger); }
    .status-badge.disabled { border-color: var(--muted);  color: var(--muted); }
    .status-badge.retired  { border-color: var(--muted);  color: var(--muted); }

    .connection-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .connection-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      cursor: pointer;
      user-select: none;
    }
    .connection-header:hover { background: rgba(255,255,255,.03); }
    .connection-header .chevron { color: var(--muted); font-size: 12px; transition: transform .15s; }
    .connection-header .chevron.open { transform: rotate(90deg); }
    .connection-name { font-weight: 600; flex: 1; }
    .connection-meta { font-size: 12px; color: var(--muted); }

    .connection-body { border-top: 1px solid var(--border); padding: 16px; }

    .mapping-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .mapping-row:last-child { border-bottom: none; }
    .mapping-ids { font-size: 12px; color: var(--muted); font-family: monospace; }
    .broken-pill { font-size: 11px; color: var(--danger); border: 1px solid var(--danger); padding: 1px 6px; border-radius: 999px; }

    .add-mapping-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: flex-end; }
    .add-mapping-form select, .add-mapping-form input { flex: 1; min-width: 120px; margin-top: 0; }
    .add-mapping-form button { margin-top: 0; }

    .section-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; margin-top: 4px; }

    .discord-logo { width: 18px; height: 18px; opacity: .7; }
  `],
  template: `
    <div class="panel">
      <h2 style="margin:0 0 4px">Integrations</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">
        Connect external services to sync role membership. Discord is the only provider in v1.
      </p>

      @if (error()) { <p class="error">{{ error() }}</p> }

      <!-- ── Connect new guild form ────────────────────────────────── -->
      <details style="margin-bottom:16px">
        <summary style="cursor:pointer;font-weight:600;padding:4px 0">+ Connect a Discord server</summary>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;max-width:520px">
          <label>
            Server name (display)
            <input [(ngModel)]="form.displayName" placeholder="e.g. Acme Community" />
          </label>
          <label>
            Guild ID <span class="muted">(Developer Mode → right-click server → Copy Server ID)</span>
            <input [(ngModel)]="form.guildId" placeholder="1234567890123456789" style="font-family:monospace" />
          </label>
          <label>
            Bot token <span class="muted">(stored in config; used for guild member sync)</span>
            <input [(ngModel)]="form.botToken" placeholder="MTA…" type="password" style="font-family:monospace" />
          </label>
          <div>
            <button [disabled]="busy() || !form.displayName.trim() || !form.guildId.trim()" (click)="connect()">
              Connect server
            </button>
          </div>
        </div>
      </details>

      <!-- ── Connection list ──────────────────────────────────────── -->
      @if (connections().length === 0) {
        <p class="muted">No Discord servers connected yet.</p>
      }

      @for (c of connections(); track c.id) {
        <div class="connection-card">
          <!-- Header row -->
          <div class="connection-header" (click)="toggle(c)">
            <!-- Discord blurple blob icon -->
            <svg class="discord-logo" viewBox="0 0 24 24" fill="#5865F2" xmlns="http://www.w3.org/2000/svg">
              <path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
            <span class="connection-name">{{ c.displayName }}</span>
            <span class="connection-meta" style="font-family:monospace">{{ c.externalWorkspaceId }}</span>
            <span class="status-badge" [class]="statusClass(c)">{{ displayStatus(c) }}</span>
            <span class="chevron" [class.open]="c.expanded">▶</span>
          </div>

          <!-- Expanded body -->
          @if (c.expanded) {
            <div class="connection-body">

              <!-- Mappings table -->
              <div class="section-label">Role ↔ Discord role mappings</div>
              @if (c.mappings.length === 0) {
                <p class="muted" style="font-size:13px;margin:0 0 8px">No mappings yet.</p>
              } @else {
                @for (m of c.mappings; track m.id) {
                  <div class="mapping-row">
                    <span style="flex:1">{{ roleName(m.roleId) }}</span>
                    <span class="muted">↔</span>
                    <span class="mapping-ids">{{ m.externalGroupId }}</span>
                    <span class="badge">{{ m.syncDirection }}</span>
                    @if (m.isBroken) { <span class="broken-pill">broken</span> }
                    <button class="secondary" style="margin-top:0;padding:4px 10px;font-size:12px"
                            (click)="deleteMapping(c, m)">Remove</button>
                  </div>
                }
              }

              <!-- Add mapping form -->
              <div class="add-mapping-form">
                <select [(ngModel)]="c._newRoleId">
                  <option value="">Patrice role…</option>
                  @for (r of roles(); track r.id) {
                    @if (r.lifecycleState === 'active') {
                      <option [value]="r.id">{{ r.name }}</option>
                    }
                  }
                </select>
                <input [(ngModel)]="c._newGroupId" placeholder="Discord role snowflake ID"
                       style="font-family:monospace" />
                <select [(ngModel)]="c._newDirection">
                  <option value="inbound">inbound</option>
                  <option value="outbound">outbound</option>
                  <option value="bidirectional">bidirectional</option>
                </select>
                <button
                  [disabled]="busy() || !c._newRoleId || !c._newGroupId"
                  (click)="addMapping(c)">
                  Add mapping
                </button>
              </div>

              <!-- Actions row -->
              <div class="row" style="margin-top:16px;gap:8px;justify-content:flex-start">
                <button [disabled]="c.syncBusy || c.lifecycleState !== 'active'"
                        (click)="sync(c)">
                  {{ c.syncBusy ? 'Queued…' : 'Sync now' }}
                </button>
                @if (c.lifecycleState === 'active') {
                  <button class="secondary" (click)="retire(c)">Disconnect</button>
                } @else if (c.lifecycleState === 'retired') {
                  <button class="secondary" (click)="revive(c)">Reconnect</button>
                }
              </div>

            </div>
          }
        </div>
      }
    </div>
  `,
})
export class IntegrationsAdminComponent {
  private readonly api = inject(ApiService);

  readonly connections = signal<ConnectionRow[]>([]);
  readonly roles = signal<Role[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly form = { displayName: '', guildId: '', botToken: '' };

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [conns, roles] = await Promise.all([
        this.api.listIntegrations(true),
        this.api.listRoles(false),
      ]);
      const rows: ConnectionRow[] = await Promise.all(
        conns.map(async (c) => {
          const existing = this.connections().find((r) => r.id === c.id);
          const mappings = existing?.mappings ?? (await this.api.listMappings(c.id).catch(() => []));
          return {
            ...c,
            mappings,
            expanded: existing?.expanded ?? false,
            syncBusy: false,
            _newRoleId: '',
            _newGroupId: '',
            _newDirection: 'inbound',
          } as ConnectionRow;
        }),
      );
      this.connections.set(rows);
      this.roles.set(roles);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async connect(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.connectIntegration({
        provider: 'discord',
        externalWorkspaceId: this.form.guildId.trim(),
        displayName: this.form.displayName.trim(),
        config: this.form.botToken.trim() ? { botToken: this.form.botToken.trim() } : {},
      });
      this.form.displayName = '';
      this.form.guildId = '';
      this.form.botToken = '';
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async toggle(c: ConnectionRow): Promise<void> {
    c.expanded = !c.expanded;
    if (c.expanded && c.mappings.length === 0) {
      try {
        c.mappings = await this.api.listMappings(c.id);
        this.connections.update((cs) => [...cs]);
      } catch (e) {
        this.error.set(errorMessage(e));
      }
    }
  }

  async addMapping(c: ConnectionRow): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const m = await this.api.createMapping(c.id, {
        roleId: c._newRoleId,
        externalGroupId: c._newGroupId,
        syncDirection: c._newDirection as SyncDirection,
      });
      c.mappings = [...c.mappings, m];
      c._newRoleId = '';
      c._newGroupId = '';
      this.connections.update((cs) => [...cs]);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async deleteMapping(c: ConnectionRow, m: ExternalGroupMapping): Promise<void> {
    this.error.set(null);
    try {
      await this.api.deleteMapping(c.id, m.id);
      c.mappings = c.mappings.filter((x) => x.id !== m.id);
      this.connections.update((cs) => [...cs]);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async sync(c: ConnectionRow): Promise<void> {
    c.syncBusy = true;
    this.connections.update((cs) => [...cs]);
    try {
      await this.api.triggerSync(c.id);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      setTimeout(() => {
        c.syncBusy = false;
        this.connections.update((cs) => [...cs]);
      }, 2000);
    }
  }

  async retire(c: ConnectionRow): Promise<void> {
    this.error.set(null);
    try {
      await this.api.retireIntegration(c.id);
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async revive(c: ConnectionRow): Promise<void> {
    this.error.set(null);
    try {
      await this.api.reviveIntegration(c.id);
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  roleName(roleId: string): string {
    return this.roles().find((r) => r.id === roleId)?.name ?? roleId;
  }

  statusClass(c: IntegrationConnection): string {
    if (c.lifecycleState === 'retired') return 'retired';
    return c.status;
  }

  displayStatus(c: IntegrationConnection): string {
    if (c.lifecycleState === 'retired') return 'disconnected';
    return c.status;
  }
}
