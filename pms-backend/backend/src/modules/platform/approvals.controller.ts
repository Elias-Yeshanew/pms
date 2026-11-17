import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Auth } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { ApprovalsService } from './approvals.service';

class ListQuery { @IsOptional() @IsIn(['pending', 'all']) status?: 'pending' | 'all' }
class ApproveDto { @IsOptional() @IsString() @MaxLength(500) comment?: string }
class RejectDto { @IsString() @MinLength(3) @MaxLength(500) comment: string }

/** No fixed permission here: what you see and can decide depends on the permission each request requires. */
@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get() list(@Auth() a: AuthContext, @Query() q: ListQuery) { return this.approvals.list(a, q.status ?? 'pending'); }
  @Get(':id') get(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.approvals.get(a, id); }
  @Post(':id/approve') @HttpCode(200) approve(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: ApproveDto) { return this.approvals.approve(a, id, d.comment); }
  @Post(':id/reject') @HttpCode(200) reject(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: RejectDto) { return this.approvals.reject(a, id, d.comment); }
  @Post(':id/cancel') @HttpCode(200) cancel(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.approvals.cancel(a, id); }
}
