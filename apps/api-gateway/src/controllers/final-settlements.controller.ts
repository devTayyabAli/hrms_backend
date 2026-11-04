import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  DecideSettlementDto,
  GetSettlementsQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  SettlementLineDto,
  UpdateSettlementDto,
  UpdateSettlementLineDto,
} from '@app/common';
import { JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { sendPdf } from '../utils/send-pdf';

// Whoever prepares a settlement is HR or Finance; approving it is payroll's, and never the preparer's.
const VIEW = ['offboarding.view', 'offboarding.manage', 'payroll.adjustments.manage', 'payroll.approve', 'payroll.manage'];
const PREPARE = ['offboarding.manage', 'payroll.adjustments.manage', 'payroll.manage'];
const APPROVE = ['payroll.approve', 'payroll.manage'];

/**
 * Final settlement: what is owed to and by someone leaving. Prepared from
 * their offboarding case, sent for approval, approved by someone other than
 * the preparer, and then posted to payroll as earnings and deductions.
 */
@Controller('organization/offboarding')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PAYROLL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PAYROLL)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class FinalSettlementsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('cases/:caseId/settlement')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiParam({ name: 'caseId' })
  @ApiOperation({ summary: 'The settlement of an offboarding case, or null when none has been prepared' })
  getForCase(@Headers('x-tenant-id') tenantId: string, @Param('caseId', ParseUUIDPipe) caseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.GET_FOR_CASE, { tenantId, caseId });
  }

  @Post('cases/:caseId/settlement')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.CREATE)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'caseId' })
  @ApiOperation({ summary: 'Work out the settlement: unused leave that may be cashed in and loan balances. Doing it again refreshes a draft and keeps the lines typed in' })
  prepare(@Headers('x-tenant-id') tenantId: string, @Param('caseId', ParseUUIDPipe) caseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.PREPARE, { tenantId, caseId });
  }

  @Get('settlements')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiOperation({ summary: 'Settlements for the people you can reach, with a count per status' })
  getSettlements(@Headers('x-tenant-id') tenantId: string, @Query() query: GetSettlementsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.GET_ALL, { tenantId, query });
  }

  @Get('settlements/:settlementId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'One settlement with its lines, totals and approval' })
  getSettlement(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.GET_ONE, { tenantId, settlementId });
  }

  @Get('settlements/:settlementId/pdf')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'The settlement as a PDF statement to hand over, with a line for each signature. A draft says so at the top' })
  async getSettlementPdf(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string, @Res() res: Response) {
    const pdf = await firstValueFrom(this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.GET_PDF, { tenantId, settlementId }));
    return sendPdf(res, pdf as any);
  }

  @Patch('settlements/:settlementId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'Choose the payroll month it is paid in, while it is a draft' })
  updateSettlement(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string, @Body() dto: UpdateSettlementDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.UPDATE, { tenantId, settlementId, dto });
  }

  @Post('settlements/:settlementId/lines')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'Add a line (notice shortfall, a bonus, tax withheld...) to a draft' })
  addLine(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string, @Body() dto: SettlementLineDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.ADD_LINE, { tenantId, settlementId, dto });
  }

  @Patch('settlements/:settlementId/lines/:lineId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'settlementId' })
  @ApiParam({ name: 'lineId' })
  @ApiOperation({ summary: 'Change a line that was typed in. Lines the system worked out are refreshed, not edited' })
  updateLine(
    @Headers('x-tenant-id') tenantId: string,
    @Param('settlementId', ParseUUIDPipe) settlementId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdateSettlementLineDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.UPDATE_LINE, { tenantId, settlementId, lineId, dto });
  }

  @Delete('settlements/:settlementId/lines/:lineId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'settlementId' })
  @ApiParam({ name: 'lineId' })
  @ApiOperation({ summary: 'Remove a line that was typed in' })
  removeLine(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.REMOVE_LINE, { tenantId, settlementId, lineId });
  }

  @Post('settlements/:settlementId/submit')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'Send the draft for approval' })
  submit(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.SUBMIT, { tenantId, settlementId });
  }

  @Post('settlements/:settlementId/decision')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...APPROVE)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'Approve, or send back with a reason. Not for whoever prepared it. Approving the last stage posts its lines to payroll' })
  decide(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string, @Body() dto: DecideSettlementDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.DECIDE, { tenantId, settlementId, dto });
  }

  @Post('settlements/:settlementId/cancel')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...PREPARE)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'Withdraw a settlement that is a draft or waiting for approval' })
  cancel(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.CANCEL, { tenantId, settlementId });
  }

  @Post('settlements/:settlementId/paid')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...APPROVE)
  @ApiParam({ name: 'settlementId' })
  @ApiOperation({ summary: 'Mark an approved settlement as paid, once payroll has paid it out' })
  markPaid(@Headers('x-tenant-id') tenantId: string, @Param('settlementId', ParseUUIDPipe) settlementId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.FINAL_SETTLEMENT.MARK_PAID, { tenantId, settlementId });
  }
}
