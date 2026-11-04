import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, divisionResource, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { DivisionsService } from './divisions.service';
import {
  createDivisionSchema,
  updateDivisionSchema,
  type CreateDivisionDto,
  type UpdateDivisionDto,
} from './divisions.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

@Controller('divisions')
export class DivisionsController {
  constructor(private readonly divisions: DivisionsService) {}

  @Contract(ROUTES.listDivisions)
  @Get()
  async list(@Query('include') include: string | undefined, @CurrentUser() user: CurrentUserRef) {
    // Lists show what the caller may read; the service filters per row.
    return this.divisions.list(user.id, include === 'retired');
  }

  @Contract(ROUTES.createDivision)
  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.divisionCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createDivisionSchema)) body: CreateDivisionDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.divisions.create(user.id, body);
  }

  @Contract(ROUTES.updateDivision)
  @Patch(':id')
  // division:update resolves the Division itself (not the org): carries `retired` so
  // the Retired-as-Hard-Deny forbid blocks edits to a retired division, and the
  // division self-ref so specific_division/own_division grants can scope.
  @Authorize(ACTIONS.divisionUpdate.action, divisionResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDivisionSchema)) body: UpdateDivisionDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.divisions.update(id, user.id, body);
  }

  @Contract(ROUTES.retireDivision)
  @Post(':id/retire')
  @Authorize(ACTIONS.divisionRetire.action, divisionResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.divisions.retire(id, user.id);
  }

  @Contract(ROUTES.reviveDivision)
  @Post(':id/revive')
  @Authorize(ACTIONS.divisionRevive.action, divisionResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.divisions.revive(id, user.id);
  }
}
