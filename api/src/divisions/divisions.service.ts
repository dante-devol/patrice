import { Injectable } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter } from '../common/lifecycle';
import { DomainError } from '../domain/shared/domain-error';
import { Division } from '../domain/division/division';
import { UnitOfWork, UnitOfWorkContext } from '../infrastructure/unit-of-work';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { divisionRef } from '../access/entity-loader';
import { CreateDivisionDto, UpdateDivisionDto } from './divisions.dto';

export interface DivisionView {
  id: string;
  name: string;
  defaultOpenings: number;
  openingsLocked: boolean;
  restrictClaims: boolean;
  allowCustomTemplates: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
}

function toView(d: Division): DivisionView {
  return {
    id: d.id,
    name: d.name,
    ...d.settings,
    lifecycleState: d.lifecycle.state,
    retiredAt: d.lifecycle.retiredAt,
    version: d.version,
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
    private readonly access: AccessService,
  ) {}

  /** The divisions the user may see (`division:read`). */
  async list(userId: string, includeRetired = false): Promise<DivisionView[]> {
    const rows = await this.prisma.division.findMany({
      where: { ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
    });
    const visible = await this.access.filterAllowed(userId, ACTIONS.divisionRead.action, rows, divisionRef);
    return visible.map((r) => ({
      id: r.id,
      name: r.name,
      defaultOpenings: r.defaultOpenings,
      openingsLocked: r.openingsLocked,
      restrictClaims: r.restrictClaims,
      allowCustomTemplates: r.allowCustomTemplates,
      lifecycleState: r.lifecycleState,
      retiredAt: r.retiredAt,
      version: r.version,
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
      await this.assertNoTeamStranded(ctx, d.id);
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

  /**
   * Retiring a division may not leave an active team with no active division: one that
   * lists it, isn't an all-division team, and lists no other active division. This
   * covers single-division teams too; retire (or widen) the team first (ADR 0020).
   */
  private async assertNoTeamStranded(ctx: UnitOfWorkContext, divisionId: string): Promise<void> {
    const stranded = await ctx.tx.team.findMany({
      where: {
        lifecycleState: LifecycleState.active,
        allDivisions: false,
        divisions: {
          some: { divisionId },
          none: { divisionId: { not: divisionId }, division: { lifecycleState: LifecycleState.active } },
        },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    if (stranded.length > 0) {
      throw new ConflictError(
        'DIVISION_SOLE_TEAM_DIVISION',
        `Retire or widen these teams first: ${stranded.map((t) => t.name).join(', ')}`,
        { teams: stranded },
      );
    }
  }

  private async load(ctx: UnitOfWorkContext, id: string): Promise<Division> {
    const d = await ctx.divisions.findById(id);
    if (!d) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    return d;
  }
}
