import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  ActivateComplianceRuleDto,
  ComplianceReportQueryDto,
  ComplianceRuleQueryDto,
  CreateComplianceRuleDto,
  IssueTaxCertificateDto,
  SaveTaxProfileDto,
  TaxCertificateQueryDto,
  TaxYearQueryDto,
  UpdateComplianceRuleDto,
  type ComplianceReportType,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { sendPdf } from '../utils/send-pdf';

const REPORT_TYPES: Record<string, ComplianceReportType> = {
  tax: 'TAX',
  eobi: 'EOBI',
  pf: 'PF',
};

/**
 * Payroll compliance (Pakistan) — rules, employee tax profiles, statutory
 * reports, annual summaries and tax certificates.
 *
 * Two permission areas, each with view and manage (manage covers view):
 * `payroll.compliance.*` for rules and EOBI / provident fund reports,
 * `payroll.tax.*` for employees' tax details. `payroll.manage` covers both.
 * tenant-service checks the same again — this is not the only gate.
 */
@Controller('organization/payroll/compliance')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PAYROLL)
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.PAYROLL)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class PayrollComplianceController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ── Rules ─────────────────────────────────────────────────────────────────

  @Get('rules')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.compliance.view', 'payroll.manage')
  @ApiOperation({
    summary: 'Tax, EOBI and provident fund rules — drafts, active and retired',
  })
  listRules(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ComplianceRuleQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_RULES,
      { tenantId, ruleType: query.ruleType },
    );
  }

  @Get('templates')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.compliance.view', 'payroll.manage')
  @ApiOperation({
    summary:
      'Sourced starting points for new rules, with their official references and review notes',
  })
  listTemplates(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_TEMPLATES,
      { tenantId },
    );
  }

  @Post('rules')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.compliance.manage', 'payroll.manage')
  @ApiOperation({
    summary:
      'Create a draft rule, from a template or from scratch. Drafts never apply to payroll',
  })
  createRule(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateComplianceRuleDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.CREATE_RULE,
      { tenantId, dto },
    );
  }

  @Put('rules/:ruleId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.compliance.manage', 'payroll.manage')
  @ApiParam({ name: 'ruleId' })
  @ApiOperation({
    summary:
      'Edit a draft rule. Active rules are frozen — a change is a new rule',
  })
  updateRule(
    @Headers('x-tenant-id') tenantId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateComplianceRuleDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.UPDATE_RULE,
      { tenantId, ruleId, dto },
    );
  }

  @Post('rules/:ruleId/activate')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.compliance.manage', 'payroll.manage')
  @ApiParam({ name: 'ruleId' })
  @ApiOperation({
    summary:
      'Activate a draft for its dates. Refused while invalid, overlapping an active rule, or unreviewed',
  })
  activateRule(
    @Headers('x-tenant-id') tenantId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: ActivateComplianceRuleDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.ACTIVATE_RULE,
      { tenantId, ruleId, dto },
    );
  }

  @Post('rules/:ruleId/retire')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.compliance.manage', 'payroll.manage')
  @ApiParam({ name: 'ruleId' })
  @ApiOperation({
    summary:
      'Stop a rule applying to new calculations. Past payrolls keep their own copy',
  })
  retireRule(
    @Headers('x-tenant-id') tenantId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.RETIRE_RULE,
      { tenantId, ruleId },
    );
  }

  // ── Employee tax profiles ────────────────────────────────────────────────

  @Get('tax-profiles')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.tax.view', 'payroll.manage')
  @ApiOperation({
    summary: 'Every current employee’s tax profile for a tax year',
  })
  listTaxProfiles(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: TaxYearQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_TAX_PROFILES,
      { tenantId, taxYear: query.taxYear },
    );
  }

  @Get('tax-profiles/:employeeId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.tax.view', 'payroll.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'One employee’s tax profile for a tax year' })
  getTaxProfile(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: TaxYearQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_TAX_PROFILE,
      { tenantId, employeeId, taxYear: query.taxYear },
    );
  }

  @Put('tax-profiles/:employeeId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.tax.manage', 'payroll.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({
    summary:
      'Save an employee’s tax profile for a tax year. Audited by field name only',
  })
  saveTaxProfile(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: TaxYearQueryDto,
    @Body() dto: SaveTaxProfileDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.SAVE_TAX_PROFILE,
      { tenantId, employeeId, taxYear: query.taxYear, dto },
    );
  }

  // ── Reports ───────────────────────────────────────────────────────────────
  // tax needs payroll.tax.view; eobi and pf need payroll.compliance.view. The
  // route accepts either area and tenant-service decides by report type.

  @Get('reports/:type')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(
    'payroll.tax.view',
    'payroll.compliance.view',
    'payroll.manage',
  )
  @ApiParam({ name: 'type', enum: ['tax', 'eobi', 'pf'] })
  @ApiOperation({
    summary: 'Monthly tax, EOBI or provident fund report from approved payroll',
  })
  getReport(
    @Headers('x-tenant-id') tenantId: string,
    @Param('type') type: string,
    @Query() filters: ComplianceReportQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_REPORT,
      { tenantId, type: this.reportType(type), filters },
    );
  }

  @Get('reports/:type/export')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(
    'payroll.tax.view',
    'payroll.compliance.view',
    'payroll.manage',
  )
  @ApiParam({ name: 'type', enum: ['tax', 'eobi', 'pf'] })
  @ApiOperation({ summary: 'The same report as CSV. Audited' })
  async exportReport(
    @Headers('x-tenant-id') tenantId: string,
    @Param('type') type: string,
    @Query() filters: ComplianceReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result: any = await firstValueFrom(
      this.tenantClient.send(
        MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.EXPORT_REPORT,
        { tenantId, type: this.reportType(type), filters },
      ),
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(result?.filename ?? 'compliance-report.csv').replace(/"/g, '')}"`,
    );
    return result?.csv ?? '';
  }

  private reportType(type: string): ComplianceReportType {
    // An unknown type goes through as is and fails validation in tenant-service.
    return (
      REPORT_TYPES[String(type).toLowerCase()] ??
      (String(type).toUpperCase() as ComplianceReportType)
    );
  }

  // ── Annual summaries & certificates ──────────────────────────────────────

  @Get('tax-summaries')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.tax.view', 'payroll.manage')
  @ApiOperation({
    summary: 'Each employee’s tax year totals from approved payroll',
  })
  listTaxSummaries(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: TaxYearQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_TAX_SUMMARIES,
      { tenantId, taxYear: query.taxYear },
    );
  }

  @Get('tax-summaries/:employeeId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.tax.view', 'payroll.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'One employee’s tax year, month by month' })
  getTaxSummary(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: TaxYearQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_TAX_SUMMARY,
      { tenantId, employeeId, taxYear: query.taxYear },
    );
  }

  @Get('tax-certificates')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.tax.view', 'payroll.manage')
  @ApiOperation({ summary: 'Issued tax certificates' })
  listCertificates(
    @Headers('x-tenant-id') tenantId: string,
    @Query() filters: TaxCertificateQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_CERTIFICATES,
      { tenantId, filters },
    );
  }

  @Post('tax-certificates')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.tax.manage', 'payroll.manage')
  @ApiOperation({
    summary:
      'Issue an employee’s tax certificate for a tax year from approved payroll. Audited',
  })
  issueCertificate(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: IssueTaxCertificateDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.ISSUE_CERTIFICATE,
      {
        tenantId,
        employeeId: dto.employeeId,
        taxYear: dto.taxYear,
      },
    );
  }

  @Get('tax-certificates/:certificateId/pdf')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.tax.view', 'payroll.manage')
  @ApiParam({ name: 'certificateId' })
  @ApiOperation({ summary: 'Download a tax certificate as a PDF' })
  async getCertificatePdf(
    @Headers('x-tenant-id') tenantId: string,
    @Param('certificateId', ParseUUIDPipe) certificateId: string,
    @Res() res: Response,
  ) {
    const pdf = await firstValueFrom(
      this.tenantClient.send(
        MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_CERTIFICATE_PDF,
        { tenantId, certificateId },
      ),
    );
    return sendPdf(res, pdf);
  }
}
