import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { CreateRoleDto, SetRolePermissionsDto, UpdateRoleDto } from './roles.dto';
import { RolesService } from './roles.service';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('roles') @RequirePermission('roles.read')
  list() { return this.roles.list(); }

  @Get('permissions') @RequirePermission('permissions.read')
  permissions() { return this.roles.listPermissions(); }

  @Post('roles') @RequirePermission('roles.manage')
  create(@Auth() auth: AuthContext, @Body() dto: CreateRoleDto) { return this.roles.create(auth, dto); }

  @Get('roles/:id') @RequirePermission('roles.read')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.roles.get(id); }

  @Patch('roles/:id') @RequirePermission('roles.manage')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) { return this.roles.update(auth, id, dto); }

  @Put('roles/:id/permissions') @RequirePermission('roles.manage')
  setPermissions(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolePermissionsDto) { return this.roles.setPermissions(auth, id, dto); }
}
