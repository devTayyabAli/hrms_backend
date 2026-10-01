import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  AdjustmentEntryDto,
  AdjustmentEntryQueryDto,
  CompensationImportDto,
  ComponentQueryDto,
  ComponentStatusDto,
  CreatePayrollComponentDto,
  DecideReimbursementDto,
  LoanDto,
  LoanQueryDto,
  RecurringItemDto,
  ReimbursementDto,
  ReimbursementQueryDto,
  SalaryStructureDto,
  SaveCompensationDto,
  UpdatePayrollComponentDto,
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

/**
 * Payroll compensation (Phase 4) — the component catalog, salary
 * structures, employee compensation and its history, recurring earnings and
 * deductions, loans and advances, reimbursements, one-off entries ahead of
 * payroll, and the compensation import.
 *
 * Grants (`.manage` covers `.view`; `payroll.manage` covers all):
 *   components     payroll.components.*    (view also with payroll.view)
 *   compensation   payroll.compensation.*  (view with payroll.view, manage with payroll.edit — as salaries already were)
 *   loans          payroll.loans.*
 *   adjustments    payroll.adjustments.*   (view with payroll.view, manage with payroll.edit — as adjustments already were)
 * Never an employee or manager grant. tenant-service checks the same again.
 */
const COMPONENTS_VIEW = ['payroll.components.view', 'payroll.view', 'payroll.manage'];
const COMPONENTS_MANAGE = ['payroll.components.manage', 'payroll.manage'];
const COMPENSATION_VIEW = ['payroll.compensation.view', 'payroll.view', 'payroll.manage'];
const COMPENSATION_MANAGE = ['payroll.compensation.manage', 'payroll.edit', 'payroll.manage'];
const LOANS_VIEW = ['payroll.loans.view', 'payroll.manage'];
const LOANS_MANAGE = ['payroll.loans.manage', 'payroll.manage'];
const ADJUSTMENTS_VIEW = ['payroll.adjustments.view', 'payroll.view', 'payroll.manage'];
const ADJUSTMENTS_MANAGE = ['payroll.adjustments.manage', 'payroll.edit', 'payroll.manage'];

@Controller('organization/payroll/compensation')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PAYROLL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PAYROLL)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class PayrollCompensationController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  private send(pattern: string, payload: Record<string, unknown>) {
    return this.tenantClient.send(pattern, payload);
  }

  // ── Components ────────────────────────────────────────────────────────────

  @Get('components')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPONENTS_VIEW)
  @ApiOperation({ summary: 'The payroll component catalog — earnings, deductions and employer contributions' })
  listComponents(@Headers('x-tenant-id') tenantId: string, @Query() query: ComponentQueryDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_COMPONENTS, { tenantId, query });
  }

  @Get('components/options')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPONENTS_VIEW)
  @ApiOperation({ summary: 'Categories for each component type, and what can’t be part of a compensation' })
  componentOptions(@Headers('x-tenant-id') tenantId: string) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.COMPONENT_OPTIONS, { tenantId });
  }

  @Post('components')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPONENTS_MANAGE)
  @ApiOperation({ summary: 'Add a component. Its calculation base must be explicit' })
  createComponent(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreatePayrollComponentDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_COMPONENT, { tenantId, dto });
  }

  @Put('components/:id')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPONENTS_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Edit a component. Nobody’s pay changes until their compensation is revised' })
  updateComponent(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePayrollComponentDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_COMPONENT, { tenantId, id, dto });
  }

  @Post('components/:id/status')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPONENTS_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Enable or disable a component for new compensation' })
  setComponentStatus(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ComponentStatusDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.SET_COMPONENT_STATUS, { tenantId, id, dto });
  }

  // ── Salary structures ─────────────────────────────────────────────────────

  @Get('structures')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPENSATION_VIEW)
  @ApiOperation({ summary: 'Salary structures and how many employees were assigned each' })
  listStructures(@Headers('x-tenant-id') tenantId: string) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_STRUCTURES, { tenantId });
  }

  @Post('structures')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPENSATION_MANAGE)
  @ApiOperation({ summary: 'Create a salary structure' })
  createStructure(@Headers('x-tenant-id') tenantId: string, @Body() dto: SalaryStructureDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_STRUCTURE, { tenantId, dto });
  }

  @Put('structures/:id')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPENSATION_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Edit a structure. Employees already on it keep what they were assigned' })
  updateStructure(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SalaryStructureDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_STRUCTURE, { tenantId, id, dto });
  }

  // ── Employee compensation ─────────────────────────────────────────────────

  @Get('employees')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPENSATION_VIEW)
  @ApiOperation({ summary: 'Every current employee with the compensation in effect today' })
  listEmployees(@Headers('x-tenant-id') tenantId: string) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_EMPLOYEES, { tenantId });
  }

  @Get('employees/:employeeId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPENSATION_VIEW)
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'An employee’s compensation now, what is scheduled, and the history' })
  getCompensation(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.GET_COMPENSATION, { tenantId, employeeId });
  }

  @Post('employees/:employeeId/preview')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPENSATION_VIEW)
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'Work out a compensation without saving it' })
  previewCompensation(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Body() dto: SaveCompensationDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.PREVIEW_COMPENSATION, { tenantId, employeeId, dto });
  }

  @Put('employees/:employeeId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPENSATION_MANAGE)
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'Save compensation from an effective date — a new revision; never into an approved month' })
  saveCompensation(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Body() dto: SaveCompensationDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.SAVE_COMPENSATION, { tenantId, employeeId, dto });
  }

  @Get('employees/:employeeId/recurring')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...COMPENSATION_VIEW)
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'An employee’s recurring earnings and deductions' })
  listRecurring(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_RECURRING, { tenantId, employeeId });
  }

  @Post('employees/:employeeId/recurring')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPENSATION_MANAGE)
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'Add a recurring earning or deduction' })
  createRecurring(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Body() dto: RecurringItemDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_RECURRING, { tenantId, employeeId, dto });
  }

  @Put('recurring/:id')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPENSATION_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Change or stop a recurring item — for payroll calculated from now on' })
  updateRecurring(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecurringItemDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_RECURRING, { tenantId, id, dto });
  }

  @Post('import')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...COMPENSATION_MANAGE)
  @ApiOperation({ summary: 'Check (and, with apply, save) a compensation CSV. All rows or none' })
  importCompensation(@Headers('x-tenant-id') tenantId: string, @Body() dto: CompensationImportDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.IMPORT, { tenantId, dto });
  }

  // ── Loans & advances ──────────────────────────────────────────────────────

  @Get('loans')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...LOANS_VIEW)
  @ApiOperation({ summary: 'Loans and advances with recovered and remaining balances' })
  listLoans(@Headers('x-tenant-id') tenantId: string, @Query() query: LoanQueryDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_LOANS, { tenantId, query });
  }

  @Post('loans')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...LOANS_MANAGE)
  @ApiOperation({ summary: 'Record a loan or advance and its monthly recovery' })
  createLoan(@Headers('x-tenant-id') tenantId: string, @Body() dto: LoanDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_LOAN, { tenantId, dto });
  }

  @Put('loans/:id')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...LOANS_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Change a loan’s future recovery, or put it on hold / cancel it' })
  updateLoan(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LoanDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_LOAN, { tenantId, id, dto });
  }

  // ── Reimbursements ────────────────────────────────────────────────────────

  @Get('reimbursements')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...ADJUSTMENTS_VIEW)
  @ApiOperation({ summary: 'Expense claims and where they are' })
  listReimbursements(@Headers('x-tenant-id') tenantId: string, @Query() query: ReimbursementQueryDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_REIMBURSEMENTS, { tenantId, query });
  }

  @Post('reimbursements')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...ADJUSTMENTS_MANAGE)
  @ApiOperation({ summary: 'Record a claim for an employee (submitted, not yet approved)' })
  createReimbursement(@Headers('x-tenant-id') tenantId: string, @Body() dto: ReimbursementDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_REIMBURSEMENT, { tenantId, dto });
  }

  @Post('reimbursements/:id/decision')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...ADJUSTMENTS_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Approve or reject a claim. Only approved claims are paid' })
  decideReimbursement(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideReimbursementDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.DECIDE_REIMBURSEMENT, { tenantId, id, dto });
  }

  // ── One-off entries ───────────────────────────────────────────────────────

  @Get('adjustments')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...ADJUSTMENTS_VIEW)
  @ApiOperation({ summary: 'Bonuses, commissions, arrears and deductions by payroll month' })
  listAdjustments(@Headers('x-tenant-id') tenantId: string, @Query() query: AdjustmentEntryQueryDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_ADJUSTMENTS, { tenantId, query });
  }

  @Post('adjustments')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...ADJUSTMENTS_MANAGE)
  @ApiOperation({ summary: 'Add a one-off earning or deduction to an employee’s payroll month' })
  createAdjustment(@Headers('x-tenant-id') tenantId: string, @Body() dto: AdjustmentEntryDto) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_ADJUSTMENT, { tenantId, dto });
  }

  @Delete('adjustments/:id')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions(...ADJUSTMENTS_MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Remove an entry — waiting for its payroll, or on a payroll in Review' })
  removeAdjustment(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.send(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.REMOVE_ADJUSTMENT, { tenantId, id });
  }
}
