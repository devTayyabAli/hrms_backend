import { Controller, Get, Headers, Inject, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import {
  ExportLeaveBalancesQueryDto,
  GetLeaveBalancesQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  type CsvColumn,
  type ExportResult,
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
import { sendCsvExport } from '../utils/csv-export.helper';

type BalanceRow = {
  employee: { name: string; employeeCode: string; email: string | null };
  department: { name: string } | null;
  balances: { leavePolicyId: string; used: number; pending: number; remaining: number }[];
  totals: { used: number };
};
type BalanceExport = ExportResult<BalanceRow> & { policies: { id: string; name: string }[] };

/**
 * Leave → Balances (organization portal): every employee's balance on every
 * active leave type for one fiscal year, with department filtering, search,
 * paging and CSV export.
 *
 * Read-only. Leave types come from the organization's leave policies
 * (`/organization/leave-policy`) and the days from its leave requests, so
 * there is nothing to write here.
 */
@Controller('organization/leave-balances')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_LEAVE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class LeaveBalancesController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  // Declared before any `:id`-style route would be, so "export" is never read as an id.
  @Get('export')
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.EXPORT)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary: 'Export the filtered leave balances as CSV — one row per employee, one set of columns per leave type',
  })
  async exportLeaveBalances(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportLeaveBalancesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<BalanceRow, BalanceExport>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.LEAVE_BALANCE.EXPORT,
      { tenantId, query },
      'leave-balances',
      (result): CsvColumn<BalanceRow>[] => [
        { header: 'Employee', value: (row) => row.employee.name },
        { header: 'Employee ID', value: (row) => row.employee.employeeCode },
        { header: 'Email', value: (row) => row.employee.email },
        { header: 'Department', value: (row) => row.department?.name },
        // Each active leave type gets its own columns, in the table's order.
        ...result.policies.flatMap((policy): CsvColumn<BalanceRow>[] => {
          const entry = (row: BalanceRow) => row.balances.find((balance) => balance.leavePolicyId === policy.id);
          return [
            { header: `${policy.name} - Used`, value: (row) => entry(row)?.used },
            { header: `${policy.name} - Pending`, value: (row) => entry(row)?.pending },
            { header: `${policy.name} - Remaining`, value: (row) => entry(row)?.remaining },
          ];
        }),
        { header: 'Total Used', value: (row) => row.totals.used },
      ],
    );
  }

  @Get()
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({
    summary:
      'Leave balances table — each employee\'s allocation, used, pending, remaining and available days per leave type for a fiscal year',
  })
  getLeaveBalances(@Headers('x-tenant-id') tenantId: string, @Query() query: GetLeaveBalancesQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEAVE_BALANCE.GET_ALL, { tenantId, query });
  }
}
