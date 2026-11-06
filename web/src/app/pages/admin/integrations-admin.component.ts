import { LookupStore } from '../../core/lookup.store';
import { OrgApi } from '../../core/api/org.api';
import { IntegrationsApi } from '../../core/api/work.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ExternalGroupMapping, IntegrationConnection, Role, SyncDirection } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { SaveBarComponent } from './save-bar.component';
import { StagedOp, isStale, runStaged, stagedErrorMessage } from './staged';

/** A server to connect on Save. */
interface NewConnection {
  key: string;
  displayName: string;
  guildId: string;
  botToken: string;
}

/** A mapping to add on Save. */
interface NewMapping {
  key: string;
  connectionId: string;
  /** `role:<id>`, `division:<id>` or `team:<id>`. */
  target: string;
  groupId: string;
  direction: SyncDirection;
}

type Grants = 'keep' | 'revoke';
type ConnectionOp = { op: 'retire'; grants: Grants } | { op: 'revive' };

interface ConnectionRow extends IntegrationConnection {
  mappings: ExternalGroupMapping[];
  expanded: boolean;
  syncBusy: boolean;
  /** The new mapping's target: `role:<id>`, `division:<id>` or `team:<id>`. */
  _newRoleId: string;
  _newGroupId: string;
  _newDirection: SyncDirection | '';
  /** A mapping awaiting the keep-or-revoke choice before removal. */
  _deleting: ExternalGroupMapping | null;
  /** Retiring: awaiting the keep-or-revoke choice. */
  _retiring: boolean;
}

/**
 * Discord integration management. Admins connect guild(s), manage role↔group mappings,
 * and trigger syncs. Configuration (connecting a server, adding or removing a mapping,
 * disconnecting or reconnecting) is staged until Save; Sync now, Retry and Refresh are
 * operations on the current setup and run straight away. Users link their own Discord
 * account from profile settings (not here).
 */
@Component({
  selector: 'integrations-admin',
  standalone: true,
  imports: [FormsModule, SaveBarComponent],
  styles: [`
    .status-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 2px;
      border: 1px solid var(--border);
      font-weight: 700;
    }
    .status-badge.active  { border-color: var(--ok);     color: var(--ok); }
    .status-badge.broken  { border-color: var(--danger);  color: var(--danger); }
    .status-badge.disabled { border-color: var(--muted);  color: var(--muted); }
    .status-badge.retired  { border-color: var(--muted);  color: var(--muted); }

    .connection-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 2px;
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
    .connection-header:hover { background: var(--paper-hover); }
    .connection-header .chevron { color: var(--muted); font-size: 12px; transition: transform .15s; }
    .connection-header .chevron.open { transform: rotate(90deg); }
    .connection-name { font-weight: 600; flex: 1; }
    .connection-meta { font-size: 12px; color: var(--muted); }

    .connection-body { border-top: 1px solid var(--border); padding: 16px; }

    .mapping-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .mapping-row:last-child { border-bottom: none; }
    .mapping-ids { font-size: 12px; color: var(--muted); font-family: monospace; }
    .broken-pill { font-size: 11px; color: var(--danger); border: 1px solid var(--danger); padding: 1px 6px; border-radius: 2px; }

    .add-mapping-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: flex-end; }
    .add-mapping-form select, .add-mapping-form input { flex: 1; min-width: 120px; margin-top: 0; }
    .add-mapping-form button { margin-top: 0; }

    .section-label { font-family: var(--font-display); font-weight: 700; font-size: 15px; color: var(--ink); margin-bottom: 8px; margin-top: 4px; }

    .discord-logo { width: 18px; height: 18px; opacity: .7; }

    /* ── Health panel (pinned to top) ───────────────────────────── */
    .health { border: 1px solid var(--border); border-radius: 2px; padding: 14px 16px; margin-bottom: 18px; background: var(--panel); }
    .health-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .health-head h3 { margin: 0; font-size: 14px; flex: 1; }
    .health-card { border-top: 1px solid var(--border); padding: 12px 0; }
    .health-card:first-of-type { border-top: none; }
    .health-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .health-title .name { font-weight: 600; flex: 1; }
    .health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 18px; font-size: 13px; }
    .hcell { display: flex; flex-direction: column; gap: 2px; }
    .hlabel { font-size: 13px; color: var(--muted); }
    .gw-pill { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 2px; border: 1px solid var(--border); width: fit-content; }
    .gw-pill.connected { color: var(--ok); border-color: var(--ok); }
    .gw-pill.connecting { color: var(--muted); border-color: var(--muted); }
    .gw-pill.degraded { color: #7a5b00; border-color: #a9810f; }
    .gw-pill.down { color: var(--danger); border-color: var(--danger); }
    .health-error { color: var(--danger); font-size: 12.5px; margin: 10px 0 0; }
    .health-warn { color: #7a5b00; font-size: 12.5px; margin: 8px 0 0; }
    .health-actions { display: flex; gap: 8px; margin-top: 12px; }
    .health-actions button { margin-top: 0; padding: 5px 12px; font-size: 12px; }
    .retry-pill { font-size: 11px; margin-top: 0; padding: 2px 8px; }
    .is-staged-row { box-shadow: inset 3px 0 0 var(--rust); padding-left: 8px; }
    .is-staged-row.is-removing > span:first-child { text-decoration: line-through; }
  `],
  template: `
    <div class="panel">
      <h2 style="margin:0 0 4px">Integrations</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">
        Connect external services to sync role membership. Discord is the only provider in v1.
      </p>

      @if (loadError()) { <p class="error">{{ loadError() }}</p> }

      <!-- ── Health panel (pinned to top when a connection exists) ──── -->
      @if (healthConnections().length > 0) {
        <div class="health">
          <div class="health-head">
            <h3>Integration health</h3>
            <button class="secondary" style="margin-top:0;padding:4px 10px;font-size:12px"
                    [disabled]="busy()" (click)="refreshNow()">Refresh</button>
          </div>
          @for (c of healthConnections(); track c.id) {
            <div class="health-card">
              <div class="health-title">
                <span class="name">{{ c.displayName }}</span>
                <span class="status-badge" [class]="statusClass(c)">{{ displayStatus(c) }}</span>
              </div>
              <div class="health-grid">
                <div class="hcell">
                  <span class="hlabel">Gateway</span>
                  <span class="gw-pill" [class]="c.gatewayState">{{ gatewayLabel(c) }}</span>
                </div>
                <div class="hcell">
                  <span class="hlabel">Sync</span>
                  <span>{{ syncLabel(c) }}</span>
                </div>
                <div class="hcell">
                  <span class="hlabel">Last sync</span>
                  <span>{{ c.lastSyncAt ? fmtRel(c.lastSyncAt) : 'never' }}
                    @if (c.lastSyncAt) {
                      <span class="muted">(+{{ c.lastSyncGranted }} / −{{ c.lastSyncRevoked }})</span>
                    }
                  </span>
                </div>
                <div class="hcell">
                  <span class="hlabel">Next reconcile</span>
                  <span [title]="c.nextReconcileAt ?? ''">{{ c.nextReconcileAt ? fmtRel(c.nextReconcileAt) : 'pending first sync' }}</span>
                </div>
                <div class="hcell">
                  <span class="hlabel">Linked members</span>
                  <span>{{ c.gatewayLastEventAt ? ('last event ' + fmtRel(c.gatewayLastEventAt)) : '—' }}</span>
                </div>
              </div>
              @if (c.lastError) { <p class="health-error">⚠ {{ c.lastError }}</p> }
              @if (brokenCount(c) > 0) {
                <p class="health-warn">{{ brokenCount(c) }} broken mapping(s) — expand the connection below to retry.</p>
              }
              <div class="health-actions">
                <button [disabled]="c.syncBusy || c.lifecycleState !== 'active'" (click)="sync(c)">
                  {{ c.syncBusy ? 'Queued…' : 'Sync now' }}
                </button>
                <button class="secondary" (click)="ensureExpanded(c)">Manage ↓</button>
              </div>
            </div>
          }
        </div>
      }

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
            <button class="secondary" [disabled]="!form.displayName.trim() || !form.guildId.trim()" (click)="connect()">
              Add server
            </button>
          </div>
        </div>
      </details>

      <!-- ── Servers to connect on Save ──────────────────────────────── -->
      @for (n of newConnections(); track n.key) {
        <div class="connection-card">
          <div class="connection-header is-staged-row" style="cursor:default">
            <span class="connection-name">{{ n.displayName }}</span>
            <span class="connection-meta" style="font-family:monospace">{{ n.guildId }}</span>
            <span class="staged-note">Connects on save</span>
            <button class="quiet" (click)="removeNewConnection(n.key)">Remove</button>
          </div>
        </div>
      }

      <!-- ── Connection list ──────────────────────────────────────── -->
      @if (connections().length === 0 && newConnections().length === 0) {
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
              @if (c.mappings.length === 0 && newMappingsFor(c.id).length === 0) {
                <p class="muted" style="font-size:13px;margin:0 0 8px">No mappings yet.</p>
              } @else {
                @for (m of c.mappings; track m.id) {
                  @let removal = mappingRemovals()[m.id];
                  <div class="mapping-row" [class.is-staged-row]="!!removal" [class.is-removing]="!!removal">
                    <span style="flex:1">{{ targetName(m) }}</span>
                    <span class="muted">↔</span>
                    <span class="mapping-ids">{{ m.externalGroupId }}</span>
                    <span class="badge">{{ m.syncDirection }}</span>
                    @if (removal) {
                      <span class="staged-note">Removed on save{{ m.grantedCount > 0 ? (removal.grants === 'keep' ? ', keeps ' + m.grantedCount : ', revokes ' + m.grantedCount) : '' }}</span>
                      <button class="quiet" (click)="undoRemoval(m)">Undo</button>
                    } @else {
                      @if (m.isBroken) {
                        <span class="broken-pill">broken</span>
                        <button class="secondary retry-pill" (click)="retryMapping(c, m)">Retry</button>
                      }
                      <button class="secondary" style="margin-top:0;padding:4px 10px;font-size:12px"
                              (click)="askDelete(c, m)">Remove</button>
                    }
                  </div>
                  @if (c._deleting?.id === m.id && !removal) {
                    <div class="mapping-row" style="flex-wrap:wrap;gap:8px">
                      @if (m.grantedCount > 0) {
                        <span style="flex:1 1 100%;font-size:13px">
                          This mapping granted {{ m.grantedCount }} {{ m.grantedCount === 1 ? 'person' : 'people' }} {{ targetName(m) }}.
                          When it's removed on save, keep those as regular grants, or take them away?
                        </span>
                        <button class="secondary" (click)="stageRemoval(c, m, 'keep')">Remove, keep {{ m.grantedCount }}</button>
                        <button class="quiet danger" (click)="stageRemoval(c, m, 'revoke')">Remove and revoke</button>
                      } @else {
                        <span style="flex:1">Remove this mapping on save?</span>
                        <button class="quiet danger" (click)="stageRemoval(c, m, 'keep')">Remove</button>
                      }
                      <button class="quiet" (click)="c._deleting = null">Cancel</button>
                    </div>
                  }
                }
              }
              @for (n of newMappingsFor(c.id); track n.key) {
                <div class="mapping-row is-staged-row">
                  <span style="flex:1">{{ newTargetName(n.target) }}</span>
                  <span class="muted">↔</span>
                  <span class="mapping-ids">{{ n.groupId }}</span>
                  <span class="badge">{{ n.direction }}</span>
                  <span class="staged-note">Added on save</span>
                  <button class="quiet" (click)="removeNewMapping(n.key)">Remove</button>
                </div>
              }

              <!-- Add mapping form -->
              <div class="add-mapping-form">
                <select [(ngModel)]="c._newRoleId" aria-label="What the Discord role grants">
                  <option value="">Grants…</option>
                  <optgroup label="Role">
                    @for (r of roles(); track r.id) {
                      @if (r.lifecycleState === 'active') { <option [value]="'role:' + r.id">{{ r.name }}</option> }
                    }
                  </optgroup>
                  <optgroup label="Division membership">
                    @for (d of lookup.divisionList(); track d.id) { <option [value]="'division:' + d.id">{{ d.name }}</option> }
                  </optgroup>
                  <optgroup label="Team membership">
                    @for (t of lookup.teamList(); track t.id) { <option [value]="'team:' + t.id">{{ t.name }}</option> }
                  </optgroup>
                </select>
                <input [(ngModel)]="c._newGroupId" placeholder="Discord role snowflake ID"
                       style="font-family:monospace" />
                <select [(ngModel)]="c._newDirection">
                  <option value="inbound">inbound</option>
                  <option value="outbound">outbound</option>
                  <option value="bidirectional">bidirectional</option>
                </select>
                <button class="secondary"
                  [disabled]="!c._newRoleId || !c._newGroupId"
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
                @let cop = connectionOps()[c.id];
                @if (cop) {
                  <span class="staged-note">{{ cop.op === 'revive' ? 'Reconnects on save' : (cop.grants === 'keep' ? 'Disconnects on save, keeps what it granted' : 'Disconnects on save, revokes what it granted') }}</span>
                  <button class="quiet" (click)="undoConnectionOp(c)">Undo</button>
                } @else if (c.lifecycleState === 'active' && !c._retiring) {
                  <button class="secondary" (click)="c._retiring = true">Disconnect</button>
                } @else if (c._retiring) {
                  <span style="font-size:13px">When this connection is removed after the grace period, what happens to the roles and memberships it granted?</span>
                  <button class="secondary" (click)="retire(c, 'keep')">Keep them</button>
                  <button class="quiet danger" (click)="retire(c, 'revoke')">Revoke them</button>
                  <button class="quiet" (click)="c._retiring = false">Cancel</button>
                } @else if (c.lifecycleState === 'retired') {
                  <button class="secondary" (click)="revive(c)">Reconnect</button>
                }
              </div>

            </div>
          }
        </div>
      }
    </div>
    <save-bar [count]="count()" [where]="where()" [saving]="saving()" [error]="saveError()" [stale]="stale()"
              (save)="save()" (discard)="discard()" (reload)="reload()" />
  `,
})
export class IntegrationsAdminComponent implements OnDestroy {
  private readonly integrationsApi = inject(IntegrationsApi);
  readonly lookup = inject(LookupStore);
  private readonly orgApi = inject(OrgApi);
  private readonly unsaved = inject(UnsavedChangesService);
  readonly connections = signal<ConnectionRow[]>([]);
  readonly roles = signal<Role[]>([]);
  readonly busy = signal(false);
  readonly saving = signal(false);
  /** Load and operation (sync, retry) failures. */
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);

  // ---- Staged configuration, applied on Save
  readonly newConnections = signal<NewConnection[]>([]);
  readonly newMappings = signal<NewMapping[]>([]);
  readonly mappingRemovals = signal<Record<string, { connectionId: string; grants: Grants }>>({});
  readonly connectionOps = signal<Record<string, ConnectionOp>>({});
  private nextKey = 1;

  readonly count = computed(
    () =>
      this.newConnections().length +
      this.newMappings().length +
      Object.keys(this.mappingRemovals()).length +
      Object.keys(this.connectionOps()).length,
  );
  readonly where = computed(() => {
    const ids = new Set([
      ...this.newMappings().map((m) => m.connectionId),
      ...Object.values(this.mappingRemovals()).map((r) => r.connectionId),
      ...Object.keys(this.connectionOps()),
    ]);
    const names = this.connections().filter((c) => ids.has(c.id)).map((c) => c.displayName);
    const added = this.newConnections().length;
    return [...names, ...(added ? [`${added} new`] : [])].join(', ') || null;
  });

  readonly form = { displayName: '', guildId: '', botToken: '' };

  constructor() {
    effect(() => this.unsaved.pending.set(this.count()));
    void this.lookup.ensureLoaded();
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  private async refresh(): Promise<void> {
    try {
      const [conns, roles] = await Promise.all([
        firstValueFrom(this.integrationsApi.listIntegrations(true)),
        firstValueFrom(this.orgApi.listRoles(false)),
      ]);
      const rows: ConnectionRow[] = await Promise.all(
        conns.map(async (c) => {
          const existing = this.connections().find((r) => r.id === c.id);
          const mappings = existing?.mappings ?? (await firstValueFrom(this.integrationsApi.listMappings(c.id)).catch(() => []));
          return {
            ...c,
            mappings,
            expanded: existing?.expanded ?? false,
            syncBusy: false,
            _newRoleId: '',
            _newGroupId: '',
            _newDirection: 'inbound',
            _deleting: null,
            _retiring: false,
          } as ConnectionRow;
        }),
      );
      this.connections.set(rows);
      this.roles.set(roles);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }

  /** Stage a server to connect on Save. */
  connect(): void {
    this.newConnections.update((ns) => [
      ...ns,
      {
        key: `new:${this.nextKey++}`,
        displayName: this.form.displayName.trim(),
        guildId: this.form.guildId.trim(),
        botToken: this.form.botToken.trim(),
      },
    ]);
    this.form.displayName = '';
    this.form.guildId = '';
    this.form.botToken = '';
  }

  removeNewConnection(key: string): void {
    this.newConnections.update((ns) => ns.filter((n) => n.key !== key));
  }

  async toggle(c: ConnectionRow): Promise<void> {
    c.expanded = !c.expanded;
    if (c.expanded && c.mappings.length === 0) {
      try {
        c.mappings = await firstValueFrom(this.integrationsApi.listMappings(c.id));
        this.connections.update((cs) => [...cs]);
      } catch (e) {
        this.loadError.set(errorMessage(e));
      }
    }
  }

  /** Stage a mapping to add on Save. */
  addMapping(c: ConnectionRow): void {
    this.newMappings.update((ms) => [
      ...ms,
      {
        key: `new:${this.nextKey++}`,
        connectionId: c.id,
        target: c._newRoleId,
        groupId: c._newGroupId.trim(),
        direction: (c._newDirection || 'inbound') as SyncDirection,
      },
    ]);
    c._newRoleId = '';
    c._newGroupId = '';
    this.connections.update((cs) => [...cs]);
  }

  newMappingsFor(connectionId: string): NewMapping[] {
    return this.newMappings().filter((m) => m.connectionId === connectionId);
  }

  removeNewMapping(key: string): void {
    this.newMappings.update((ms) => ms.filter((m) => m.key !== key));
  }

  /** What a staged mapping grants, by name. */
  newTargetName(target: string): string {
    const [kind, id] = target.split(':');
    if (kind === 'division') return `${this.lookup.divisionName(id)} (division)`;
    if (kind === 'team') return `${this.lookup.teamName(id)} (team)`;
    return this.roleName(id);
  }

  askDelete(c: ConnectionRow, m: ExternalGroupMapping): void {
    c._deleting = m;
    this.connections.update((cs) => [...cs]);
  }

  /** Stage removing a mapping on Save, with what happens to what it granted. */
  stageRemoval(c: ConnectionRow, m: ExternalGroupMapping, grants: Grants): void {
    this.mappingRemovals.update((rs) => ({ ...rs, [m.id]: { connectionId: c.id, grants } }));
    c._deleting = null;
    this.connections.update((cs) => [...cs]);
  }

  undoRemoval(m: ExternalGroupMapping): void {
    const { [m.id]: _undone, ...rest } = this.mappingRemovals();
    this.mappingRemovals.set(rest);
  }

  async sync(c: ConnectionRow): Promise<void> {
    c.syncBusy = true;
    this.connections.update((cs) => [...cs]);
    try {
      await firstValueFrom(this.integrationsApi.triggerSync(c.id));
    } catch (e) {
      this.loadError.set(errorMessage(e));
    } finally {
      setTimeout(() => {
        c.syncBusy = false;
        this.connections.update((cs) => [...cs]);
      }, 2000);
    }
  }

  /** Stage disconnecting on Save, with what happens to what it granted. */
  retire(c: ConnectionRow, grants: Grants): void {
    this.connectionOps.update((ops) => ({ ...ops, [c.id]: { op: 'retire', grants } }));
    c._retiring = false;
    this.connections.update((cs) => [...cs]);
  }

  /** Stage reconnecting on Save. */
  revive(c: ConnectionRow): void {
    this.connectionOps.update((ops) => ({ ...ops, [c.id]: { op: 'revive' } }));
  }

  undoConnectionOp(c: ConnectionRow): void {
    const { [c.id]: _undone, ...rest } = this.connectionOps();
    this.connectionOps.set(rest);
  }

  // ---- Save / Cancel

  discard(): void {
    this.newConnections.set([]);
    this.newMappings.set([]);
    this.mappingRemovals.set({});
    this.connectionOps.set({});
    this.saveError.set(null);
    this.stale.set(false);
  }

  async reload(): Promise<void> {
    this.discard();
    this.connections.set([]);
    await this.refresh();
  }

  async save(): Promise<void> {
    const ops: StagedOp[] = [
      ...this.newConnections().map((n) => ({
        run: () =>
          firstValueFrom(
            this.integrationsApi.connectIntegration({
              provider: 'discord',
              externalWorkspaceId: n.guildId,
              displayName: n.displayName,
              ...(n.botToken ? { botToken: n.botToken } : {}),
            }),
          ),
        clear: () => this.removeNewConnection(n.key),
      })),
      ...Object.entries(this.mappingRemovals()).map(([id, r]) => ({
        run: () => firstValueFrom(this.integrationsApi.deleteMapping(r.connectionId, id, r.grants)),
        clear: () => {
          const { [id]: _done, ...rest } = this.mappingRemovals();
          this.mappingRemovals.set(rest);
        },
      })),
      ...this.newMappings().map((n) => {
        const [kind, targetId] = n.target.split(':');
        return {
          run: () =>
            firstValueFrom(
              this.integrationsApi.createMapping(n.connectionId, {
                ...(kind === 'role' ? { roleId: targetId } : kind === 'division' ? { divisionId: targetId } : { teamId: targetId }),
                externalGroupId: n.groupId,
                syncDirection: n.direction,
              }),
            ),
          clear: () => this.removeNewMapping(n.key),
        };
      }),
      ...Object.entries(this.connectionOps()).map(([id, op]) => ({
        run: () =>
          firstValueFrom(
            op.op === 'retire'
              ? this.integrationsApi.retireIntegration(id, op.grants)
              : this.integrationsApi.reviveIntegration(id),
          ),
        clear: () => {
          const { [id]: _done, ...rest } = this.connectionOps();
          this.connectionOps.set(rest);
        },
      })),
    ];
    this.saving.set(true);
    this.saveError.set(null);
    this.stale.set(false);
    const result = await runStaged(ops);
    // Mappings are cached per row; drop them so the refresh reads what landed.
    this.connections.set([]);
    await this.refresh();
    if (result.error) {
      this.stale.set(isStale(result.error));
      this.saveError.set(stagedErrorMessage(result));
    } else {
      this.unsaved.markSaved();
    }
    this.saving.set(false);
  }

  async retryMapping(c: ConnectionRow, m: ExternalGroupMapping): Promise<void> {
    this.loadError.set(null);
    try {
      const updated = await firstValueFrom(this.integrationsApi.retryMapping(c.id, m.id));
      c.mappings = c.mappings.map((x) => (x.id === updated.id ? updated : x));
      this.connections.update((cs) => [...cs]);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }

  /** Pull the latest connection state (gateway/sync/next-reconcile are server-driven). */
  async refreshNow(): Promise<void> {
    this.busy.set(true);
    try {
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  ensureExpanded(c: ConnectionRow): void {
    if (!c.expanded) void this.toggle(c);
    this.connections.update((cs) => [...cs]);
  }

  /** What a mapping grants, by name. */
  targetName(m: ExternalGroupMapping): string {
    if (m.target.kind === 'division') return `${this.lookup.divisionName(m.target.id)} (division)`;
    if (m.target.kind === 'team') return `${this.lookup.teamName(m.target.id)} (team)`;
    return this.roleName(m.target.id);
  }

  roleName(roleId: string): string {
    return this.roles().find((r) => r.id === roleId)?.name ?? 'Unknown role';
  }

  /** Connections worth surfacing in the health panel (active, non-retired). */
  healthConnections(): ConnectionRow[] {
    return this.connections().filter((c) => c.lifecycleState === 'active');
  }

  brokenCount(c: ConnectionRow): number {
    return c.mappings.filter((m) => m.isBroken).length;
  }

  gatewayLabel(c: IntegrationConnection): string {
    switch (c.gatewayState) {
      case 'connected': return 'connected';
      case 'connecting': return 'connecting…';
      case 'degraded': return 'degraded';
      default: return 'down';
    }
  }

  syncLabel(c: IntegrationConnection): string {
    switch (c.syncState) {
      case 'running': return 'running now';
      case 'queued': return 'queued';
      default: return 'idle';
    }
  }

  /** Compact relative time, e.g. "5m ago" / "in 6h". */
  fmtRel(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now();
    const future = diffMs > 0;
    const abs = Math.abs(diffMs);
    const mins = Math.round(abs / 60000);
    let body: string;
    if (mins < 1) body = 'moments';
    else if (mins < 60) body = `${mins}m`;
    else if (mins < 1440) body = `${Math.round(mins / 60)}h`;
    else body = `${Math.round(mins / 1440)}d`;
    return future ? `in ${body}` : `${body} ago`;
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
