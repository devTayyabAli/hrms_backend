import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { DecideReimbursementDto, HRMSModuleKey, MESSAGE_PATTERNS, ModuleAction, SERVICES } from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, RequireModule, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * What is waiting for the signed-in person to approve, outside the modules
 * they manage: today, expense claims whose route names them (a manager's step
 * before payroll). Like the rest of `organization/me`, it is the caller's own:
 * there is no permission to check and a claim that is waiting on someone else
 * is simply not found. The Payroll module still has to be enabled.
 */
@Controller('organization/me/approvals')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyApprovalsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('reimbursements')
  @ApiOperation({ summary: 'Expense claims waiting for me to approve' })
  getReimbursements(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.MY_APPROVALS_LIST, { tenantId, userId, email });
  }

  @Post('reimbursements/:id/decision')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Approve (it moves on to the next stage) or reject (with a reason) a claim that is waiting for me' })
  decideReimbursement(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideReimbursementDto,
  ) {
    // A manager's step never sets which payroll the claim is paid in.
    const { payrollPeriod: _ignored, ...decision } = dto;
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.MY_APPROVALS_DECIDE, { tenantId, userId, email, id, dto: decision });
  }
}
