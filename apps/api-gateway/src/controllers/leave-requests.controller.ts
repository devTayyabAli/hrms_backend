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
  GetLeaveRequestsQueryDto,
  ExportLeaveRequestsQueryDto,
  CreateLeaveRequestDto,
  UpdateLeaveRequestDto,
  DecideLeaveRequestDto,
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
 * Admin-side Leave Management screen (organization portal).
 *
 * Covers the whole screen: the KPI cards, the Leave Requests table behind the
 * All Requests / Pending / Approved / Rejected tabs, its CSV export, Add
 * Leave Request, and the row approve / reject / cancel / delete actions.
 *
 * Leave *types* are deliberately absent here. Annual, Sick, Casual and the
 * rest are the tenant's own leave policies, already owned by the Setup Wizard
 * at GET|POST|PATCH|DELETE /organization/leave-policy — this screen reads
 * them and the Leave Type dropdown is populated from that endpoint. A second
 * write path for the same rows would mean two places validating allocations,
 * free to drift apart.
 *
 * Every write is an administrative action, attributed to the acting admin via
 * `appliedByUserId` / `decidedByUserId`. Employee self-service leave
 * application is intentionally not here yet.
 */
@Controller('organization/leave-requests')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class LeaveRequestsController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ==========================================
  // KPI cards + export
  // NOTE: the static sub-routes are declared before ':leaveRequestId' so
  // Express doesn't match "stats" or "export" as a request id.
  // ==========================================

  @ApiTags(TAGS.ORG_LEAVE)
  @Get('stats')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Leave KPI cards (Total Requests / Approved / Pending / Rejected) with month-over-month growth',
  })
  getStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.GET_STATS, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Get('export')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.EXPORT)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary: 'Export the filtered leave requests as CSV (Export button)',
  })
  async exportLeaveRequests(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportLeaveRequestsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.LEAVE_REQUEST.EXPORT,
      { tenantId, query },
      'leave-requests',
      [
        { header: 'Employee', value: (row) => row.employee?.name },
        { header: 'Employee ID', value: (row) => row.employee?.employeeCode },
        { header: 'Email', value: (row) => row.employee?.email },
        { header: 'Department', value: (row) => row.department?.name },
        { header: 'Leave Type', value: (row) => row.leaveType?.name },
        { header: 'Duration', value: (row) => row.duration },
        { header: 'From', value: (row) => row.fromDate },
        { header: 'To', value: (row) => row.toDate },
        { header: 'Status', value: (row) => row.status },
        { header: 'Reason', value: (row) => row.reason },
        { header: 'Decision Note', value: (row) => row.decisionNote },
      ],
    );
  }

  // ==========================================
  // Leave Requests table + lifecycle
  // ==========================================

  @ApiTags(TAGS.ORG_LEAVE)
  @Get()
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Leave Requests table — paginated and searchable, filterable by status tab, employee, department, leave type and date range',
  })
  getLeaveRequests(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetLeaveRequestsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Post()
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.CREATE)
  @RequirePermissions('leave_management.create', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Add Leave Request. Duration defaults to the inclusive calendar span; overlapping leave for the same employee is rejected',
  })
  createLeaveRequest(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateLeaveRequestDto,
    @CurrentUser('id') appliedByUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.CREATE, {
      tenantId,
      dto,
      appliedByUserId,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Get(':leaveRequestId')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary: 'Get a single leave request with its employee and leave type',
  })
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  getLeaveRequest(
    @Headers('x-tenant-id') tenantId: string,
    @Param('leaveRequestId') leaveRequestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.GET_ONE, {
      tenantId,
      leaveRequestId,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Patch(':leaveRequestId')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.EDIT)
  @RequirePermissions('leave_management.edit', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Edit a pending leave request (row Edit action). A decided request can no longer be edited',
  })
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  updateLeaveRequest(
    @Headers('x-tenant-id') tenantId: string,
    @Param('leaveRequestId') leaveRequestId: string,
    @Body() dto: UpdateLeaveRequestDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.UPDATE, {
      tenantId,
      leaveRequestId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Patch(':leaveRequestId/decision')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.EDIT)
  @RequirePermissions('leave_management.edit', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Approve or reject a pending request (row Approve / Reject actions), recording who decided and why',
  })
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  decideLeaveRequest(
    @Headers('x-tenant-id') tenantId: string,
    @Param('leaveRequestId') leaveRequestId: string,
    @Body() dto: DecideLeaveRequestDto,
    @CurrentUser('id') decidedByUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.DECIDE, {
      tenantId,
      leaveRequestId,
      dto,
      decidedByUserId,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Patch(':leaveRequestId/cancel')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.EDIT)
  @RequirePermissions('leave_management.edit', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Withdraw a request (row Cancel action). The record is kept and its dates are released',
  })
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  cancelLeaveRequest(
    @Headers('x-tenant-id') tenantId: string,
    @Param('leaveRequestId') leaveRequestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.CANCEL, {
      tenantId,
      leaveRequestId,
    });
  }

  @ApiTags(TAGS.ORG_LEAVE)
  @Delete(':leaveRequestId')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.DELETE)
  @RequirePermissions('leave_management.delete', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Permanently remove a leave request (row Delete action). Prefer Cancel, which keeps the history',
  })
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  deleteLeaveRequest(
    @Headers('x-tenant-id') tenantId: string,
    @Param('leaveRequestId') leaveRequestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_REQUEST.DELETE, {
      tenantId,
      leaveRequestId,
    });
  }
}
