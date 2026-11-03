import { Division as DivisionRow, Prisma } from '@prisma/client';
import { Division } from '../domain/division/division';
import { DivisionRepository } from '../domain/division/division.repository';
import { DomainError } from '../domain/shared/domain-error';
import { Lifecycle } from '../domain/shared/lifecycle';
import { EventSink } from './unit-of-work';

export function toDivision(row: DivisionRow): Division {
  return Division.restore({
    id: row.id,
    name: row.name,
    defaultOpenings: row.defaultOpenings,
    openingsLocked: row.openingsLocked,
    restrictClaims: row.restrictClaims,
    allowCustomTemplates: row.allowCustomTemplates,
    lifecycle: Lifecycle.of(row.lifecycleState, row.retiredAt),
    version: row.version,
  });
}

/** Prisma adapter for {@link DivisionRepository}, bound to one transaction. */
export class PrismaDivisionRepository implements DivisionRepository {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly sink: EventSink,
  ) {}

  async findById(id: string): Promise<Division | null> {
    const row = await this.tx.division.findUnique({ where: { id } });
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
    d.markSaved(next);
    this.sink(d.pullEvents());
  }
}
