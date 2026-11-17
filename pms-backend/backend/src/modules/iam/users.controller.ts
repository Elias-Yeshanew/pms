import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { PageQuery } from '../../common/pagination';
import { CreateUserDto, SetRolesDto, UpdateUserDto, UsersQuery, VersionDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() @RequirePermission('users.read')
  list(@Auth() auth: AuthContext, @Query() q: UsersQuery) { return this.users.list(auth, q); }

  @Post() @RequirePermission('users.create')
  create(@Auth() auth: AuthContext, @Body() dto: CreateUserDto) { return this.users.create(auth, dto); }

  @Get(':id') @RequirePermission('users.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.users.get(auth, id); }

  @Patch(':id') @RequirePermission('users.update')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) { return this.users.update(auth, id, dto); }

  @Post(':id/deactivate') @HttpCode(200) @RequirePermission('users.deactivate')
  deactivate(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) { return this.users.setActive(auth, id, false, dto.version); }

  @Post(':id/activate') @HttpCode(200) @RequirePermission('users.deactivate')
  activate(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) { return this.users.setActive(auth, id, true, dto.version); }

  @Post(':id/reset-password') @HttpCode(200) @RequirePermission('users.reset_password')
  resetPassword(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.users.resetPassword(auth, id); }

  @Put(':id/roles') @RequirePermission('users.assign_roles')
  setRoles(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolesDto) { return this.users.setRoles(auth, id, dto.roles); }

  @Get(':id/login-history') @RequirePermission('login_history.read')
  loginHistory(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    return this.users.loginHistory(auth, id, q.page, q.pageSize);
  }
}
