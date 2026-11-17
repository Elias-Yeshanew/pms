import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { PageQuery } from '../../common/pagination';
import { CreateBranchDto, CreateDepartmentDto, CreateEmployeeDto, EmployeesQuery, UpdateBranchDto, UpdateEmployeeDto } from './org.dto';
import { OrgService } from './org.service';

@ApiTags('Organization')
@ApiBearerAuth()
@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('branches') @RequirePermission('branches.read')
  listBranches(@Auth() auth: AuthContext, @Query() q: PageQuery) { return this.org.listBranches(auth, q); }

  @Post('branches') @RequirePermission('branches.manage')
  createBranch(@Auth() auth: AuthContext, @Body() dto: CreateBranchDto) { return this.org.createBranch(auth, dto); }

  @Get('branches/:id') @RequirePermission('branches.read')
  getBranch(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.org.getBranch(auth, id); }

  @Patch('branches/:id') @RequirePermission('branches.manage')
  updateBranch(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) { return this.org.updateBranch(auth, id, dto); }

  @Get('departments') @RequirePermission('employees.read')
  listDepartments() { return this.org.listDepartments(); }

  @Post('departments') @RequirePermission('employees.manage')
  createDepartment(@Auth() auth: AuthContext, @Body() dto: CreateDepartmentDto) { return this.org.createDepartment(auth, dto); }

  @Get('employees') @RequirePermission('employees.read')
  listEmployees(@Auth() auth: AuthContext, @Query() q: EmployeesQuery) { return this.org.listEmployees(auth, q); }

  @Post('employees') @RequirePermission('employees.manage')
  createEmployee(@Auth() auth: AuthContext, @Body() dto: CreateEmployeeDto) { return this.org.createEmployee(auth, dto); }

  @Get('employees/:id') @RequirePermission('employees.read')
  getEmployee(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.org.getEmployee(auth, id); }

  @Patch('employees/:id') @RequirePermission('employees.manage')
  updateEmployee(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEmployeeDto) { return this.org.updateEmployee(auth, id, dto); }
}
