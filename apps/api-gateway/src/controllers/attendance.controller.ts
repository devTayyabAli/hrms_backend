import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  Inject,
  UseGuards,
  Res,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  GetAttendanceQueryDto,
  ExportAttendanceQueryDto,
  AttendanceStatsQueryDto,
  AttendanceOverviewQueryDto,
  AttendanceByDepartmentQueryDto,
  CreateAttendanceRecordDto,
  UpdateAttendanceRecordDto,
  BulkMarkAttendanceDto,
  AttendanceDashboardQueryDto,
  AttendanceRegisterQueryDto,
  ExportAttendanceRegisterQueryDto,
  AttendancePeriodQueryDto,
  UnmarkedAttendanceQueryDto,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
  CurrentUser,
} from '@app/tenant-context';
import { sendCsvExport } from '../utils/csv-export.helper';

/**
 * Admin-side Attendance screen (organization portal).
 *
 * Covers the whole screen: KPI cards, the Attendance Overview trend chart,
 * the Department Wise Attendance breakdown, the Today's Attendance table and
 * its CSV export — plus admin manual entry and correction so records can
 * exist. Employee self-service clock-in/clock-out is intentionally not here
 * yet; every write on this controller is an administrative action, attributed
 * to the acting admin via `markedByUserId`.
 *
 * PRESENT vs LATE is derived from the tenant's own AttendancePolicy grace
 * period measured against its configured WorkingHours start time, and an
 * explicit `status` in the request always overrides that derivation.
 */
@Controller('organization/attendance')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.ATTENDANCE)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class AttendanceController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ==========================================
  // KPI cards + charts
  // NOTE: every static sub-route is declared before ':recordId' so Express
  // doesn't match "stats" or "overview" as a record id.
  // ==========================================

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('stats')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      'Attendance KPI cards (Present / Late / Absent / On Leave today) with attendance and punctuality rates',
  })
  getStats(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: AttendanceStatsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_STATS, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('overview')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      'Attendance Overview chart — present/late/absent counts per day, week or month',
  })
  getOverview(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: AttendanceOverviewQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_OVERVIEW, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('by-department')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      'Department Wise Attendance breakdown with a per-department attendance rate',
  })
  getByDepartment(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: AttendanceByDepartmentQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ATTENDANCE.GET_BY_DEPARTMENT,
      { tenantId, query },
    );
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('export')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EXPORT)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary: 'Export the filtered attendance table as CSV (Export button)',
  })
  async exportAttendance(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportAttendanceQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.ATTENDANCE.EXPORT,
      { tenantId, query },
      'attendance',
      [
        { header: 'Date', value: (row) => row.date },
        { header: 'Employee ID', value: (row) => row.employee?.employeeCode },
        { header: 'Employee', value: (row) => row.employee?.name },
        { header: 'Department', value: (row) => row.department?.name },
        { header: 'Check-in', value: (row) => row.checkInAt },
        { header: 'Check-out', value: (row) => row.checkOutAt },
        { header: 'Work Hours', value: (row) => row.workHours },
        { header: 'Status', value: (row) => row.status },
        { header: 'Notes', value: (row) => row.notes },
      ],
    );
  }

  // ==========================================
  // HR views: one-call screen, all-employee register, per-employee
  // calendar, unmarked follow-up list
  // ==========================================

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('dashboard')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      "The whole Attendance screen in one call — KPI cards, overview chart, department breakdown and the first page of the day's table",
  })
  getDashboard(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: AttendanceDashboardQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_DASHBOARD, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('unmarked')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      'Employees expected on a day who have no attendance record yet — defaults to today',
  })
  getUnmarked(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: UnmarkedAttendanceQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_UNMARKED, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('employees')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      'All Employees Attendance register — per employee present, late, absent, leave and unmarked days, hours and rates for a month or range',
  })
  getRegister(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: AttendanceRegisterQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_REGISTER, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('employees/export')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EXPORT)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary: 'Export the All Employees Attendance register as CSV',
  })
  async exportRegister(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportAttendanceRegisterQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.ATTENDANCE.EXPORT_REGISTER,
      { tenantId, query },
      'attendance-register',
      [
        { header: 'Employee ID', value: (row) => row.employee?.employeeCode },
        { header: 'Employee', value: (row) => row.employee?.name },
        {
          header: 'Department',
          value: (row) => row.employee?.department?.name,
        },
        {
          header: 'Designation',
          value: (row) => row.employee?.designation?.title,
        },
        {
          header: 'Working Days',
          value: (row) => row.summary?.expectedWorkingDays,
        },
        { header: 'Present', value: (row) => row.summary?.present },
        { header: 'Late', value: (row) => row.summary?.late },
        { header: 'Half Day', value: (row) => row.summary?.halfDay },
        { header: 'Absent', value: (row) => row.summary?.absent },
        { header: 'On Leave', value: (row) => row.summary?.onLeave },
        { header: 'Holiday', value: (row) => row.summary?.holiday },
        { header: 'Unmarked', value: (row) => row.summary?.unmarkedDays },
        { header: 'Total Hours', value: (row) => row.summary?.totalWorkHours },
        { header: 'Avg Hours/Day', value: (row) => row.summary?.avgWorkHours },
        { header: 'Attendance %', value: (row) => row.summary?.attendanceRate },
        {
          header: 'Punctuality %',
          value: (row) => row.summary?.punctualityRate,
        },
      ],
    );
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get('employees/:employeeId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      "One employee's attendance calendar — every day of the month or range, recorded or not, with the period summary",
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  getEmployeeAttendance(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: AttendancePeriodQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_EMPLOYEE, {
      tenantId,
      employeeId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Post('bulk-mark')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.CREATE)
  @RequirePermissions('attendance.manage')
  @ApiOperation({
    summary:
      'Mark a whole day at once. Re-marking a date updates the existing rows instead of duplicating them',
  })
  bulkMark(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: BulkMarkAttendanceDto,
    @CurrentUser('id') markedByUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.BULK_MARK, {
      tenantId,
      dto,
      markedByUserId,
    });
  }

  // ==========================================
  // Today's Attendance table + record CRUD
  // ==========================================

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get()
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({
    summary:
      "Today's Attendance table — defaults to today; paginated and filterable by date range, department, employee and status",
  })
  getAttendance(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetAttendanceQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Post()
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.CREATE)
  @RequirePermissions('attendance.manage')
  @ApiOperation({
    summary:
      'Record attendance for one employee on one day. Status is derived from check-in unless given',
  })
  createRecord(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateAttendanceRecordDto,
    @CurrentUser('id') markedByUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.CREATE, {
      tenantId,
      dto,
      markedByUserId,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Get(':recordId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.VIEW)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({ summary: 'Get a single attendance record' })
  @ApiParam({ name: 'recordId', format: 'uuid' })
  getRecord(
    @Headers('x-tenant-id') tenantId: string,
    @Param('recordId') recordId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.GET_ONE, {
      tenantId,
      recordId,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Patch(':recordId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EDIT)
  @RequirePermissions('attendance.manage')
  @ApiOperation({
    summary:
      'Correct an attendance record. Changing check-in re-derives the status unless one is supplied',
  })
  @ApiParam({ name: 'recordId', format: 'uuid' })
  updateRecord(
    @Headers('x-tenant-id') tenantId: string,
    @Param('recordId') recordId: string,
    @Body() dto: UpdateAttendanceRecordDto,
    @CurrentUser('id') markedByUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.UPDATE, {
      tenantId,
      recordId,
      dto,
      markedByUserId,
    });
  }

  @ApiTags(TAGS.ORG_ATTENDANCE)
  @Delete(':recordId')
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.DELETE)
  @RequirePermissions('attendance.manage')
  @ApiOperation({ summary: 'Delete an attendance record' })
  @ApiParam({ name: 'recordId', format: 'uuid' })
  deleteRecord(
    @Headers('x-tenant-id') tenantId: string,
    @Param('recordId') recordId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ATTENDANCE.DELETE, {
      tenantId,
      recordId,
    });
  }
}
