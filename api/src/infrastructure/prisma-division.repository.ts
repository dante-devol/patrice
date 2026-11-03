import { LifecycleState, Prisma, RoleKind } from '@prisma/client';
import { Division } from '../domain/division/division';
import { DivisionRepository } from '../domain/division/division.repository';
import { DomainError } from '../domain/shared/domain-error';
import { Lifecycle } from '../domain/shared/lifecycle';
import { EventSink } from './unit-of-work';

type DivisionRow = Prisma.DivisionGetPayload<{ include: { inherentRole: true } }>;

export function toDivision(row: DivisionRow): Division {
  if (!row.inherentRole) throw new Error(`Division ${row.id} has no inherent role`);
  return Division.restore({
    id: row.id,
    name: row.name,
    defaultOpenings: row.defaultOpenings,
    openingsLocked: row.openingsLocked,
    restrictClaims: row.restrictClaims,
    lifecycle: Lifecycle.of(row.lifecycleState, row.retiredAt),
    version: row.version,
    inherentRoleId: row.inherentRole.id,
  });
}

/** Prisma adapter for {@link DivisionRepository}, bound to one transaction. */
export class PrismaDivisionRepository implements DivisionRepository {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly sink: EventSink,
  ) {}

  async findById(id: string): Promise<Division | null> {
    const row = await this.tx.division.findUnique({
      where: { id },
      include: { inherentRole: true },
    });
    return row ? toDivision(row) : null;
  }

  async insert(d: Division): Promise<void> {
    await this.tx.division.create({
      data: {
        id: d.id,
        name: d.name,
        ...d.settings,
        lifecycleState: d.lifecycle.state,
        retiredAt: d.lifecycle.retiredAt,
      },
    });
    await this.tx.role.create({
      data: { id: d.inherentRoleId, name: d.name, kind: RoleKind.division, divisionId: d.id },
    });
    this.sink(d.pullEvents());
  }

  async save(d: Division): Promise<void> {
    const next = d.version + 1;
    const { count } = await this.tx.division.updateMany({
      where: { id: d.id, version: d.version },
      data: {
        name: d.name,
        ...d.settings,
        lifecycleState: d.lifecycle.state,
        retiredAt: d.lifecycle.retiredAt,
        version: next,
      },
    });
    if (count === 0) {
      throw new DomainError('STALE_VERSION', 'The division changed since it was read; reload and retry');
    }
    // The inherent role mirrors the division's name and lifecycle.
    await this.tx.role.update({
      where: { id: d.inherentRoleId },
      data: {
        name: d.name,
        lifecycleState: d.lifecycle.state as LifecycleState,
        retiredAt: d.lifecycle.retiredAt,
        version: { increment: 1 },
      },
    });
    d.markSaved(next);
    this.sink(d.pullEvents());
  }
}
