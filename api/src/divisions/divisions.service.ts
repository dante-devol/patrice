import { Injectable } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter } from '../common/lifecycle';
import { DomainError } from '../domain/shared/domain-error';
import { Division } from '../domain/division/division';
import { UnitOfWork, UnitOfWorkContext } from '../infrastructure/unit-of-work';
import { CreateDivisionDto, UpdateDivisionDto } from './divisions.dto';

export interface DivisionView {
  id: string;
  name: string;
  defaultOpenings: number;
  openingsLocked: boolean;
  restrictClaims: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  inherentRoleId: string;
}

function toView(d: Division): DivisionView {
  return {
    id: d.id,
    name: d.name,
    ...d.settings,
    lifecycleState: d.lifecycle.state,
    retiredAt: d.lifecycle.retiredAt,
    version: d.version,
    inherentRoleId: d.inherentRoleId,
  };
}

/**
 * Division commands (the first module on the domain layer). Each command loads the
 * aggregate, applies one domain method, and saves it inside the unit of work, which
 * writes the audit rows and any `config_version` bump. Reads query Prisma directly.
 */
@Injectable()
export class DivisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly grace: GraceService,
  ) {}

  async list(includeRetired = false): Promise<DivisionView[]> {
    const rows = await this.prisma.division.findMany({
      where: { ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
      include: { inherentRole: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      defaultOpenings: r.defaultOpenings,
      openingsLocked: r.openingsLocked,
      restrictClaims: r.restrictClaims,
      lifecycleState: r.lifecycleState,
      retiredAt: r.retiredAt,
      version: r.version,
      inherentRoleId: r.inherentRole!.id,
    }));
  }

  async create(actorUserId: string, dto: CreateDivisionDto): Promise<DivisionView> {
    return this.uow.run(actorUserId, async ({ divisions }) => {
      const d = Division.create(dto.name, dto);
      await divisions.insert(d);
      return toView(d);
    });
  }

  async update(id: string, actorUserId: string, dto: UpdateDivisionDto): Promise<DivisionView> {
    const { version, ...changes } = dto;
    return this.uow.run(actorUserId, async (ctx) => {
      const d = await this.load(ctx, id);
      if (version !== undefined && version !== d.version) {
        throw new DomainError('STALE_VERSION', 'The division changed since it was read; reload and retry');
      }
      d.update(changes);
      await ctx.divisions.save(d);
      return toView(d);
    });
  }

  async retire(id: string, actorUserId: string): Promise<DivisionView> {
    return this.uow.run(actorUserId, async (ctx) => {
      const d = await this.load(ctx, id);
      d.retire(new Date());
      await ctx.divisions.save(d);
      return toView(d);
    });
  }

  async revive(id: string, actorUserId: string): Promise<DivisionView> {
    const graceMs = await this.grace.windowMs();
    return this.uow.run(actorUserId, async (ctx) => {
      const d = await this.load(ctx, id);
      d.revive(new Date(), graceMs);
      await ctx.divisions.save(d);
      return toView(d);
    });
  }

  private async load(ctx: UnitOfWorkContext, id: string): Promise<Division> {
    const d = await ctx.divisions.findById(id);
    if (!d) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    return d;
  }
}
