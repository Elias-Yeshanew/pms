import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { JobsService } from './jobs.service';
import { NotificationsService } from './notifications.service';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
class ListQuery extends PageQuery {
  @IsOptional() @Transform(bool) @IsBoolean() unread?: boolean; @IsOptional() @IsString() @MaxLength(40) type?: string; @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() includeResolved?: boolean;
}
class MarkReadBody { @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids?: string[]; @IsOptional() @IsBoolean() all?: boolean }
class PrefBody { @IsOptional() @IsBoolean() inApp?: boolean; @IsOptional() @IsBoolean() email?: boolean }

/** Notifications need no fixed permission: each person sees what their own permissions and branches allow. */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly notes: NotificationsService, private readonly jobs: JobsService) {}

  @Get('notifications') list(@Auth() a: AuthContext, @Query() q: ListQuery) { return this.notes.list(a, q); }
  @Get('notifications/unread-count') unread(@Auth() a: AuthContext) { return this.notes.unreadCount(a); }
  @Post('notifications/read') @HttpCode(200) read(@Auth() a: AuthContext, @Body() d: MarkReadBody) { return this.notes.markRead(a, d.all ? 'all' : d.ids ?? []); }
  @Get('notifications/preferences') prefs(@Auth() a: AuthContext) { return this.notes.getPreferences(a); }
  @Put('notifications/preferences/:type') setPref(@Auth() a: AuthContext, @Param('type') type: string, @Body() d: PrefBody) { return this.notes.setPreference(a, type, d); }

  @Get('jobs') @RequirePermission('jobs.run') listJobs() { return this.jobs.list(); }
  @Post('jobs/:name/run') @HttpCode(200) @RequirePermission('jobs.run') run(@Param('name') name: string) { return this.jobs.run(name); }
}
