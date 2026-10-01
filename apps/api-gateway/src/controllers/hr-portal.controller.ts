import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  AcceptEmployeeInvitationDto,
  GenerateHrReportDto,
  GetEmployeeInvitationsQueryDto,
  HrDashboardQueryDto,
  AdminDashboardQueryDto,
  HrReportQueryDto,
  InviteEmployeeDto,
  LeaveApprovalsQueryDto,
  OnboardingMatrixQueryDto,
  ValidateEmployeeInvitationDto,
  ORG_ADMIN_ROLE_NAME,
  CsvColumn,
  csvFilename,
  toCsv,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
  MicroserviceSigningService,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * HR Portal — the HR Dashboard screen and the Onboarding Checklist Matrix.
 *
 * Every figure here is an aggregate of screens HR can already open, so the
 * dashboard is gated on the same DASHBOARD module the sidebar entry is.
 */
@Controller('organization/hr')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_HR_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class HrPortalController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('dashboard')
  @RequireModule(HRMSModuleKey.DASHBOARD)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'HR Dashboard in one call — the five KPI cards, the pending leave approvals panel, and the Quick Actions',
  })
  getDashboard(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: HrDashboardQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_DASHBOARD, { tenantId, query });
  }

  @Get('dashboard/admin')
  @RequireModule(HRMSModuleKey.DASHBOARD)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'Organization admin dashboard — headline KPIs, leave summary, headcount trend, department headcount, goal achievement, attendance, tasks, recent joiners and payroll, each card with its own range',
  })
  getAdminOverview(@Headers('x-tenant-id') tenantId: string, @Query() query: AdminDashboardQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_ADMIN_OVERVIEW, { tenantId, query });
  }

  @Get('dashboard/insights')
  @RequireModule(HRMSModuleKey.DASHBOARD)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      "HR Dashboard insights — today's attendance breakdown, the 7-day trend, headcount by department, who's out, upcoming leave, work anniversaries and what's waiting for review",
  })
  getInsights(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_INSIGHTS, { tenantId });
  }

  @Get('dashboard/stats')
  @RequireModule(HRMSModuleKey.DASHBOARD)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'KPI cards only — Total Employees, New Joiners (Month), Pending Onboarding, Present Today, Pending Leave',
  })
  getStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_STATS, { tenantId });
  }

  @Get('dashboard/leave-approvals')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Leave Approvals Pending — soonest first, with the Urgent badge for leave starting within 3 days. Approve or reject on /organization/leave-requests/{id}/decision',
  })
  getLeaveApprovals(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: LeaveApprovalsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_LEAVE_APPROVALS, {
      tenantId,
      query,
    });
  }

  @Get('onboarding/matrix')
  @RequireModule(HRMSModuleKey.ONBOARDING)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Onboarding Checklist Matrix — checklist tasks as rows, new hires as columns, and a tick per cell',
  })
  getOnboardingMatrix(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: OnboardingMatrixQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_ONBOARDING_MATRIX, {
      tenantId,
      query,
    });
  }
}

/**
 * The Reports screen: the six template cards, and the Generate dialog's
 * date range / department / format.
 */
@Controller('organization/hr/reports')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_HR_REPORTS)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.REPORTS)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class HrReportsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('templates')
  @RequirePermissions('reports.view', 'reports.manage')
  @ApiOperation({
    summary:
      'The six report cards with when each was last generated, plus the ranges and formats the Generate dialog offers',
  })
  getTemplates(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_REPORT_TEMPLATES, { tenantId });
  }

  @Post('generate')
  @RequireModule(HRMSModuleKey.REPORTS, ModuleAction.VIEW)
  @RequirePermissions('reports.view', 'reports.manage')
  @ApiOperation({
    summary:
      'Generate a report — rows, columns and a summary as JSON. Use /download for the CSV the dialog offers',
  })
  generate(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Body() dto: GenerateHrReportDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GENERATE_REPORT, {
      tenantId,
      dto,
      actorUserId,
    });
  }

  @Get('download')
  @RequireModule(HRMSModuleKey.REPORTS, ModuleAction.EXPORT)
  @RequirePermissions('reports.view', 'reports.manage')
  @ApiOperation({ summary: 'Generate & Download — the same report as a CSV attachment' })
  async download(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Query() query: HrReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Not sendCsvExport: that helper is built for a fixed column list known
    // at compile time, and a report's columns depend on its type. Asking the
    // service twice — once for columns, once for rows — would also log the
    // run twice. So one call, and the same truncation headers by hand.
    const report: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.EXPORT_REPORT, {
        tenantId,
        dto: query,
        actorUserId,
      }),
    );

    const columns: CsvColumn<any>[] = (report?.columns ?? []).map((column: string) => ({
      header: column,
      value: (row: any) => row?.[column],
    }));
    const csv = toCsv(report?.rows ?? [], columns);

    res.setHeader('X-Export-Total-Matched', String(report?.totalMatched ?? 0));
    res.setHeader('X-Export-Truncated', String(Boolean(report?.truncated)));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${csvFilename(
        `hr-${String(query.type ?? 'report').toLowerCase()}`,
      )}"`,
    );
    return csv;
  }
}

/**
 * Employee invitations — the Invite Employee quick action, and the pages the
 * invited person lands on.
 */
@Controller('organization/hr/invitations')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_HR_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class EmployeeInvitationController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    private readonly signingService: MicroserviceSigningService,
  ) {}

  @Get('roles')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiOperation({
    summary:
      'Roles an employee can be invited with. Needs only the employee permission that sending the invitation does — not User Management — and never includes the Organization Admin role',
  })
  async invitableRoles() {
    const response: any = await firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.GET_ALL, this.signingService.sign({ limit: 200 })),
    );
    const rows: any[] = Array.isArray(response) ? response : (response?.data ?? []);
    return rows
      .filter((role) => role?.name !== ORG_ADMIN_ROLE_NAME)
      .map((role) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName ?? role.name,
        description: role.description ?? null,
        isSystemRole: Boolean(role.isSystemRole),
        dataScope: role.dataScope ?? null,
      }));
  }

  @Post()
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiOperation({
    summary:
      'Invite Employee — emails an activation link that gives one employee a portal login. Any earlier pending invitation for them is revoked',
  })
  async invite(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @CurrentUser('isFullAccess') isFullAccess: boolean,
    @Body() dto: InviteEmployeeDto,
  ) {
    // Anyone who may edit employees may invite them — but only an admin may
    // hand out admin. Without this, HR could mint a full-access login.
    if (dto.roleId && !isFullAccess) {
      const role: any = await firstValueFrom(
        this.userClient.send(MESSAGE_PATTERNS.ROLE.GET_BY_ID, this.signingService.sign({ id: dto.roleId })),
      ).catch(() => null);
      if (!role) throw new NotFoundException('That role no longer exists.');
      if (role.name === ORG_ADMIN_ROLE_NAME) {
        throw new ForbiddenException('Only an organization admin can invite someone as Organization Admin.');
      }
    }
    return firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.INVITE_EMPLOYEE, {
        tenantId,
        dto,
        actorUserId,
      }),
    );
  }

  @Get()
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({ summary: 'Invitations sent, with their status' })
  list(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetEmployeeInvitationsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.GET_INVITATIONS, {
      tenantId,
      query,
    });
  }

  @Post(':invitationId/resend')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'invitationId' })
  @ApiOperation({
    summary: 'Resend — issues a fresh token and restarts the clock, so the earlier link stops working',
  })
  resend(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.RESEND_INVITATION, {
      tenantId,
      invitationId,
      actorUserId,
    });
  }

  @Delete(':invitationId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'invitationId' })
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  revoke(
    @Headers('x-tenant-id') tenantId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.REVOKE_INVITATION, {
      tenantId,
      invitationId,
    });
  }
}

/**
 * The two unauthenticated steps an invited employee takes. They have no
 * login yet — that is what these create — so neither route can sit behind
 * JwtAuthGuard. The token alone is the proof; tenant-service resolves which
 * organization it belongs to server-side (via a platform-level token-hash
 * lookup), so no tenant id is ever exposed in the activation link or sent by
 * this unauthenticated client.
 */
@Controller('employee-activation')
@ApiTags(TAGS.ORG_HR_PORTAL)
export class EmployeeActivationController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Post('validate')
  @ApiOperation({
    summary: 'Check an invitation link before asking for a password, and greet the employee by name',
  })
  validate(@Body() dto: ValidateEmployeeInvitationDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.VALIDATE_INVITATION, {
      token: dto.token,
    });
  }

  @Post('accept')
  @ApiOperation({
    summary: 'Set a password and activate portal access. The login is linked to the employee record',
  })
  accept(@Body() dto: AcceptEmployeeInvitationDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HR_PORTAL.ACCEPT_INVITATION, { dto });
  }
}
