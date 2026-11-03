import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { AccessService } from '../access/access.service';
import { SettingsService } from '../settings/settings.service';
import { DomainEvent } from '../domain/shared/aggregate';
import { DivisionRepository } from '../domain/division/division.repository';
import { PrismaDivisionRepository } from './prisma-division.repository';
import { UserAccountRepository } from '../domain/account/user-account.repository';
import { PrismaUserAccountRepository } from './prisma-user-account.repository';

/** Repositories hand the events of each saved aggregate to the unit of work. */
export type EventSink = (events: DomainEvent[]) => void;

/** What a command sees inside the unit of work. */
export interface UnitOfWorkContext {
  tx: Prisma.TransactionClient;
  divisions: DivisionRepository;
  accounts: UserAccountRepository;
}

/**
 * Runs one command in one transaction. Holding the state change, its audit rows and
 * its `config_version` bump in one place means no command can forget any of them:
 * - every event raised by a saved aggregate becomes an `activity` row, in the
 *   same transaction
 * - if any event changes policy text, `config_version` is bumped before commit
 *   and the local projection cache is dropped after commit
 */
@Injectable()
export class UnitOfWork {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
  ) {}

  async run<T>(
    actorUserId: string | null,
    work: (ctx: UnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    let policyChanged = false;
    const result = await this.prisma.$transaction(async (tx) => {
      const events: DomainEvent[] = [];
      const sink: EventSink = (e) => events.push(...e);
      const value = await work({
        tx,
        divisions: new PrismaDivisionRepository(tx, sink),
        accounts: new PrismaUserAccountRepository(tx, sink),
      });

      for (const e of events) {
        await this.activity.logActivity({
          tx,
          actorUserId,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          verb: e.type,
          payload: e.payload,
        });
      }
      policyChanged = events.some((e) => e.policyChanged);
      if (policyChanged) await this.settings.bumpConfigVersion(tx);
      return value;
    });
    if (policyChanged) this.access.invalidate();
    return result;
  }
}
