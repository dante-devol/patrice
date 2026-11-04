import type { IntegrationConnection } from '@prisma/client';
import type {
  ApplyResult,
  ExternalGroup,
  ExternalRoleOp,
  IntegrationSyncPort,
} from '../src/integrations/sync/integration-sync.port';

/**
 * An in-memory Discord guild behind the sync port, so e2e tests run real syncs
 * without the network. Pushes change its state the way Discord would; `down` makes
 * every call fail.
 */
export class FakeSyncPort implements IntegrationSyncPort {
  readonly provider = 'discord';
  /** externalUserId → the roles they hold. */
  readonly members = new Map<string, Set<string>>();
  readonly groups = new Set<string>();
  readonly pushes: ExternalRoleOp[] = [];
  down = false;

  /** Put a member in the guild with these roles (creating the roles). */
  member(externalUserId: string, ...roles: string[]): void {
    for (const r of roles) this.groups.add(r);
    this.members.set(externalUserId, new Set(roles));
  }

  has(externalUserId: string, role: string): boolean {
    return this.members.get(externalUserId)?.has(role) ?? false;
  }

  private check(): void {
    if (this.down) throw new Error('Discord is unreachable');
  }

  async fetchMembership(_conn: IntegrationConnection) {
    this.check();
    return new Map([...this.members].map(([id, roles]) => [id, [...roles]]));
  }

  async fetchMember(_conn: IntegrationConnection, externalUserId: string) {
    this.check();
    return [...(this.members.get(externalUserId) ?? [])];
  }

  async fetchRecentGroupChanges() {
    return new Map<string, Date>();
  }

  async fetchGroups(): Promise<ExternalGroup[]> {
    this.check();
    return [...this.groups].map((id) => ({ id, name: id }));
  }

  async applyOutbound(_conn: IntegrationConnection, ops: ExternalRoleOp[]): Promise<ApplyResult> {
    this.check();
    for (const op of ops) {
      this.pushes.push(op);
      const roles = this.members.get(op.externalUserId) ?? new Set<string>();
      if (op.action === 'add') roles.add(op.externalGroupId);
      else roles.delete(op.externalGroupId);
      this.members.set(op.externalUserId, roles);
    }
    return { applied: ops.length, failed: 0, appliedOps: ops, brokenGroupIds: [] };
  }
}
