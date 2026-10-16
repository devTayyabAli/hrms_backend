import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  AssignShiftEmployeesDto,
  CreateShiftDto,
  GetShiftsQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateShiftDto,
} from '@app/common';
import {
  JwtAuthGuard,
  OrganizationModuleGuard,
  PermissionsGuard,
  RequireModule,
  RequirePermissions,
  RolesGuard,
  TenantGuard,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Attendance → Shifts (organization portal): the shifts an organization
 * defines — name, hours, break, working days, active or not — and which
 * employees work each one.
 *
 * Separate from `GET|PUT organization/working-hours`, the single
 * organization-wide schedule attendance rules are judged against. Shifts
 * record the roster; they do not change those rules.
 */
@Controller('organization/shifts')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_ATTENDANCE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.ATTENDANCE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class ShiftsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({ summary: 'Shifts, with how many employees are on each, and the totals for the page header' })
  getShifts(@Headers('x-tenant-id') tenantId: string, @Query() query: GetShiftsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.GET_ALL, { tenantId, query });
  }

  @Post()
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.CREATE)
  @RequirePermissions('attendance.create', 'attendance.manage')
  @ApiOperation({ summary: 'Create a shift' })
  createShift(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateShiftDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.CREATE, { tenantId, dto });
  }

  @Get(':shiftId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiParam({ name: 'shiftId' })
  @ApiOperation({ summary: 'One shift' })
  getShift(@Headers('x-tenant-id') tenantId: string, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.GET_ONE, { tenantId, shiftId });
  }

  @Patch(':shiftId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EDIT)
  @RequirePermissions('attendance.edit', 'attendance.manage')
  @ApiParam({ name: 'shiftId' })
  @ApiOperation({ summary: 'Edit a shift, or switch it on or off with isActive' })
  updateShift(
    @Headers('x-tenant-id') tenantId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: UpdateShiftDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.UPDATE, { tenantId, shiftId, dto });
  }

  @Post(':shiftId/duplicate')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.CREATE)
  @RequirePermissions('attendance.create', 'attendance.manage')
  @ApiParam({ name: 'shiftId' })
  @ApiOperation({ summary: 'Copy a shift under a free name, with nobody on it' })
  duplicateShift(@Headers('x-tenant-id') tenantId: string, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.DUPLICATE, { tenantId, shiftId });
  }

  @Delete(':shiftId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.DELETE)
  @RequirePermissions('attendance.delete', 'attendance.manage')
  @ApiParam({ name: 'shiftId' })
  @ApiOperation({ summary: 'Delete a shift nobody works. A shift with employees must be emptied or deactivated instead' })
  deleteShift(@Headers('x-tenant-id') tenantId: string, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.DELETE, { tenantId, shiftId });
  }

  @Get(':shiftId/employees')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiParam({ name: 'shiftId' })
  @ApiOperation({ summary: 'The employees on a shift' })
  getShiftEmployees(@Headers('x-tenant-id') tenantId: string, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.GET_EMPLOYEES, { tenantId, shiftId });
  }

  @Put(':shiftId/employees')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EDIT)
  @RequirePermissions('attendance.edit', 'attendance.manage')
  @ApiParam({ name: 'shiftId' })
  @ApiOperation({
    summary: 'Set exactly who works this shift. Listed employees are moved here from their old shift; the rest are taken off',
  })
  setShiftEmployees(
    @Headers('x-tenant-id') tenantId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: AssignShiftEmployeesDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.SHIFT.SET_EMPLOYEES, { tenantId, shiftId, dto });
  }
}
