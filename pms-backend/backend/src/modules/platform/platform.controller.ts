import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { SequenceService } from './sequence.service';
import { SettingsService } from './settings.service';

class BranchQuery { @IsOptional() @IsUUID() branchId?: string }
class SetSettingDto {
  @IsDefined() value: unknown;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class ConfigureSequenceDto {
  @IsOptional() @IsUUID() branchId?: string;
  @Matches(/^[A-Z0-9_-]{0,12}$/) prefix: string;
  @IsInt() @Min(1) @Max(12) padding: number;
  @IsIn(['never', 'yearly']) resetRule: 'never' | 'yearly';
  @IsOptional() @IsInt() @Min(1) nextValue?: number;
}

@ApiTags('Settings')
@ApiBearerAuth()
@Controller()
export class PlatformController {
  constructor(private readonly settings: SettingsService, private readonly sequences: SequenceService) {}

  @Get('settings') @RequirePermission('settings.read')
  list(@Auth() auth: AuthContext, @Query() q: BranchQuery) { return this.settings.list(auth, q.branchId); }

  @Get('settings/:key/history') @RequirePermission('settings.read')
  history(@Param('key') key: string) { return this.settings.history(key); }

  @Put('settings/:key') @RequirePermission('settings.manage')
  set(@Auth() auth: AuthContext, @Param('key') key: string, @Body() dto: SetSettingDto) {
    return this.settings.set(auth, key, dto.value, dto.branchId ?? null, dto.version, dto.reason);
  }

  @Delete('settings/:key') @RequirePermission('settings.manage')
  reset(@Auth() auth: AuthContext, @Param('key') key: string, @Query() q: BranchQuery) { return this.settings.reset(auth, key, q.branchId ?? null); }

  @Get('document-sequences') @RequirePermission('settings.read')
  listSequences() { return this.sequences.list(); }

  @Put('document-sequences/:docType') @RequirePermission('settings.manage')
  configure(@Auth() auth: AuthContext, @Param('docType') docType: string, @Body() dto: ConfigureSequenceDto) { return this.sequences.configure(auth, docType, dto); }
}
