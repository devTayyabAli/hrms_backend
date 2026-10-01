import {
  Body,
  Controller,
  Delete,
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
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { sendCsvExport } from '../utils/csv-export.helper';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  AddPayrollAdjustmentDto,
  CreatePayrollRunDto,
  DashboardLimitDto,
  EmailRunPayslipsDto,
  ListPayslipsQueryDto,
  GetPayrollHistoryQueryDto,
  GetPayrollRecordsQueryDto,
  PayPayrollRunDto,
  ReturnPayrollRunDto,
  SetEmployeeBankDto,
  SetEmployeeSalaryDto,
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

/**
 * Payroll — the dashboard, the monthly run and the salaries it pays from.
 *
 * A run is created for one calendar month in Review, where every line is
 * calculated from salary, attendance and approved leave. It then moves one
 * step at a time: submit (payroll.edit) → approve (payroll.approve, locks it)
 * → mark paid (payroll.approve). An approver can return it from Approval to
 * Review. Lines change only through audited adjustments, only in Review.
 *
 * Salary and bank details live here rather than on the employee routes:
 * they need payroll permissions, not employee ones, so a manager who can see
 * their department's employees can't see what they earn.
 */
@Controller('organization/payroll')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PAYROLL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PAYROLL)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class PayrollController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  // ── Dashboard ─────────────────────────────────────────────────────────────

  @Get('overview')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({ summary: 'KPI cards — gross, employees, deductions and net pay from the latest run' })
  getOverview(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_OVERVIEW, { tenantId });
  }

  @Get('cycle')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({
    summary:
      'Payroll Cycle panel — current period and its label, pay date, the next period and pay date, and where the run sits on the stepper',
  })
  getCycle(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_CYCLE, { tenantId });
  }

  @Get('runs/:payrollRunId/checks')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId', description: 'Payroll Run ID' })
  @ApiOperation({
    summary:
      'Payroll Process panels — Validation Checks, Exceptions & Warnings and Processing Progress, plus whether the run may advance to Payment',
  })
  getProcessChecks(
    @Headers('x-tenant-id') tenantId: string,
    @Param('payrollRunId') payrollRunId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_PROCESS_CHECKS, {
      tenantId,
      payrollRunId,
    });
  }

  @Get('records/export')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EXPORT)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({
    summary: 'Export the Employee Payroll Summary for a run as CSV. Defaults to the latest run',
  })
  async exportRecords(
    @Headers('x-tenant-id') tenantId: string,
    @Query('payrollRunId') payrollRunId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.PAYROLL.EXPORT_RECORDS,
      { tenantId, payrollRunId },
      'payroll-records',
      [
        { header: 'Employee ID', value: (row) => row.employeeCode },
        { header: 'Name', value: (row) => row.name },
        { header: 'Department', value: (row) => row.department },
        { header: 'Designation', value: (row) => row.designation },
        { header: 'Basic Salary', value: (row) => row.basicSalary },
        { header: 'Allowances', value: (row) => row.allowances },
        { header: 'Bonus', value: (row) => row.bonus },
        { header: 'Gross Pay', value: (row) => row.grossPay },
        { header: 'Deductions (before tax)', value: (row) => row.normalDeductions },
        { header: 'Income Tax', value: (row) => row.incomeTax },
        { header: 'Statutory Deductions', value: (row) => row.statutoryDeductions },
        { header: 'Total Deductions', value: (row) => row.deductions },
        { header: 'Net Pay', value: (row) => row.netPay },
        { header: 'Employer Contributions', value: (row) => row.employerContributions },
        { header: 'Status', value: (row) => row.status },
      ],
    );
  }

  @Get('breakdown')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({ summary: 'Payroll Breakdown donut — basic, allowances, adjustments and deductions' })
  getBreakdown(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_BREAKDOWN, { tenantId });
  }

  @Get('history')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({ summary: 'Payroll History bars — net pay per month, including months with no run' })
  getHistory(@Headers('x-tenant-id') tenantId: string, @Query() query: GetPayrollHistoryQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_HISTORY, { tenantId, query });
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  @Get('runs')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({ summary: 'Payroll runs, newest period first, with who created, approved and paid each' })
  getRuns(@Headers('x-tenant-id') tenantId: string, @Query() query: DashboardLimitDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RUNS, { tenantId, query });
  }

  @Post('runs')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.CREATE)
  @RequirePermissions('payroll.create', 'payroll.manage')
  @ApiOperation({
    summary:
      'Open a month’s payroll in Review and calculate every line from salary, attendance and approved leave. One run per month',
  })
  createRun(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreatePayrollRunDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.CREATE_RUN, { tenantId, dto });
  }

  @Get('runs/:payrollRunId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'A run — stepper, totals, warnings and every employee line' })
  getRun(@Headers('x-tenant-id') tenantId: string, @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RUN, { tenantId, payrollRunId });
  }

  @Get('runs/:payrollRunId/activity')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'The run’s audit trail — created, recalculated, adjusted, submitted, approved, paid' })
  getRunActivity(@Headers('x-tenant-id') tenantId: string, @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RUN_ACTIVITY, { tenantId, payrollRunId });
  }

  @Post('runs/:payrollRunId/recalculate')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.edit', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'Review only — recompute every line from current data, keeping manual adjustments' })
  recalculateRun(@Headers('x-tenant-id') tenantId: string, @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.RECALCULATE_RUN, { tenantId, payrollRunId });
  }

  @Post('runs/:payrollRunId/submit')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.edit', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'Review → Approval. Refused while any line’s net pay is negative' })
  submitRun(@Headers('x-tenant-id') tenantId: string, @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.SUBMIT_RUN, { tenantId, payrollRunId });
  }

  @Post('runs/:payrollRunId/approve')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.approve', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'Approval → Payment. Locks the run. The submitter can’t approve their own run' })
  approveRun(@Headers('x-tenant-id') tenantId: string, @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.APPROVE_RUN, { tenantId, payrollRunId });
  }

  @Post('runs/:payrollRunId/return')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.approve', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'Approval → Review, with a reason for whoever prepares it' })
  returnRun(
    @Headers('x-tenant-id') tenantId: string,
    @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string,
    @Body() dto: ReturnPayrollRunDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.RETURN_RUN, { tenantId, payrollRunId, dto });
  }

  @Post('runs/:payrollRunId/pay')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.approve', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'Payment → Completed. Records the payment date and reference (no bank integration yet)' })
  payRun(
    @Headers('x-tenant-id') tenantId: string,
    @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string,
    @Body() dto: PayPayrollRunDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.PAY_RUN, { tenantId, payrollRunId, dto });
  }

  // ── Lines & adjustments ───────────────────────────────────────────────────

  @Get('records')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({ summary: 'Employee lines for a run. Omit payrollRunId for the latest run' })
  getRecords(@Headers('x-tenant-id') tenantId: string, @Query() query: GetPayrollRecordsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RECORDS, { tenantId, query });
  }

  @Get('records/:recordId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'recordId' })
  @ApiOperation({ summary: 'One line — days, proration, every earning and deduction, notes and adjustments' })
  getRecord(@Headers('x-tenant-id') tenantId: string, @Param('recordId', ParseUUIDPipe) recordId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RECORD, { tenantId, recordId });
  }

  @Post('records/:recordId/adjustments')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.edit', 'payroll.manage')
  @ApiParam({ name: 'recordId' })
  @ApiOperation({ summary: 'Review only — add a one-off earning or deduction with a reason' })
  addAdjustment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: AddPayrollAdjustmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.ADD_ADJUSTMENT, { tenantId, recordId, dto });
  }

  @Delete('adjustments/:adjustmentId')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.edit', 'payroll.manage')
  @ApiParam({ name: 'adjustmentId' })
  @ApiOperation({ summary: 'Review only — remove an adjustment (recorded in the audit log)' })
  removeAdjustment(@Headers('x-tenant-id') tenantId: string, @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.REMOVE_ADJUSTMENT, { tenantId, adjustmentId });
  }

  // ── Payslips (completed runs only) ────────────────────────────────────────

  @Get('payslips')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiOperation({ summary: 'Every payslip of completed payrolls, newest first — filter by month or search' })
  listPayslips(@Headers('x-tenant-id') tenantId: string, @Query() query: ListPayslipsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.LIST_PAYSLIPS, { tenantId, query });
  }

  @Get('runs/:payrollRunId/payslips')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({ summary: 'A completed run’s payslips, with email status and who is missing an email address' })
  getRunPayslips(@Headers('x-tenant-id') tenantId: string, @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RUN_PAYSLIPS, { tenantId, payrollRunId });
  }

  @Post('runs/:payrollRunId/payslips/email')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.approve', 'payroll.manage')
  @ApiParam({ name: 'payrollRunId' })
  @ApiOperation({
    summary:
      'Email every payslip of a completed run that hasn’t been sent (resend: true for all). Returns at once; sending runs in the background',
  })
  emailRunPayslips(
    @Headers('x-tenant-id') tenantId: string,
    @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string,
    @Body() dto: EmailRunPayslipsDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.EMAIL_RUN_PAYSLIPS, { tenantId, payrollRunId, dto });
  }

  @Get('records/:recordId/payslip')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'recordId' })
  @ApiOperation({ summary: 'The payslip for a line of a completed payroll — the locked snapshot, never recalculated' })
  getRecordPayslip(@Headers('x-tenant-id') tenantId: string, @Param('recordId', ParseUUIDPipe) recordId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RECORD_PAYSLIP, { tenantId, recordId });
  }

  @Get('records/:recordId/payslip/pdf')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'recordId' })
  @ApiOperation({ summary: 'Download the payslip as an A4 PDF' })
  async getRecordPayslipPdf(
    @Headers('x-tenant-id') tenantId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Res() res: Response,
  ) {
    const pdf = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_RECORD_PAYSLIP_PDF, { tenantId, recordId }),
    );
    return sendPdf(res, pdf as any);
  }

  @Post('records/:recordId/payslip/email')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.approve', 'payroll.manage')
  @ApiParam({ name: 'recordId' })
  @ApiOperation({ summary: 'Email one payslip (PDF attached) to the employee’s address on file' })
  emailRecordPayslip(@Headers('x-tenant-id') tenantId: string, @Param('recordId', ParseUUIDPipe) recordId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.EMAIL_RECORD_PAYSLIP, { tenantId, recordId });
  }

  // ── Salary & bank ─────────────────────────────────────────────────────────

  @Get('employees/:employeeId/pay')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions('payroll.view', 'payroll.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'An employee’s current salary, salary history and bank details' })
  getEmployeePay(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.GET_EMPLOYEE_PAY, { tenantId, employeeId });
  }

  @Put('employees/:employeeId/salary')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.edit', 'payroll.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({
    summary: 'Set a salary from an effective date. Adds to the salary history; never changes an approved run',
  })
  setEmployeeSalary(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: SetEmployeeSalaryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.SET_EMPLOYEE_SALARY, { tenantId, employeeId, dto });
  }

  @Put('employees/:employeeId/bank')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.EDIT)
  @RequirePermissions('payroll.edit', 'payroll.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'Bank name, account title, account number and IBAN for salary transfer' })
  setEmployeeBank(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: SetEmployeeBankDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PAYROLL.SET_EMPLOYEE_BANK, { tenantId, employeeId, dto });
  }
}
