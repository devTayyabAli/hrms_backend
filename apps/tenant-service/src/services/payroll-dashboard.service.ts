import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import {
  AddPayrollAdjustmentDto,
  AttendanceStatus,
  CreatePayrollRunDto,
  EmployeeStatus,
  EXPORT_MAX_ROWS,
  GetPayrollHistoryQueryDto,
  GetPayrollRecordsQueryDto,
  LeaveRequestStatus,
  PayPayrollRunDto,
  PayrollAdjustmentType,
  PayrollCycle,
  PayrollProcessStep,
  PolicyStatus,
  PolicyType,
  ReturnPayrollRunDto,
  SetEmployeeBankDto,
  SetEmployeeSalaryDto,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import { PayrollRunStatus } from '../models/payroll-run.model';
import { Tenant } from '../models/tenant.model';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { payrollActor, requireAnyPayrollPermission, requirePayrollPermission, writePayrollAudit } from './payroll-access';
import { PayslipService } from './payslip.service';
import { PayrollComplianceService } from './payroll-compliance.service';
import { PayrollCompensationService } from './payroll-compensation.service';
import { legacyCompensation } from './payroll-components';
import { calculateCompliance, taxYearOf, type ComplianceInput, type ComplianceResult } from './payroll-compliance';
import {
  calculatePayrollLine,
  compensationSegments,
  monthBounds,
  round2,
  salaryForPeriod,
  type PayrollAdjustmentInput,
  type PayrollLineResult,
} from './payroll-calculation';

const STEP_ORDER: PayrollProcessStep[] = [
  PayrollProcessStep.REVIEW,
  PayrollProcessStep.APPROVAL,
  PayrollProcessStep.PAYMENT,
  PayrollProcessStep.COMPLETED,
];

const STEP_LABELS: Record<PayrollProcessStep, string> = {
  [PayrollProcessStep.REVIEW]: 'Review',
  [PayrollProcessStep.APPROVAL]: 'Approval',
  [PayrollProcessStep.PAYMENT]: 'Payment',
  [PayrollProcessStep.COMPLETED]: 'Completed',
};

const ADJUSTMENT_LABELS: Record<string, string> = {
  BONUS: 'Bonus',
  ARREARS: 'Arrears',
  COMMISSION: 'Commission',
  REIMBURSEMENT: 'Reimbursement',
  OTHER: 'One-off Earning',
};

/** The action that moves a run out of each stage, and who may take it. */
const NEXT_ACTION: Record<PayrollProcessStep, { step: PayrollProcessStep; label: string; permission: string } | null> = {
  [PayrollProcessStep.REVIEW]: { step: PayrollProcessStep.APPROVAL, label: 'Submit for approval', permission: 'payroll.edit' },
  [PayrollProcessStep.APPROVAL]: { step: PayrollProcessStep.PAYMENT, label: 'Approve payroll', permission: 'payroll.approve' },
  [PayrollProcessStep.PAYMENT]: { step: PayrollProcessStep.COMPLETED, label: 'Mark as paid', permission: 'payroll.approve' },
  [PayrollProcessStep.COMPLETED]: null,
};

/** Employed and paid as normal. RESIGNED / INACTIVE are paid only up to an exit date. */
const CURRENT_STATUSES = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

type Skipped = { employeeId: string; employeeCode: string; name: string; reason: string };
type ActorKey = 'created' | 'submitted' | 'approved' | 'returned' | 'paid';

function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? round2(n) : 0;
}

const days = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const today = () => new Date().toISOString().slice(0, 10);

const nameOf = (employee: { firstName?: string; lastName?: string } | null | undefined) =>
  employee ? [employee.firstName, employee.lastName].filter(Boolean).join(' ') : '';

const periodLabel = (periodStart: string) =>
  new Date(`${String(periodStart).slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** "0123-4567890-01" → "•••• 0-01": enough to recognise, not to use. */
const mask = (value: string | null | undefined) => (value ? `•••• ${String(value).slice(-4)}` : null);

/** A line's compliance: the engine's result and the snapshot that reproduces it. */
interface LineCompliance {
  result: ComplianceResult;
  notes: string[];
  snapshot: Record<string, any>;
}

/**
 * Runs the compliance engine and packs what's needed to run it again: a copy
 * of each rule used and every input. Recalculating from the snapshot (after
 * an adjustment in Review) gives the same answer the original calculation
 * would have, and a later rule change never reaches it.
 */
const runCompliance = (input: ComplianceInput, extraNotes: string[] = []): LineCompliance => {
  const result = calculateCompliance(input);
  const { rules, ...inputs } = input;
  return {
    result,
    notes: [...extraNotes, ...result.notes],
    snapshot: { version: 1, calculatedAt: new Date().toISOString(), rules, inputs, extraNotes, result },
  };
};

const complianceColumns = (c?: LineCompliance) => ({
  taxYear: c?.result.taxYear ?? null,
  taxableIncome: c?.result.taxableIncome ?? 0,
  incomeTax: c?.result.incomeTax ?? 0,
  eobiEmployee: c?.result.eobiEmployee ?? 0,
  eobiEmployer: c?.result.eobiEmployer ?? 0,
  pfEmployee: c?.result.pfEmployee ?? 0,
  pfEmployer: c?.result.pfEmployer ?? 0,
  statutoryDeductions: c?.result.statutoryDeductions ?? 0,
  employerContributions: c?.result.employerContributions ?? 0,
  complianceSnapshot: c?.snapshot ?? null,
});

function monthWindow(count: number, now = new Date()) {
  const months: { key: string; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const label = date.toLocaleString('en-US', { month: 'short' });
    months.push({ key, label });
  }
  return months;
}

/**
 * Payroll: the dashboard, the monthly run and its lifecycle, and the salary
 * and bank details payroll pays from.
 *
 * Review → Approval → Payment → Completed, one step at a time:
 * - Review is the only editable stage (recalculate, adjustments);
 * - approving locks the run — lines and adjustments can no longer change;
 * - an approver can send a run back to Review from Approval, with a reason;
 * - marking it paid records the payment date and completes it.
 *
 * Permissions are checked here as well as at the gateway: `payroll.create`
 * to start a run, `payroll.edit` to prepare and submit it and to set salaries,
 * `payroll.approve` to approve, return and mark paid (`payroll.manage` covers
 * all of them). Every change is written to the organization's audit log.
 */
@Injectable()
export class PayrollDashboardService {
  private readonly logger = new Logger(PayrollDashboardService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() @InjectModel(Tenant) private readonly tenantModel?: typeof Tenant,
    @Optional() private readonly payslips?: PayslipService,
    @Optional() private readonly compliance?: PayrollComplianceService,
    @Optional() private readonly compensation?: PayrollCompensationService,
  ) {}

  // ── Errors ────────────────────────────────────────────────────────────────

  private fail(message: string, status: HttpStatus): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private notFound(what: string, id: string): never {
    this.fail(`${what} '${id}' not found in this organization.`, HttpStatus.NOT_FOUND);
  }

  private badRequest(message: string): never {
    this.fail(message, HttpStatus.BAD_REQUEST);
  }

  private conflict(message: string): never {
    this.fail(message, HttpStatus.CONFLICT);
  }

  // ── Who is acting ─────────────────────────────────────────────────────────

  private actor() {
    return payrollActor();
  }

  private requirePermission(permission: string, what: string) {
    requirePayrollPermission(permission, what);
  }

  private audit(
    tenantId: string,
    tableName: string,
    recordId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    changes: Record<string, { from: unknown; to: unknown }>,
  ) {
    return writePayrollAudit(this.modelProvider, this.logger, tenantId, tableName, recordId, action, changes);
  }

  /** Employees' names by login email — how "Approved by" becomes a name. */
  private async namesByEmail(tenantId: string, emails: (string | null | undefined)[]) {
    const wanted = [...new Set(emails.filter(Boolean).map((email) => String(email).toLowerCase()))];
    const names = new Map<string, string>();
    if (!wanted.length) return names;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = await Employee.findAll({
      where: { tenantId, email: { [Op.iLike]: { [Op.any]: wanted } } } as any,
      attributes: ['email', 'firstName', 'lastName'],
    });
    for (const row of rows as any[]) names.set(String(row.email).toLowerCase(), nameOf(row));
    return names;
  }

  // ── Shapes ────────────────────────────────────────────────────────────────

  private statusForStep(step: PayrollProcessStep): PayrollRunStatus {
    if (step === PayrollProcessStep.COMPLETED) return PayrollRunStatus.COMPLETED;
    if (step === PayrollProcessStep.REVIEW) return PayrollRunStatus.DRAFT;
    return PayrollRunStatus.PROCESSING;
  }

  private lineStatus(step: PayrollProcessStep): string {
    switch (step) {
      case PayrollProcessStep.REVIEW:
        return 'IN_REVIEW';
      case PayrollProcessStep.APPROVAL:
        return 'AWAITING_APPROVAL';
      case PayrollProcessStep.PAYMENT:
        return 'AWAITING_PAYMENT';
      default:
        return 'PAID';
    }
  }

  private steps(current: PayrollProcessStep) {
    const currentIndex = STEP_ORDER.indexOf(current);
    return STEP_ORDER.map((key, index) => ({
      key,
      label: STEP_LABELS[key],
      state: index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'upcoming',
    }));
  }

  private async employeeInclude(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    return {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'],
      include: [
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
        { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
      ],
    };
  }

  private person(employee: any) {
    if (!employee) return null;
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: nameOf(employee),
      avatarUrl: employee.avatarUrl ?? null,
      department: employee.department ? { id: employee.department.id, name: employee.department.name } : null,
      designation: employee.designation ? { id: employee.designation.id, title: employee.designation.title } : null,
    };
  }

  /** One row of the run's table. */
  private recordRow(record: any, step: PayrollProcessStep, adjustmentCount = 0) {
    return {
      id: record.id,
      payrollRunId: record.payrollRunId,
      employee: this.person(record.employee),
      basicSalary: money(record.basicSalary),
      allowances: money(record.allowances),
      workingDays: days(record.workingDays),
      eligibleDays: days(record.eligibleDays),
      paidDays: days(record.paidDays),
      absenceDays: days(record.absenceDays),
      unpaidLeaveDays: days(record.unpaidLeaveDays),
      prorationFactor: Number(record.prorationFactor ?? 1),
      grossPay: money(record.grossPay),
      unpaidDeduction: round2(money(record.absenceDeduction) + money(record.unpaidLeaveDeduction)),
      deductions: money(record.deductions),
      netPay: money(record.netPay),
      bonus: money(record.bonus),
      // Lines from before compliance existed carry no snapshot; their whole
      // deduction was the normal kind.
      normalDeductions: record.complianceSnapshot ? money(record.normalDeductions) : money(record.deductions),
      incomeTax: money(record.incomeTax),
      statutoryDeductions: money(record.statutoryDeductions),
      employerContributions: money(record.employerContributions),
      hasCompliance: Boolean(record.complianceSnapshot),
      adjustmentCount,
      noteCount: (record.notes ?? []).length,
      status: this.lineStatus(step),
    };
  }

  /** The line's full calculation, for the detail drawer. */
  private recordDetail(record: any, step: PayrollProcessStep, adjustments: any[], names: Map<string, string>) {
    return {
      ...this.recordRow(record, step, adjustments.length),
      salaryEffectiveFrom: record.salaryEffectiveFrom ?? null,
      employedFrom: record.employedFrom ?? null,
      employedTo: record.employedTo ?? null,
      paidLeaveDays: days(record.paidLeaveDays),
      unrecordedDays: days(record.unrecordedDays),
      dailyRate: money(record.dailyRate),
      earnings: {
        basic: money(record.earnedBasic),
        allowances: money(record.earnedAllowances),
        overtime: money(record.overtimePay),
        overtimeMinutes: Number(record.overtimeMinutes ?? 0),
        adjustments: money(record.bonus),
        gross: money(record.grossPay),
      },
      deductionBreakdown: {
        absence: money(record.absenceDeduction),
        unpaidLeave: money(record.unpaidLeaveDeduction),
        recurring: money(record.recurringDeductions),
        adjustments: money(record.adjustmentDeductions),
        normal: record.complianceSnapshot ? money(record.normalDeductions) : money(record.deductions),
        statutory: money(record.statutoryDeductions),
        total: money(record.deductions),
      },
      compliance: this.complianceDetail(record),
      /**
       * Every earning, deduction and employer contribution with how it was
       * worked out, and the compensation segments it was paid from. Null on
       * lines calculated before components existed.
       */
      breakdown: record.components
        ? {
            earnings: record.components.earnings ?? [],
            deductions: record.components.deductions ?? [],
            employer: record.components.employer ?? [],
            segments: record.components.segments ?? [],
          }
        : null,
      loanRecovery: money(record.loanRecovery),
      notes: record.notes ?? [],
      bank: {
        bankName: record.bankName ?? null,
        bankAccountTitle: record.bankAccountTitle ?? null,
        bankAccountNumber: record.bankAccountNumber ?? null,
        iban: record.iban ?? null,
      },
      adjustments: adjustments.map((adjustment) => ({
        id: adjustment.id,
        type: adjustment.type,
        amount: money(adjustment.amount),
        category: adjustment.category ?? 'OTHER',
        reason: adjustment.reason,
        createdAt: adjustment.createdAt,
        createdBy: adjustment.createdByEmail
          ? { email: adjustment.createdByEmail, name: names.get(adjustment.createdByEmail) ?? null }
          : null,
      })),
      editable: step === PayrollProcessStep.REVIEW,
    };
  }

  /**
   * How the line's tax and contributions were worked out, from its snapshot:
   * the rules used (by name and dates, not their figures) and each step.
   */
  private complianceDetail(record: any) {
    const snapshot = record.complianceSnapshot;
    if (!snapshot?.result) return null;
    const r = snapshot.result;
    const ruleRef = (rule: any) =>
      rule ? { id: rule.id, name: rule.name, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo ?? null } : null;
    return {
      calculatedAt: snapshot.calculatedAt ?? null,
      taxYear: r.taxYear,
      taxYearMonth: r.taxYearMonth,
      remainingMonths: r.remainingMonths,
      rules: {
        incomeTax: ruleRef(snapshot.rules?.incomeTax),
        eobi: ruleRef(snapshot.rules?.eobi),
        providentFund: ruleRef(snapshot.rules?.pf),
      },
      tax: {
        taxableIncome: money(r.taxableIncome),
        exemptIncome: money(r.exemptIncome),
        annualTaxableIncome: money(r.annualTaxableIncome),
        annualTax: money(r.annualTax),
        yearToDateTax: money(snapshot.inputs?.ytd?.incomeTax),
        incomeTax: money(r.incomeTax),
        adjustmentPortion: money(r.taxAdjustmentPortion),
        steps: r.taxSteps ?? [],
      },
      eobi: { wage: money(r.eobiWage), employee: money(r.eobiEmployee), employer: money(r.eobiEmployer) },
      providentFund: { base: money(r.pfBase), employee: money(r.pfEmployee), employer: money(r.pfEmployer) },
      statutoryDeductions: money(r.statutoryDeductions),
      employerContributions: money(r.employerContributions),
    };
  }

  private runSummary(run: any, names: Map<string, string> = new Map()) {
    const step = (run.step as PayrollProcessStep) ?? PayrollProcessStep.REVIEW;
    const emails = run.actorEmails ?? {};
    const by = (key: ActorKey) =>
      emails[key] ? { email: emails[key], name: names.get(String(emails[key]).toLowerCase()) ?? null } : null;
    return {
      id: run.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      periodLabel: periodLabel(run.periodStart),
      step,
      status: run.status,
      steps: this.steps(step),
      nextAction: NEXT_ACTION[step] ?? null,
      /** Approved runs can't change any more. */
      locked: step !== PayrollProcessStep.REVIEW,
      currency: run.currency ?? null,
      employees: run.employeeCount ?? 0,
      totalPayroll: money(run.grossPay),
      grossPay: money(run.grossPay),
      deductions: money(run.deductions),
      netPay: money(run.netPay),
      skippedEmployees: run.skippedEmployees ?? [],
      calculatedAt: run.calculatedAt ?? null,
      createdBy: by('created'),
      submittedAt: run.submittedAt ?? null,
      submittedBy: by('submitted'),
      approvedAt: run.approvedAt ?? null,
      approvedBy: by('approved'),
      returnedAt: run.returnedAt ?? null,
      returnedBy: by('returned'),
      returnReason: run.returnReason ?? null,
      paidAt: run.paidAt ?? null,
      paidBy: by('paid'),
      paymentDate: run.paymentDate ?? null,
      paymentReference: run.paymentReference ?? null,
      processedAt: run.processedAt ?? null,
      cycle: run.cycle ?? PayrollCycle.MONTHLY,
      payDate: run.payDate ?? null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private async summaries(tenantId: string, runs: any[]) {
    const names = await this.namesByEmail(
      tenantId,
      runs.flatMap((run) => Object.values(run.actorEmails ?? {}) as string[]),
    );
    return runs.map((run) => this.runSummary(run, names));
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /** The Export button on Employee Payroll Summary. */
  async exportRecords(tenantId: string, payrollRunId?: string) {
    const runId = payrollRunId ?? (await this.latestRun(tenantId))?.id;
    if (!runId) {
      return { rows: [], totalMatched: 0, truncated: false, limit: EXPORT_MAX_ROWS };
    }

    const run = await this.loadRun(tenantId, runId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const rows = await Record.findAll({
      where: { tenantId, payrollRunId: runId },
      include: [await this.employeeInclude(tenantId)],
      order: [['createdAt', 'ASC']],
      limit: EXPORT_MAX_ROWS,
    });
    const total = await Record.count({ where: { tenantId, payrollRunId: runId } });
    const step = this.stepOf(run);

    return {
      rows: (rows as any[]).map((row) => {
        const line = this.recordRow(row, step, 0);
        return {
          employeeCode: line.employee?.employeeCode ?? null,
          name: line.employee?.name ?? null,
          department: line.employee?.department?.name ?? null,
          designation: line.employee?.designation?.title ?? null,
          basicSalary: line.basicSalary,
          allowances: line.allowances,
          bonus: line.bonus,
          grossPay: line.grossPay,
          normalDeductions: line.normalDeductions,
          incomeTax: line.incomeTax,
          statutoryDeductions: line.statutoryDeductions,
          deductions: line.deductions,
          netPay: line.netPay,
          employerContributions: line.employerContributions,
          status: line.status,
        };
      }),
      totalMatched: total,
      truncated: total > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  private async latestRun(tenantId: string) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    return Run.findOne({ where: { tenantId }, order: [['periodEnd', 'DESC'], ['createdAt', 'DESC']] });
  }

  private async loadRun(tenantId: string, payrollRunId: string) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const run = await Run.findOne({ where: { id: payrollRunId, tenantId } });
    if (!run) this.notFound('Payroll run', payrollRunId);
    return run;
  }

  private stepOf(run: any): PayrollProcessStep {
    return (run.step as PayrollProcessStep) ?? PayrollProcessStep.REVIEW;
  }

  private assertInReview(run: any, what: string) {
    if (this.stepOf(run) !== PayrollProcessStep.REVIEW) {
      this.badRequest(`This payroll is ${STEP_LABELS[this.stepOf(run)].toLowerCase()} and locked — ${what} is only possible in Review.`);
    }
  }

  private async recompute(tenantId: string, payrollRunId: string) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const rows = (await Record.findAll({ where: { tenantId, payrollRunId }, raw: true })) as any[];
    const totals = rows.reduce(
      (sum, row) => {
        sum.grossPay += money(row.grossPay);
        sum.deductions += money(row.deductions);
        sum.netPay += money(row.netPay);
        return sum;
      },
      { grossPay: 0, deductions: 0, netPay: 0 },
    );
    const run = await this.loadRun(tenantId, payrollRunId);
    await run.update({
      employeeCount: rows.length,
      grossPay: round2(totals.grossPay),
      deductions: round2(totals.deductions),
      netPay: round2(totals.netPay),
    });
    return run;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  /** KPI cards from the latest payroll run. */
  async getOverview(tenantId: string) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const latest = await this.latestRun(tenantId);
    const [completedRuns, processingRuns, draftRuns, failedRuns] = await Promise.all([
      Run.count({ where: { tenantId, status: PayrollRunStatus.COMPLETED } }),
      Run.count({ where: { tenantId, status: PayrollRunStatus.PROCESSING } }),
      Run.count({ where: { tenantId, status: PayrollRunStatus.DRAFT } }),
      Run.count({ where: { tenantId, status: PayrollRunStatus.FAILED } }),
    ]);

    // "Pending Approval" counts the people waiting on a decision, not the
    // runs — the card sits beside "Employees Paid", so it has to be in the
    // same unit to be comparable.
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const awaiting = await Run.findAll({
      where: {
        tenantId,
        step: { [Op.in]: [PayrollProcessStep.REVIEW, PayrollProcessStep.APPROVAL] },
      },
      attributes: ['id'],
      raw: true,
    });
    const pendingApproval = (awaiting as any[]).length
      ? await Record.count({
          where: { tenantId, payrollRunId: { [Op.in]: (awaiting as any[]).map((r) => r.id) } },
        })
      : 0;

    return {
      totalPayroll: money(latest?.grossPay),
      totalEmployees: latest?.employeeCount ?? 0,
      // The "Employees Paid" card: only a completed run has actually paid.
      employeesPaid:
        latest?.step === PayrollProcessStep.COMPLETED ? (latest?.employeeCount ?? 0) : 0,
      pendingApproval,
      deductions: money(latest?.deductions),
      netPay: money(latest?.netPay),
      grossPay: money(latest?.grossPay),
      latestRun: latest ? (await this.summaries(tenantId, [latest]))[0] : null,
      completedRuns,
      processingRuns,
      draftRuns,
      failedRuns,
    };
  }

  /**
   * The Payroll Cycle panel: which period is current, when it pays, and when
   * the next run is due.
   *
   * `nextPayDate` is projected from the latest run's cycle rather than
   * stored, so it stays correct when a run is created late or the cycle is
   * changed — a stored date would quietly describe a schedule nobody is on.
   */
  async getCycle(tenantId: string) {
    const latest = await this.latestRun(tenantId);
    if (!latest) {
      return {
        currentRun: null,
        cycle: PayrollCycle.MONTHLY,
        periodLabel: null,
        payDate: null,
        nextPeriodStart: null,
        nextPayDate: null,
        steps: this.steps(PayrollProcessStep.REVIEW).map((entry) => ({ ...entry, state: 'upcoming' })),
        nextAction: null,
      };
    }

    const run = latest as any;
    const cycle = (run.cycle as PayrollCycle) ?? PayrollCycle.MONTHLY;
    const payDate = run.payDate ?? this.defaultPayDate(run.periodEnd, cycle);
    const step = this.stepOf(run);

    return {
      currentRun: this.runSummary(run),
      cycle,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      periodLabel: periodLabel(run.periodStart),
      payDate,
      nextPeriodStart: this.addCycle(run.periodEnd, cycle, 1),
      nextPayDate: this.addCycle(payDate, cycle, 1),
      steps: this.steps(step),
      nextAction: NEXT_ACTION[step] ?? null,
    };
  }

  /**
   * Pay day when none was set: a monthly period pays 20 days after it ends,
   * shorter cycles pay 5 days after. A guess, but a visible one the client
   * can override by setting `payDate` on the run.
   */
  private defaultPayDate(periodEnd: string, cycle: PayrollCycle): string {
    const offset = cycle === PayrollCycle.MONTHLY ? 20 : 5;
    return this.shiftDays(periodEnd, offset);
  }

  private shiftDays(date: string, days: number): string {
    const [year, month, day] = String(date).slice(0, 10).split('-').map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, day + days));
    return shifted.toISOString().slice(0, 10);
  }

  private addCycle(date: string | null, cycle: PayrollCycle, periods: number): string | null {
    if (!date) return null;
    if (cycle === PayrollCycle.WEEKLY) return this.shiftDays(date, 7 * periods);
    if (cycle === PayrollCycle.BI_WEEKLY) return this.shiftDays(date, 14 * periods);
    const [year, month, day] = String(date).slice(0, 10).split('-').map(Number);
    // Calendar-month arithmetic, so the 31st does not drift to the 1st.
    const target = new Date(Date.UTC(year, month - 1 + periods, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
  }

  /** Payroll Breakdown donut — Basic, Allowances, Adjustments (bonus) and Deductions for the latest run. */
  async getBreakdown(tenantId: string) {
    const latest = await this.latestRun(tenantId);
    if (!latest) {
      return { payrollRunId: null, slices: this.slices({ basicSalary: 0, allowances: 0, bonus: 0, deductions: 0 }) };
    }

    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const rows = (await Record.findAll({
      where: { tenantId, payrollRunId: latest.id },
      attributes: ['earnedBasic', 'earnedAllowances', 'overtimePay', 'bonus', 'deductions'],
      raw: true,
    })) as any[];

    const totals = rows.reduce(
      (sum, row) => {
        sum.basicSalary += money(row.earnedBasic);
        sum.allowances += money(row.earnedAllowances) + money(row.overtimePay);
        sum.bonus += money(row.bonus);
        sum.deductions += money(row.deductions);
        return sum;
      },
      { basicSalary: 0, allowances: 0, bonus: 0, deductions: 0 },
    );

    return { payrollRunId: latest.id, slices: this.slices(totals) };
  }

  private slices(totals: { basicSalary: number; allowances: number; bonus: number; deductions: number }) {
    const parts = [
      { key: 'basicSalary', label: 'Basic Salary', amount: round2(totals.basicSalary) },
      { key: 'allowances', label: 'Allowances', amount: round2(totals.allowances) },
      { key: 'bonus', label: 'Bonus', amount: round2(totals.bonus) },
      { key: 'deductions', label: 'Deductions', amount: round2(totals.deductions) },
    ];
    const total = parts.reduce((sum, part) => sum + part.amount, 0);
    return parts.map((part) => ({ ...part, percentage: total > 0 ? round2((part.amount / total) * 100) : 0 }));
  }

  /** Payroll History bars — net pay per calendar month. Empty months stay at zero. */
  async getHistory(tenantId: string, query: GetPayrollHistoryQueryDto = {}) {
    const months = query.months ?? 6;
    const window = monthWindow(months);
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const runs = await Run.findAll({
      where: { tenantId },
      attributes: ['periodEnd', 'netPay', 'grossPay', 'deductions'],
      raw: true,
    });

    const buckets = new Map<string, { netPay: number; grossPay: number; deductions: number }>();
    for (const run of runs as any[]) {
      const key = String(run.periodEnd).slice(0, 7);
      const current = buckets.get(key) ?? { netPay: 0, grossPay: 0, deductions: 0 };
      current.netPay += money(run.netPay);
      current.grossPay += money(run.grossPay);
      current.deductions += money(run.deductions);
      buckets.set(key, current);
    }

    return {
      months,
      points: window.map((month) => {
        const bucket = buckets.get(month.key);
        return {
          period: month.key,
          label: month.label,
          netPay: round2(bucket?.netPay ?? 0),
          grossPay: round2(bucket?.grossPay ?? 0),
          deductions: round2(bucket?.deductions ?? 0),
        };
      }),
    };
  }

  async getRuns(tenantId: string, limit = 12) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const rows = await Run.findAll({
      where: { tenantId },
      order: [['periodEnd', 'DESC'], ['createdAt', 'DESC']],
      limit: Math.min(Math.max(limit ?? 12, 1), 100),
    });
    return this.summaries(tenantId, rows);
  }

  /** A run with its stepper, totals and every line. */
  async getRun(tenantId: string, payrollRunId: string) {
    const run = await this.loadRun(tenantId, payrollRunId);
    const records = await this.listRecords(tenantId, payrollRunId, 1000);
    const [summary] = await this.summaries(tenantId, [run]);
    const rows = records.rows;
    return {
      ...summary,
      adjustments: {
        earnings: round2(rows.reduce((sum, row) => sum + row.bonus, 0)),
        count: rows.reduce((sum, row) => sum + row.adjustmentCount, 0),
      },
      warnings: {
        negativeNet: rows.filter((row) => row.netPay < 0).length,
        withNotes: rows.filter((row) => row.noteCount > 0).length,
        skipped: (run.skippedEmployees ?? []).length,
      },
      compliance: {
        incomeTax: round2(rows.reduce((sum, row) => sum + row.incomeTax, 0)),
        statutoryDeductions: round2(rows.reduce((sum, row) => sum + row.statutoryDeductions, 0)),
        normalDeductions: round2(rows.reduce((sum, row) => sum + row.normalDeductions, 0)),
        employerContributions: round2(rows.reduce((sum, row) => sum + row.employerContributions, 0)),
        linesWithCompliance: rows.filter((row) => row.hasCompliance).length,
        notes: run.complianceNotes ?? [],
      },
      components: records.componentTotals,
      records: rows,
    };
  }

  async getRecords(tenantId: string, query: GetPayrollRecordsQueryDto = {}) {
    const payrollRunId = query.payrollRunId ?? (await this.latestRun(tenantId))?.id;
    if (!payrollRunId) return { payrollRun: null, rows: [], total: 0 };
    return this.listRecords(tenantId, payrollRunId, Math.min(Math.max(query.limit ?? 100, 1), 1000));
  }

  private async listRecords(tenantId: string, payrollRunId: string, limit: number) {
    const run = await this.loadRun(tenantId, payrollRunId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const [rows, total, counts] = await Promise.all([
      Record.findAll({
        where: { tenantId, payrollRunId },
        include: [await this.employeeInclude(tenantId)],
        order: [['createdAt', 'ASC']],
        limit,
      }),
      Record.count({ where: { tenantId, payrollRunId } }),
      Adjustment.findAll({ where: { tenantId, payrollRunId }, attributes: ['payrollRecordId'], raw: true }),
    ]);
    const adjustmentsPer = new Map<string, number>();
    for (const row of counts as any[]) {
      adjustmentsPer.set(row.payrollRecordId, (adjustmentsPer.get(row.payrollRecordId) ?? 0) + 1);
    }
    const step = this.stepOf(run);
    return {
      payrollRun: this.runSummary(run),
      rows: rows
        .map((row) => this.recordRow(row, step, adjustmentsPer.get(row.id) ?? 0))
        .sort((a, b) => (a.employee?.name ?? '').localeCompare(b.employee?.name ?? '')),
      total,
      componentTotals: this.componentTotals(rows),
    };
  }

  /**
   * The run's earnings, deductions and employer contributions added up per
   * component across its lines — the preview before the payroll is
   * submitted. Lines from before components existed aren't included.
   */
  private componentTotals(records: any[]) {
    const group = (key: 'earnings' | 'deductions' | 'employer') => {
      const totals = new Map<string, { name: string; source: string; amount: number; employees: number }>();
      for (const record of records) {
        for (const line of (record.components?.[key] ?? []) as any[]) {
          if (line.informational || !(money(line.amount) > 0)) continue;
          const id = `${line.source}:${line.code ?? line.name}`;
          const total = totals.get(id) ?? { name: line.name, source: line.source, amount: 0, employees: 0 };
          total.amount = round2(total.amount + money(line.amount));
          total.employees += 1;
          totals.set(id, total);
        }
      }
      return [...totals.values()].sort((a, b) => b.amount - a.amount);
    };
    return {
      linesWithComponents: records.filter((record) => record.components).length,
      earnings: group('earnings'),
      deductions: group('deductions'),
      employer: group('employer'),
    };
  }

  /** One line with its full calculation and adjustments. */
  async getRecord(tenantId: string, recordId: string) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const record = await Record.findOne({
      where: { id: recordId, tenantId },
      include: [await this.employeeInclude(tenantId)],
    });
    if (!record) this.notFound('Payroll line', recordId);
    const run = await this.loadRun(tenantId, record.payrollRunId);
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const adjustments = await Adjustment.findAll({
      where: { tenantId, payrollRecordId: record.id },
      order: [['createdAt', 'ASC']],
    });
    const names = await this.namesByEmail(tenantId, (adjustments as any[]).map((a) => a.createdByEmail));
    return this.recordDetail(record, this.stepOf(run), adjustments as any[], names);
  }

  // ── Calculation ───────────────────────────────────────────────────────────

  /** The organization's rules the calculation needs, or a clear reason it can't run. */
  private async payrollSettings(tenantId: string) {
    const WorkingHours = await this.modelProvider.getWorkingHoursModel(tenantId);
    const shift = await WorkingHours.findOne({ where: { tenantId }, order: [['isDefault', 'DESC']] });
    const workingWeekdays: string[] = shift?.workingDays ?? [];
    if (!shift || workingWeekdays.length === 0) {
      this.badRequest(
        'Set up working hours with working days before running payroll — payroll counts working days from them.',
      );
    }

    const toMinutes = (value: string) => {
      const [h, m] = String(value).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    let span = toMinutes(shift.endTime) - toMinutes(shift.startTime);
    if (span <= 0) span += 24 * 60;
    const hoursPerDay = Math.max(0, span - (shift.breakDurationMinutes ?? 0)) / 60 || null;

    const { multiplier, currency } = await this.payrollPolicy(tenantId);
    return { workingWeekdays, overtime: { multiplier, hoursPerDay }, currency };
  }

  /**
   * The active Payroll policy's overtime multiplier and currency; the
   * currency falls back to the organization's own.
   */
  private async payrollPolicy(tenantId: string) {
    let multiplier: number | null = null;
    let currency: string | null = null;
    try {
      const Policy = await this.modelProvider.getOrganizationPolicyModel(tenantId);
      const policy = await Policy.findOne({
        where: { tenantId, policyType: PolicyType.PAYROLL, status: PolicyStatus.ACTIVE },
        order: [['updatedAt', 'DESC']],
      });
      const config: any = policy?.configuration ?? {};
      multiplier = Number(config.overtimeMultiplier) > 0 ? Number(config.overtimeMultiplier) : null;
      currency = typeof config.currency === 'string' ? config.currency.toUpperCase() : null;
    } catch (error: any) {
      this.logger.warn(`Could not read the payroll policy: ${error?.message ?? error}`);
    }
    if (!currency && this.tenantModel) {
      const tenant = await this.tenantModel.findByPk(tenantId, { attributes: ['currency'] }).catch(() => null);
      currency = tenant?.currency ? String(tenant.currency).toUpperCase().slice(0, 3) : null;
    }
    return { multiplier, currency };
  }

  /**
   * Every line for a period, calculated from current data. `adjustmentsFor`
   * supplies the manual adjustments already on a line (recalculation keeps them).
   */
  private async calculateLines(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
    adjustmentsFor: (employeeId: string) => PayrollAdjustmentInput[] = () => [],
    excludeRunId?: string,
  ) {
    const settings = await this.payrollSettings(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);

    // Anyone employed at some point in the period — joiners, and leavers up
    // to their last day, included; people before or after it are not.
    const employees = (await Employee.findAll({
      where: {
        tenantId,
        [Op.and]: [
          { [Op.or]: [{ joiningDate: null }, { joiningDate: { [Op.lte]: periodEnd } }] },
          { [Op.or]: [{ exitDate: null }, { exitDate: { [Op.gte]: periodStart } }] },
        ],
      } as any,
      order: [['employeeCode', 'ASC']],
    })) as any[];

    const skipped: Skipped[] = [];
    const skip = (employee: any, reason: string) =>
      skipped.push({ employeeId: employee.id, employeeCode: employee.employeeCode, name: nameOf(employee), reason });

    const candidates = employees.filter((employee) => {
      if (CURRENT_STATUSES.includes(employee.status)) return true;
      // Resigned or inactive: paid only up to a last working day that falls in the period.
      if (employee.exitDate && employee.exitDate >= periodStart) return true;
      skip(
        employee,
        employee.status === EmployeeStatus.RESIGNED
          ? 'Resigned with no last working day set'
          : 'Inactive with no last working day set',
      );
      return false;
    });
    const ids = candidates.map((employee) => employee.id);

    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);

    const [revisions, attendance, leaves] = ids.length
      ? await Promise.all([
          Revision.findAll({
            where: { tenantId, employeeId: { [Op.in]: ids }, effectiveFrom: { [Op.lte]: periodEnd } },
            raw: true,
          }),
          Attendance.findAll({
            where: { tenantId, employeeId: { [Op.in]: ids }, date: { [Op.between]: [periodStart, periodEnd] } },
            attributes: ['employeeId', 'date', 'status', 'overtimeMinutes'],
            raw: true,
          }),
          // Only approved leave touches pay; pending or rejected requests never do.
          Leave.findAll({
            where: {
              tenantId,
              employeeId: { [Op.in]: ids },
              status: LeaveRequestStatus.APPROVED,
              fromDate: { [Op.lte]: periodEnd },
              toDate: { [Op.gte]: periodStart },
            },
            include: [{ model: Policy, as: 'leavePolicy', attributes: ['id', 'isPaid'], required: false }],
          }),
        ])
      : [[], [], []];

    const group = <T extends { employeeId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
      return map;
    };
    const revisionsOf = group(revisions as any[]);
    const attendanceOf = group(attendance as any[]);
    const leavesOf = group(leaves as any[]);

    // Phase 4: recurring items, due instalments and approved reimbursements.
    const compensation = this.compensation
      ? await this.compensation.contextForPeriod(tenantId, periodStart, periodEnd, ids, excludeRunId)
      : null;
    const linesOfRevision = (row: any) =>
      Array.isArray(row.components) && row.components.length
        ? row.components
        : legacyCompensation({ basicSalary: money(row.basicSalary), allowances: money(row.allowances), recurringDeductions: money(row.recurringDeductions) });

    const lines: {
      employee: any;
      salary: ReturnType<typeof salaryForPeriod>;
      result: PayrollLineResult;
      compliance?: LineCompliance;
      /** Earnings and deductions from outside the line: adjustments and approved reimbursements. */
      oneOffs: PayrollAdjustmentInput[];
    }[] = [];
    for (const employee of candidates) {
      const salary = salaryForPeriod(
        (revisionsOf.get(employee.id) ?? []).map((row: any) => ({
          effectiveFrom: String(row.effectiveFrom),
          basicSalary: money(row.basicSalary),
          allowances: money(row.allowances),
          recurringDeductions: money(row.recurringDeductions),
        })),
        periodEnd,
        {
          basicSalary: money(employee.basicSalary),
          allowances: money(employee.allowances),
          recurringDeductions: money(employee.recurringDeductions),
          effectiveFrom: employee.salaryEffectiveFrom ?? null,
        },
      );
      if (salary.basicSalary + salary.allowances <= 0) {
        skip(employee, 'No salary set');
        continue;
      }

      const reimbursements: PayrollAdjustmentInput[] = (compensation?.reimbursementsOf(employee.id) ?? []).map((claim) => ({
        type: 'EARNING',
        amount: claim.amount,
        category: 'REIMBURSEMENT',
        label: `Reimbursement — ${claim.category.charAt(0)}${claim.category.slice(1).toLowerCase().replace(/_/g, ' ')}`,
        source: 'REIMBURSEMENT',
        sourceId: claim.id,
      }));
      const oneOffs = [...adjustmentsFor(employee.id), ...reimbursements];
      const result = calculatePayrollLine({
        periodStart,
        periodEnd,
        workingWeekdays: settings.workingWeekdays,
        salary,
        segments: compensationSegments(
          (revisionsOf.get(employee.id) ?? []).map((row: any) => ({
            id: row.id,
            effectiveFrom: String(row.effectiveFrom),
            structureName: row.structureName ?? null,
            lines: linesOfRevision(row),
          })),
          periodStart,
          periodEnd,
        ),
        recurring: compensation?.recurringOf(employee.id) ?? [],
        recoveries: compensation?.recoveriesOf(employee.id) ?? [],
        joiningDate: employee.joiningDate ?? null,
        exitDate: employee.exitDate ?? null,
        attendance: (attendanceOf.get(employee.id) ?? []).map((row: any) => ({
          date: String(row.date),
          status: row.status as AttendanceStatus,
          overtimeMinutes: row.overtimeMinutes,
        })),
        leaves: (leavesOf.get(employee.id) ?? []).map((leave: any) => ({
          fromDate: String(leave.fromDate),
          toDate: String(leave.toDate),
          totalDays: Number(leave.totalDays),
          // A leave type that no longer exists is treated as paid: never
          // cut pay on a guess.
          isPaid: leave.leavePolicy ? Boolean(leave.leavePolicy.isPaid) : true,
        })),
        adjustments: oneOffs,
        overtime: { ...settings.overtime, base: compensation?.overtimeBase ?? 'BASIC' },
      });

      if (result.eligibleDays === 0) {
        skip(employee, 'No working days in the period');
        continue;
      }
      lines.push({ employee, salary, result, oneOffs });
    }

    // Compliance runs on the finished Phase 1 figures — it never changes them.
    let complianceNotes: string[] = [];
    if (this.compliance && lines.length) {
      const context = await this.compliance.contextForPeriod(
        tenantId,
        periodStart,
        lines.map((line) => line.employee.id),
        excludeRunId,
      );
      complianceNotes = context.runNotes;
      for (const line of lines) {
        const ytd = context.ytdOf(line.employee.id);
        line.compliance = runCompliance(
          {
            periodStart,
            periodEnd,
            month: {
              earnedBasic: line.result.earnedBasic,
              earnedAllowances: line.result.earnedAllowances,
              overtimePay: line.result.overtimePay,
              absenceDeduction: line.result.absenceDeduction,
              unpaidLeaveDeduction: line.result.unpaidLeaveDeduction,
              prorationFactor: line.result.prorationFactor,
              adjustments: line.oneOffs
                .filter((adjustment) => adjustment.type === 'EARNING')
                .map((adjustment) => ({
                  category: adjustment.category ?? 'OTHER',
                  amount: adjustment.amount,
                  // Reimbursements aren't adjustment rows — kept apart so a
                  // recalculation from the snapshot still includes them.
                  ...(adjustment.source === 'REIMBURSEMENT' ? { source: 'REIMBURSEMENT', sourceId: adjustment.sourceId } : {}),
                })),
              basicTreatment: line.result.taxBasis.basicTreatment,
              allowances: line.result.taxBasis.month,
            },
            monthlySalary: {
              basic: line.salary.basicSalary,
              allowances: round2(line.result.taxBasis.monthly.reduce((sum, item) => sum + item.amount, 0)),
              basicTreatment: line.result.taxBasis.basicTreatment,
              allowanceItems: line.result.taxBasis.monthly,
            },
            ytd: { taxableIncome: ytd.taxableIncome, incomeTax: ytd.incomeTax, months: ytd.months },
            exitDate: line.employee.exitDate ?? null,
            person: { dateOfBirth: line.employee.dateOfBirth ?? null, gender: line.employee.gender ?? null },
            profile: context.profileOf(line.employee.id),
            rules: context.rules,
          },
          ytd.notes,
        );
      }
    }

    return { lines, skipped, currency: settings.currency, complianceNotes };
  }

  /**
   * The columns a calculated line is stored as. `deductions` is everything
   * taken from pay — the Phase 1 deductions plus statutory ones — and net pay
   * follows from it. Employer contributions are stored but never deducted.
   */
  private lineColumns(
    employee: any,
    salary: { basicSalary: number; allowances: number; effectiveFrom: string | null },
    r: PayrollLineResult,
    compliance?: LineCompliance,
  ) {
    const statutory = compliance?.result.statutoryDeductions ?? 0;
    const deductions = round2(r.deductions + statutory);
    return {
      basicSalary: salary.basicSalary,
      allowances: salary.allowances,
      salaryEffectiveFrom: salary.effectiveFrom,
      bonus: r.earningAdjustments,
      grossPay: r.grossPay,
      normalDeductions: r.deductions,
      deductions,
      netPay: round2(r.grossPay - deductions),
      ...complianceColumns(compliance),
      // Employer contributions: EOBI / PF from compliance plus the
      // organization's own employer-contribution components.
      employerContributions: round2((compliance?.result.employerContributions ?? 0) + r.otherEmployerContributions),
      otherEmployerContributions: r.otherEmployerContributions,
      loanRecovery: r.loanRecovery,
      components: { version: 1, ...r.breakdown },
      workingDays: r.workingDays,
      eligibleDays: r.eligibleDays,
      absenceDays: r.absenceDays,
      unpaidLeaveDays: r.unpaidLeaveDays,
      paidLeaveDays: r.paidLeaveDays,
      paidDays: r.paidDays,
      unrecordedDays: r.unrecordedDays,
      prorationFactor: r.prorationFactor,
      employedFrom: r.employedFrom,
      employedTo: r.employedTo,
      dailyRate: r.dailyRate,
      earnedBasic: r.earnedBasic,
      earnedAllowances: r.earnedAllowances,
      overtimeMinutes: r.overtimeMinutes,
      overtimePay: r.overtimePay,
      absenceDeduction: r.absenceDeduction,
      unpaidLeaveDeduction: r.unpaidLeaveDeduction,
      recurringDeductions: r.recurringDeductions,
      adjustmentDeductions: r.deductionAdjustments,
      notes: [...r.notes, ...(compliance?.notes ?? [])],
      bankName: employee.bankName ?? null,
      bankAccountTitle: employee.bankAccountTitle ?? null,
      bankAccountNumber: employee.bankAccountNumber ?? null,
      iban: employee.iban ?? null,
    };
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  /**
   * Opens a month's payroll in Review and calculates every line. A month
   * that already has a run — in any state — is refused, so it is never paid
   * twice.
   */
  async createRun(tenantId: string, dto: CreatePayrollRunDto) {
    this.requirePermission('payroll.create', 'create payroll');

    const periodStart = String(dto.periodStart).slice(0, 10);
    const periodEnd = String(dto.periodEnd).slice(0, 10);
    const month = periodStart.slice(0, 7);
    const bounds = monthBounds(month);
    if (periodStart !== bounds.periodStart || periodEnd !== bounds.periodEnd) {
      this.badRequest(`Payroll runs cover one calendar month — for ${periodLabel(periodStart)} that is ${bounds.periodStart} to ${bounds.periodEnd}.`);
    }
    if (periodStart > today()) {
      this.badRequest(`${periodLabel(periodStart)} hasn't started yet.`);
    }
    // Calculation, proration and tax all work by calendar month.
    if (dto.cycle && dto.cycle !== PayrollCycle.MONTHLY) {
      this.badRequest('Payroll runs monthly — weekly and bi-weekly cycles are not supported yet.');
    }
    const payDate = dto.payDate ? String(dto.payDate).slice(0, 10) : this.defaultPayDate(periodEnd, PayrollCycle.MONTHLY);
    if (payDate < periodStart) this.badRequest('The pay date can’t be before the payroll month starts.');

    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const overlapping = await Run.findOne({
      where: { tenantId, periodStart: { [Op.lte]: periodEnd }, periodEnd: { [Op.gte]: periodStart } },
    });
    if (overlapping) {
      this.conflict(`${periodLabel(overlapping.periodStart)} already has a payroll run.`);
    }

    // One-off entries made ahead of this month's payroll.
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const pending = (await Adjustment.findAll({ where: { tenantId, payrollRunId: null, payrollPeriod: month }, raw: true })) as any[];
    const pendingOf = this.adjustmentInputsByEmployee(pending);
    const { lines, skipped, currency, complianceNotes } = await this.calculateLines(
      tenantId,
      periodStart,
      periodEnd,
      (employeeId) => pendingOf.get(employeeId) ?? [],
    );
    const actor = this.actor();
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const columns = lines.map((line) => ({ line, columns: this.lineColumns(line.employee, line.salary, line.result, line.compliance) }));

    const run = await Run.sequelize!.transaction(async (transaction) => {
      const created = await Run.create(
        {
          tenantId,
          periodStart,
          periodEnd,
          status: PayrollRunStatus.DRAFT,
          step: PayrollProcessStep.REVIEW,
          cycle: PayrollCycle.MONTHLY,
          payDate,
          currency,
          skippedEmployees: skipped,
          complianceNotes,
          calculatedAt: new Date(),
          createdByUserId: actor.userId,
          actorEmails: actor.email ? { created: actor.email } : {},
          employeeCount: lines.length,
          grossPay: round2(columns.reduce((sum, item) => sum + item.columns.grossPay, 0)),
          deductions: round2(columns.reduce((sum, item) => sum + item.columns.deductions, 0)),
          netPay: round2(columns.reduce((sum, item) => sum + item.columns.netPay, 0)),
        },
        { transaction },
      );
      if (lines.length) {
        await Record.bulkCreate(
          columns.map((item) => ({
            tenantId,
            payrollRunId: created.id,
            employeeId: item.line.employee.id,
            ...item.columns,
          })),
          { transaction },
        );
      }
      return created;
    });
    await this.attachOneOffs(tenantId, run.id, lines);

    await this.audit(tenantId, 'PayrollRun', run.id, 'CREATE', {
      event: { from: null, to: 'PAYROLL_CREATED' },
      period: { from: null, to: `${periodStart}..${periodEnd}` },
      employees: { from: null, to: lines.length },
      netPay: { from: null, to: money(run.netPay) },
      skipped: { from: null, to: skipped.length },
    });

    return this.getRun(tenantId, run.id);
  }

  /**
   * Recomputes every line from today's salary, attendance and leave — for
   * when a correction lands after the run was opened. Manual adjustments
   * are kept. Review only.
   */
  async recalculateRun(tenantId: string, payrollRunId: string) {
    this.requirePermission('payroll.edit', 'recalculate payroll');
    const run = await this.loadRun(tenantId, payrollRunId);
    this.assertInReview(run, 'recalculating');

    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const existing = (await Record.findAll({ where: { tenantId, payrollRunId } })) as any[];
    // The run's own adjustments, and entries for its month still waiting for a line.
    const adjustments = (await Adjustment.findAll({
      where: {
        tenantId,
        [Op.or]: [{ payrollRunId }, { payrollRunId: null, payrollPeriod: String(run.periodStart).slice(0, 7) }],
      } as any,
      raw: true,
    })) as any[];
    const recordOfEmployee = new Map(existing.map((record) => [record.employeeId, record]));
    const employeeOfRecord = new Map(existing.map((record) => [record.id, record.employeeId]));
    const adjustmentsOf = this.adjustmentInputsByEmployee(
      adjustments.map((adjustment) => ({ ...adjustment, employeeId: adjustment.employeeId ?? employeeOfRecord.get(adjustment.payrollRecordId) })),
    );

    const before = { employees: run.employeeCount, netPay: money(run.netPay) };
    const { lines, skipped, currency, complianceNotes } = await this.calculateLines(
      tenantId,
      String(run.periodStart),
      String(run.periodEnd),
      (employeeId) => adjustmentsOf.get(employeeId) ?? [],
      run.id,
    );

    const keep = new Set(lines.map((line) => line.employee.id));
    const dropped = existing.filter((record) => !keep.has(record.employeeId));

    await Record.sequelize!.transaction(async (transaction) => {
      for (const line of lines) {
        const columns = this.lineColumns(line.employee, line.salary, line.result, line.compliance);
        const record = recordOfEmployee.get(line.employee.id);
        if (record) await record.update(columns, { transaction });
        else await Record.create({ tenantId, payrollRunId, employeeId: line.employee.id, ...columns }, { transaction });
      }
      // No longer eligible (salary removed, exit moved earlier): the line goes.
      // Entries made for the employee and month wait for a line again; older
      // adjustments with no employee on them go with the line, as before.
      for (const record of dropped) {
        await Adjustment.update(
          { payrollRunId: null, payrollRecordId: null },
          { where: { tenantId, payrollRecordId: record.id, employeeId: { [Op.ne]: null } } as any, transaction },
        );
        await Adjustment.destroy({ where: { tenantId, payrollRecordId: record.id }, transaction });
        await record.destroy({ transaction });
      }
      await run.update(
        { skippedEmployees: skipped, complianceNotes, calculatedAt: new Date(), currency: currency ?? run.currency },
        { transaction },
      );
    });
    await this.attachOneOffs(tenantId, payrollRunId, lines);
    const fresh = await this.recompute(tenantId, payrollRunId);

    await this.audit(tenantId, 'PayrollRun', run.id, 'UPDATE', {
      event: { from: null, to: 'PAYROLL_RECALCULATED' },
      employees: { from: before.employees, to: fresh.employeeCount },
      netPay: { from: before.netPay, to: money(fresh.netPay) },
      ...(dropped.length ? { removedLines: { from: null, to: dropped.length } } : {}),
    });
    return this.getRun(tenantId, payrollRunId);
  }

  /** Review → Approval. Nothing is paid below zero, and an empty run is not a payroll. */
  async submitRun(tenantId: string, payrollRunId: string) {
    this.requirePermission('payroll.edit', 'submit payroll');
    const run = await this.loadRun(tenantId, payrollRunId);
    this.assertInReview(run, 'submitting');

    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const lines = (await Record.findAll({
      where: { tenantId, payrollRunId },
      include: [await this.employeeInclude(tenantId)],
    })) as any[];
    if (lines.length === 0) {
      this.badRequest('This payroll has no employees to pay. Set salaries, then recalculate.');
    }
    const negative = lines.filter((line) => money(line.netPay) < 0);
    if (negative.length) {
      this.badRequest(
        `Net pay is negative for ${negative.map((line) => nameOf(line.employee) || line.employeeId).join(', ')}. Adjust those lines before submitting.`,
      );
    }

    return this.moveTo(tenantId, run, PayrollProcessStep.APPROVAL, 'PAYROLL_SUBMITTED', {
      submittedAt: new Date(),
      submittedByUserId: this.actor().userId,
    }, 'submitted');
  }

  /** Approval → Payment. From here on the run is locked. */
  async approveRun(tenantId: string, payrollRunId: string) {
    this.requirePermission('payroll.approve', 'approve payroll');
    const run = await this.loadRun(tenantId, payrollRunId);
    if (this.stepOf(run) !== PayrollProcessStep.APPROVAL) {
      this.badRequest(`Only a payroll awaiting approval can be approved — this one is in ${STEP_LABELS[this.stepOf(run)]}.`);
    }
    const actor = this.actor();
    // Whoever prepared the run doesn't sign it off too — unless they are the
    // organization's full-access admin (often the only approver there is).
    if (actor.present && !actor.isFullAccess && run.submittedByUserId && run.submittedByUserId === actor.userId) {
      this.fail('You submitted this payroll, so someone else has to approve it.', HttpStatus.FORBIDDEN);
    }
    const approved = await this.moveTo(tenantId, run, PayrollProcessStep.PAYMENT, 'PAYROLL_APPROVED', {
      approvedAt: new Date(),
      approvedByUserId: actor.userId,
    }, 'approved');
    // Locked: its approved reimbursements are now paid through payroll.
    await this.compensation?.onRunLocked(tenantId, run.id);
    return approved;
  }

  /** Approval → Review, with the reason — the only way back, and only before approval. */
  async returnRun(tenantId: string, payrollRunId: string, dto: ReturnPayrollRunDto) {
    this.requirePermission('payroll.approve', 'return payroll to review');
    const run = await this.loadRun(tenantId, payrollRunId);
    if (this.stepOf(run) !== PayrollProcessStep.APPROVAL) {
      this.badRequest('Only a payroll awaiting approval can be returned to Review.');
    }
    const reason = dto.reason.trim();
    return this.moveTo(tenantId, run, PayrollProcessStep.REVIEW, 'PAYROLL_RETURNED', {
      returnedAt: new Date(),
      returnedByUserId: this.actor().userId,
      returnReason: reason,
      submittedAt: null,
      submittedByUserId: null,
    }, 'returned', { reason: { from: null, to: reason } });
  }

  /** Payment → Completed. Records when it was paid; no bank integration yet. */
  async payRun(tenantId: string, payrollRunId: string, dto: PayPayrollRunDto) {
    this.requirePermission('payroll.approve', 'mark payroll as paid');
    const run = await this.loadRun(tenantId, payrollRunId);
    if (this.stepOf(run) !== PayrollProcessStep.PAYMENT) {
      this.badRequest('Only an approved payroll can be marked as paid.');
    }
    const paymentDate = String(dto.paymentDate).slice(0, 10);
    if (paymentDate > today()) this.badRequest('The payment date can’t be in the future.');
    const approvedOn = run.approvedAt ? new Date(run.approvedAt).toISOString().slice(0, 10) : null;
    if (approvedOn && paymentDate < approvedOn) {
      this.badRequest('The payment date can’t be before the payroll was approved.');
    }
    const reference = dto.paymentReference?.trim() || null;
    const completed = await this.moveTo(tenantId, run, PayrollProcessStep.COMPLETED, 'PAYROLL_PAID', {
      paidAt: new Date(),
      paidByUserId: this.actor().userId,
      paymentDate,
      paymentReference: reference,
      processedAt: new Date(),
    }, 'paid', { paymentDate: { from: null, to: paymentDate }, ...(reference ? { paymentReference: { from: null, to: reference } } : {}) });

    // Payslips are numbered the moment the payroll is final. If that fails
    // the payment still stands — numbering fills in on first access.
    try {
      await this.payslips?.generateForRun(tenantId, payrollRunId);
    } catch (error: any) {
      this.logger.error(`Payroll ${payrollRunId} paid, but its payslips weren't generated yet: ${error?.message ?? error}`);
    }
    return completed;
  }

  private async moveTo(
    tenantId: string,
    run: any,
    step: PayrollProcessStep,
    event: string,
    patch: Record<string, unknown>,
    actorKey: ActorKey,
    extra: Record<string, { from: unknown; to: unknown }> = {},
  ) {
    const from = this.stepOf(run);
    const email = this.actor().email;
    await run.update({
      ...patch,
      step,
      status: this.statusForStep(step),
      actorEmails: { ...(run.actorEmails ?? {}), ...(email ? { [actorKey]: email } : {}) },
    });
    await this.audit(tenantId, 'PayrollRun', run.id, 'UPDATE', {
      event: { from: null, to: event },
      step: { from, to: step },
      ...extra,
    });
    return this.getRun(tenantId, run.id);
  }

  /** The run's history from the audit log, newest first. */
  async getRunActivity(tenantId: string, payrollRunId: string) {
    await this.loadRun(tenantId, payrollRunId);
    const Log = await this.modelProvider.getEntityAuditLogModel(tenantId);
    const rows = (await Log.findAll({
      where: { tableName: { [Op.in]: ['PayrollRun', 'PayrollAdjustment', 'Payslip'] }, recordId: payrollRunId },
      order: [['createdAt', 'DESC']],
      limit: 100,
    })) as any[];
    const names = await this.namesByEmail(tenantId, rows.map((row) => row.changes?.actor?.to));
    return rows.map((row) => {
      const changes = row.changes ?? {};
      const email = changes.actor?.to ?? null;
      const { actor: _actor, event, ...details } = changes;
      return {
        id: row.id,
        event: event?.to ?? row.action,
        at: row.createdAt,
        by: email ? { email, name: names.get(String(email).toLowerCase()) ?? null } : null,
        details: Object.fromEntries(Object.entries(details).map(([key, value]: [string, any]) => [key, value?.to ?? value])),
      };
    });
  }

  // ── Adjustments ───────────────────────────────────────────────────────────

  /** Re-derives a line's totals after its adjustments change. */
  /** Adjustment rows as calculation inputs, per employee. */
  private adjustmentInputsByEmployee(rows: any[]) {
    const map = new Map<string, PayrollAdjustmentInput[]>();
    for (const row of rows) {
      if (!row.employeeId) continue;
      map.set(row.employeeId, [
        ...(map.get(row.employeeId) ?? []),
        { type: row.type, amount: money(row.amount), category: row.category ?? 'OTHER', source: 'ADJUSTMENT', sourceId: row.id },
      ]);
    }
    return map;
  }

  /**
   * After a run's lines are saved: each one-off entry points at its line, and
   * each approved reimbursement at the line paying it.
   */
  private async attachOneOffs(tenantId: string, payrollRunId: string, lines: { employee: any; oneOffs: PayrollAdjustmentInput[] }[]) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const records = (await Record.findAll({ where: { tenantId, payrollRunId }, attributes: ['id', 'employeeId'], raw: true })) as any[];
    const recordOf = new Map(records.map((record) => [record.employeeId, record.id]));
    const reimbursements: { reimbursementId: string; recordId: string }[] = [];
    for (const line of lines) {
      const recordId = recordOf.get(line.employee.id);
      if (!recordId) continue;
      const adjustmentIds = line.oneOffs.filter((o) => o.source === 'ADJUSTMENT' && o.sourceId).map((o) => o.sourceId as string);
      if (adjustmentIds.length) {
        await Adjustment.update({ payrollRunId, payrollRecordId: recordId }, { where: { tenantId, id: { [Op.in]: adjustmentIds } } });
      }
      for (const o of line.oneOffs) if (o.source === 'REIMBURSEMENT' && o.sourceId) reimbursements.push({ reimbursementId: o.sourceId, recordId });
    }
    await this.compensation?.linkReimbursements(tenantId, payrollRunId, reimbursements);
  }

  private async applyAdjustments(tenantId: string, record: any) {
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const rows = (await Adjustment.findAll({ where: { tenantId, payrollRecordId: record.id }, raw: true })) as any[];
    const sum = (type: PayrollAdjustmentType) =>
      round2(rows.filter((row) => row.type === type).reduce((total, row) => total + money(row.amount), 0));
    const earnings = sum(PayrollAdjustmentType.EARNING);
    const deductions = sum(PayrollAdjustmentType.DEDUCTION);
    // Approved reimbursements are on the line too, but aren't adjustment rows.
    const breakdown = record.components;
    const reimbursed = round2(
      ((breakdown?.earnings ?? []) as any[]).filter((line) => line.source === 'REIMBURSEMENT').reduce((total, line) => total + money(line.amount), 0),
    );

    const grossPay = round2(money(record.earnedBasic) + money(record.earnedAllowances) + money(record.overtimePay) + earnings + reimbursed);
    const normalDeductions = round2(
      money(record.absenceDeduction) +
        money(record.unpaidLeaveDeduction) +
        money(record.recurringDeductions) +
        deductions +
        money(record.loanRecovery),
    );

    // Compliance again from the line's own snapshot — the same rule copies
    // and inputs, only the adjustments differ — so a rule edited since the
    // calculation never reaches this line.
    let compliance: Record<string, unknown> = {};
    let notes: string[] = record.notes ?? [];
    const snapshot = record.complianceSnapshot;
    if (snapshot?.inputs && snapshot?.rules) {
      const previousNotes = new Set<string>([...(snapshot.extraNotes ?? []), ...(snapshot.result?.notes ?? [])]);
      const next = runCompliance(
        {
          ...snapshot.inputs,
          rules: snapshot.rules,
          month: {
            ...snapshot.inputs.month,
            adjustments: [
              ...rows
                .filter((row) => row.type === PayrollAdjustmentType.EARNING)
                .map((row) => ({ category: row.category ?? 'OTHER', amount: money(row.amount) })),
              ...((snapshot.inputs.month?.adjustments ?? []) as any[]).filter((a) => a.source === 'REIMBURSEMENT'),
            ],
          },
        },
        snapshot.extraNotes ?? [],
      );
      compliance = {
        ...complianceColumns(next),
        employerContributions: round2(next.result.employerContributions + money(record.otherEmployerContributions)),
      };
      notes = [...notes.filter((note) => !previousNotes.has(note)), ...next.notes];
    }
    // The breakdown's adjustment lines follow the adjustment rows.
    const adjustmentLine = (row: any) => ({
      code: null,
      name: row.type === PayrollAdjustmentType.EARNING ? (ADJUSTMENT_LABELS[row.category] ?? 'One-off Earning') : 'One-off Deduction',
      category: row.category ?? 'OTHER',
      source: 'ADJUSTMENT',
      sourceId: row.id,
      method: null,
      detail: row.reason,
      amount: money(row.amount),
    });
    const components = breakdown
      ? {
          ...breakdown,
          earnings: [
            ...(breakdown.earnings ?? []).filter((line: any) => line.source !== 'ADJUSTMENT'),
            ...rows.filter((row) => row.type === PayrollAdjustmentType.EARNING).map(adjustmentLine),
          ],
          deductions: [
            ...(breakdown.deductions ?? []).filter((line: any) => line.source !== 'ADJUSTMENT'),
            ...rows.filter((row) => row.type === PayrollAdjustmentType.DEDUCTION).map(adjustmentLine),
          ],
        }
      : breakdown;
    const statutory = money((compliance as any).statutoryDeductions ?? record.statutoryDeductions);
    const totalDeductions = round2(normalDeductions + statutory);
    await record.update({
      bonus: round2(earnings + reimbursed),
      adjustmentDeductions: deductions,
      components,
      grossPay,
      normalDeductions,
      deductions: totalDeductions,
      netPay: round2(grossPay - totalDeductions),
      ...compliance,
      notes,
    });
    await this.recompute(tenantId, record.payrollRunId);
  }

  /**
   * The three Payroll Process panels: Validation Checks, Exceptions &
   * Warnings, and Processing Progress.
   *
   * Every figure is derived from the run's own lines, the employees they
   * belong to and their tax profiles — nothing is stored. A stored
   * "validated" flag would go stale the moment someone fixed a bank account,
   * and the screen would keep showing an exception that no longer exists.
   *
   * Tax information is the Phase 3 tax profile for the run's tax year (its
   * NTN); whether tax was worked out is whether the line has a compliance
   * snapshot.
   */
  async getProcessChecks(tenantId: string, payrollRunId: string) {
    const run = await this.loadRun(tenantId, payrollRunId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Profile = await this.modelProvider.getEmployeeTaxProfileModel(tenantId);

    const records = (await Record.findAll({ where: { tenantId, payrollRunId } })) as any[];
    const employeeIds = records.map((record) => record.employeeId);
    const taxYear = taxYearOf(String(run.periodEnd));
    // Live employee rows, so a bank account fixed since the run was calculated counts.
    const [employees, profiles] = await Promise.all([
      Employee.findAll({
        where: { tenantId, id: { [Op.in]: employeeIds } },
        attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'bankName', 'bankAccountNumber', 'iban'],
      }) as Promise<any[]>,
      Profile.findAll({
        where: { tenantId, taxYear, employeeId: { [Op.in]: employeeIds } },
        attributes: ['employeeId', 'ntn'],
        raw: true,
      }) as Promise<any[]>,
    ]);
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    const ntnOf = new Map(profiles.map((profile) => [profile.employeeId, profile.ntn]));

    const total = records.length;
    const missingBank: any[] = [];
    const missingTax: any[] = [];
    const missingSalary: any[] = [];
    const orphaned: any[] = [];

    for (const record of records) {
      const employee = employeeById.get(record.employeeId);
      if (!employee) {
        orphaned.push({ recordId: record.id, employeeId: record.employeeId });
        continue;
      }
      const person = { employeeId: employee.id, employeeCode: employee.employeeCode, name: nameOf(employee) };

      // An IBAN alone is payable, as is a bank name plus an account number.
      if (!(employee.iban || (employee.bankName && employee.bankAccountNumber))) missingBank.push(person);
      if (!ntnOf.get(employee.id)) missingTax.push(person);
      // The salary the line was calculated from, not the employee row.
      if (money(record.basicSalary) <= 0) missingSalary.push(person);
    }

    const withoutCompliance = records.filter((record) => !record.complianceSnapshot).length;
    const check = (label: string, failures: number) => ({ label, passed: failures === 0, failures });
    const checks = [
      check('Employee details verified', orphaned.length + missingSalary.length),
      check('Bank details verified', missingBank.length),
      check('Tax calculations verified', missingTax.length + withoutCompliance),
      check('HR & benefits calculated', records.filter((record) => money(record.grossPay) <= 0).length),
    ];

    const exceptions = [
      { key: 'MISSING_BANK_DETAILS', label: 'Missing bank details', count: missingBank.length, employees: missingBank.slice(0, 50) },
      { key: 'INCOMPLETE_TAX_INFO', label: `No NTN on the TY${taxYear} tax profile`, count: missingTax.length, employees: missingTax.slice(0, 50) },
      { key: 'OTHERS', label: 'Others', count: missingSalary.length + orphaned.length, employees: missingSalary.slice(0, 50) },
    ];

    // Progress is how far the run has been worked out, not how many checks
    // passed — a run with exceptions is still fully processed.
    const processed = total > 0;
    const stages = [
      { label: 'Data validation', complete: processed },
      { label: 'Calculations', complete: processed },
      { label: 'Tax deductions', complete: processed && withoutCompliance === 0 },
      { label: 'Payroll calculation', complete: processed },
    ];
    const done = stages.filter((stage) => stage.complete).length;

    return {
      payrollRun: this.runSummary(run),
      totalEmployees: total,
      taxYear,
      validation: { allPassed: checks.every((entry) => entry.passed), checks },
      exceptions: { total: exceptions.reduce((sum, entry) => sum + entry.count, 0), rows: exceptions },
      progress: {
        percentage: stages.length ? Math.round((done / stages.length) * 100) : 0,
        complete: done === stages.length,
        stages,
      },
      /** Whether money can safely move: everyone payable, every line attached to an employee. */
      canAdvance: missingBank.length === 0 && orphaned.length === 0,
      blockedBy:
        missingBank.length > 0
          ? `${missingBank.length} employee(s) have no payable bank details.`
          : orphaned.length > 0
            ? `${orphaned.length} payroll line(s) reference an employee that no longer exists.`
            : null,
    };
  }

  private async loadEditableRecord(tenantId: string, recordId: string) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const record = await Record.findOne({ where: { id: recordId, tenantId } });
    if (!record) this.notFound('Payroll line', recordId);
    const run = await this.loadRun(tenantId, record.payrollRunId);
    this.assertInReview(run, 'changing a line');
    return record;
  }

  /** payroll.edit (as before) or the Phase 4 adjustments grant. */
  private requireAdjust(what = 'adjust payroll') {
    requireAnyPayrollPermission(['payroll.edit', 'payroll.adjustments.manage', 'payroll.manage'], what);
  }

  async addAdjustment(tenantId: string, recordId: string, dto: AddPayrollAdjustmentDto) {
    this.requireAdjust();
    const record = await this.loadEditableRecord(tenantId, recordId);
    const run = await this.loadRun(tenantId, record.payrollRunId);
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const actor = this.actor();
    const netBefore = money(record.netPay);
    const adjustment = await Adjustment.create({
      tenantId,
      payrollRunId: record.payrollRunId,
      payrollRecordId: record.id,
      employeeId: record.employeeId,
      payrollPeriod: String(run.periodStart).slice(0, 7),
      effectiveDate: dto.effectiveDate ?? null,
      type: dto.type,
      // The category decides the earning's tax treatment; deductions don't have one.
      category: dto.type === PayrollAdjustmentType.EARNING ? (dto.category ?? 'OTHER') : 'OTHER',
      amount: round2(dto.amount),
      reason: dto.reason.trim(),
      createdByUserId: actor.userId,
      createdByEmail: actor.email,
    });
    await this.applyAdjustments(tenantId, record);
    await this.audit(tenantId, 'PayrollAdjustment', record.payrollRunId, 'CREATE', {
      event: { from: null, to: 'PAYROLL_ADJUSTMENT_ADDED' },
      line: { from: null, to: record.id },
      employeeId: { from: null, to: record.employeeId },
      type: { from: null, to: dto.type },
      category: { from: null, to: adjustment.category },
      amount: { from: null, to: round2(dto.amount) },
      reason: { from: null, to: adjustment.reason },
      netPay: { from: netBefore, to: money(record.netPay) },
    });
    return this.getRecord(tenantId, recordId);
  }

  async removeAdjustment(tenantId: string, adjustmentId: string) {
    this.requireAdjust();
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const adjustment = await Adjustment.findOne({ where: { id: adjustmentId, tenantId } });
    if (!adjustment) this.notFound('Adjustment', adjustmentId);
    const record = await this.loadEditableRecord(tenantId, adjustment.payrollRecordId);
    const netBefore = money(record.netPay);
    await adjustment.destroy();
    await this.applyAdjustments(tenantId, record);
    await this.audit(tenantId, 'PayrollAdjustment', record.payrollRunId, 'DELETE', {
      event: { from: null, to: 'PAYROLL_ADJUSTMENT_REMOVED' },
      line: { from: null, to: record.id },
      employeeId: { from: null, to: record.employeeId },
      type: { from: adjustment.type, to: null },
      amount: { from: money(adjustment.amount), to: null },
      reason: { from: adjustment.reason, to: null },
      netPay: { from: netBefore, to: money(record.netPay) },
    });
    return this.getRecord(tenantId, record.id);
  }

  // ── One-off entries ahead of payroll (Phase 4) ────────────────────────────

  private entryRow(row: any, employee?: any, run?: any) {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employee: employee ? this.person(employee) : null,
      payrollPeriod: row.payrollPeriod,
      effectiveDate: row.effectiveDate ? String(row.effectiveDate).slice(0, 10) : null,
      type: row.type,
      category: row.category ?? 'OTHER',
      amount: money(row.amount),
      reason: row.reason,
      /** PENDING: waiting for its payroll · IN_REVIEW · LOCKED */
      state: !row.payrollRunId ? 'PENDING' : run && this.stepOf(run) === PayrollProcessStep.REVIEW ? 'IN_REVIEW' : 'LOCKED',
      payrollRunId: row.payrollRunId ?? null,
      payrollRecordId: row.payrollRecordId ?? null,
      createdAt: row.createdAt,
      createdBy: row.createdByEmail ?? null,
    };
  }

  /** Removes an entry: one still waiting for its payroll, or — in Review — from its line. */
  async removeAdjustmentEntry(tenantId: string, adjustmentId: string) {
    this.requireAdjust();
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const adjustment = await Adjustment.findOne({ where: { id: adjustmentId, tenantId } });
    if (!adjustment) this.notFound('Adjustment', adjustmentId);
    if (adjustment.payrollRecordId) {
      await this.removeAdjustment(tenantId, adjustmentId);
      return { removed: true, id: adjustmentId };
    }
    // Still waiting for its payroll: nothing was calculated from it yet.
    await adjustment.destroy();
    await this.audit(tenantId, 'PayrollAdjustment', adjustment.id, 'DELETE', {
      event: { from: null, to: 'PAYROLL_ADJUSTMENT_REMOVED' },
      employeeId: { from: null, to: adjustment.employeeId },
      period: { from: adjustment.payrollPeriod, to: null },
      type: { from: adjustment.type, to: null },
      reason: { from: adjustment.reason, to: null },
    });
    return { removed: true, id: adjustment.id };
  }

  /** Earnings and deductions entered for employees and payroll months, newest first. */
  async listAdjustmentEntries(tenantId: string, filters: { period?: string; employeeId?: string } = {}) {
    requireAnyPayrollPermission(
      ['payroll.view', 'payroll.adjustments.view', 'payroll.adjustments.manage', 'payroll.manage'],
      'view payroll adjustments',
    );
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Adjustment.findAll({
      where: {
        tenantId,
        ...(filters.period ? { payrollPeriod: filters.period } : {}),
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      },
      order: [['createdAt', 'DESC']],
      limit: 500,
    })) as any[];
    const employeeIds = [...new Set(rows.map((row) => row.employeeId).filter(Boolean))];
    const runIds = [...new Set(rows.map((row) => row.payrollRunId).filter(Boolean))];
    const [employees, runs] = await Promise.all([
      employeeIds.length
        ? Employee.findAll({ where: { tenantId, id: { [Op.in]: employeeIds } }, include: [await this.employeeInclude(tenantId)] })
        : Promise.resolve([]),
      runIds.length ? Run.findAll({ where: { tenantId, id: { [Op.in]: runIds } } }) : Promise.resolve([]),
    ]);
    const employeeById = new Map((employees as any[]).map((e) => [e.id, e]));
    const runById = new Map((runs as any[]).map((r) => [r.id, r]));
    return rows.map((row) => this.entryRow(row, employeeById.get(row.employeeId), runById.get(row.payrollRunId)));
  }

  /**
   * A bonus, commission, arrears or deduction for an employee's payroll
   * month. If that month's payroll is in Review it goes straight onto the
   * line; before the payroll exists it waits for it; a locked month refuses.
   */
  async createAdjustmentEntry(
    tenantId: string,
    dto: {
      employeeId: string;
      payrollPeriod: string;
      type: PayrollAdjustmentType;
      category?: string;
      amount: number;
      reason: string;
      effectiveDate?: string | null;
    },
  ) {
    this.requireAdjust('add payroll adjustments');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(dto.payrollPeriod ?? '')) this.badRequest('The payroll period is YYYY-MM.');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({ where: { tenantId, id: dto.employeeId } });
    if (!employee) this.notFound('Employee', dto.employeeId);
    const { periodStart } = monthBounds(dto.payrollPeriod);
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const run: any = await Run.findOne({ where: { tenantId, periodStart } });
    if (run && this.stepOf(run) !== PayrollProcessStep.REVIEW) {
      this.conflict(
        `The ${periodLabel(periodStart)} payroll is ${STEP_LABELS[this.stepOf(run)].toLowerCase()} and locked — add it to a later month instead.`,
      );
    }
    if (run) {
      const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
      const record: any = await Record.findOne({ where: { tenantId, payrollRunId: run.id, employeeId: dto.employeeId } });
      if (record) {
        const line = await this.addAdjustment(tenantId, record.id, dto as any);
        return { state: 'IN_REVIEW', payrollRunId: run.id, line };
      }
    }
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const actor = this.actor();
    const row = await Adjustment.create({
      tenantId,
      payrollRunId: null,
      payrollRecordId: null,
      employeeId: dto.employeeId,
      payrollPeriod: dto.payrollPeriod,
      effectiveDate: dto.effectiveDate ?? null,
      type: dto.type,
      category: dto.type === PayrollAdjustmentType.EARNING ? (dto.category ?? 'OTHER') : 'OTHER',
      amount: round2(dto.amount),
      reason: dto.reason.trim(),
      createdByUserId: actor.userId,
      createdByEmail: actor.email,
    });
    await this.audit(tenantId, 'PayrollAdjustment', row.id, 'CREATE', {
      event: { from: null, to: dto.type === PayrollAdjustmentType.EARNING ? `${row.category}_ADDED` : 'DEDUCTION_ADDED' },
      employeeId: { from: null, to: dto.employeeId },
      period: { from: null, to: dto.payrollPeriod },
      type: { from: null, to: dto.type },
      category: { from: null, to: row.category },
      reason: { from: null, to: row.reason },
    });
    return {
      state: 'PENDING',
      entry: this.entryRow(row, employee),
      note: run
        ? `${nameOf(employee)} isn’t on the ${periodLabel(periodStart)} payroll yet — this is added when it is recalculated.`
        : `Added to the ${periodLabel(periodStart)} payroll when it is created.`,
    };
  }

  // ── Salary & bank ─────────────────────────────────────────────────────────

  private async loadEmployee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) this.notFound('Employee', employeeId);
    return employee;
  }

  /** Salary in effect today, scheduled and past revisions, and bank details. */
  async getEmployeePay(tenantId: string, employeeId: string) {
    this.requirePermission('payroll.view', 'view salaries');
    const employee = await this.loadEmployee(tenantId, employeeId);
    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    const revisions = (await Revision.findAll({
      where: { tenantId, employeeId },
      order: [['effectiveFrom', 'DESC']],
    })) as any[];
    const names = await this.namesByEmail(tenantId, revisions.map((row) => row.changedByEmail));
    const now = today();

    const current = salaryForPeriod(
      revisions.map((row) => ({
        effectiveFrom: String(row.effectiveFrom),
        basicSalary: money(row.basicSalary),
        allowances: money(row.allowances),
        recurringDeductions: money(row.recurringDeductions),
      })),
      now,
      {
        basicSalary: money(employee.basicSalary),
        allowances: money(employee.allowances),
        recurringDeductions: money(employee.recurringDeductions),
        effectiveFrom: employee.salaryEffectiveFrom ?? null,
      },
    );

    return {
      employeeId,
      currency: (await this.payrollPolicy(tenantId)).currency,
      current: { ...current, monthlyGross: round2(current.basicSalary + current.allowances) },
      history: revisions.map((row) => ({
        id: row.id,
        effectiveFrom: String(row.effectiveFrom).slice(0, 10),
        basicSalary: money(row.basicSalary),
        allowances: money(row.allowances),
        recurringDeductions: money(row.recurringDeductions),
        monthlyGross: round2(money(row.basicSalary) + money(row.allowances)),
        reason: row.reason ?? null,
        scheduled: String(row.effectiveFrom).slice(0, 10) > now,
        changedAt: row.updatedAt ?? row.createdAt,
        changedBy: row.changedByEmail
          ? { email: row.changedByEmail, name: names.get(String(row.changedByEmail).toLowerCase()) ?? null }
          : null,
      })),
      bank: {
        bankName: employee.bankName ?? null,
        bankAccountTitle: employee.bankAccountTitle ?? null,
        bankAccountNumber: employee.bankAccountNumber ?? null,
        iban: employee.iban ?? null,
      },
    };
  }

  /**
   * Saves a salary from a date. A new date adds a revision; the same date
   * corrects that revision. The employee's "current" figures follow the
   * latest revision that has taken effect. Runs already approved are
   * snapshots and never change; an open (Review) run covering the date is
   * reported so HR can recalculate it.
   */
  async setEmployeeSalary(tenantId: string, employeeId: string, dto: SetEmployeeSalaryDto) {
    this.requirePermission('payroll.edit', 'change salaries');
    const employee = await this.loadEmployee(tenantId, employeeId);
    const effectiveFrom = String(dto.effectiveFrom).slice(0, 10);
    if (employee.joiningDate && effectiveFrom < String(employee.joiningDate).slice(0, 10)) {
      this.badRequest(`A salary can’t take effect before the joining date (${String(employee.joiningDate).slice(0, 10)}).`);
    }
    if (dto.basicSalary + dto.allowances <= 0) {
      this.badRequest('Enter a basic salary or allowances.');
    }

    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    const actor = this.actor();
    const values = {
      basicSalary: round2(dto.basicSalary),
      allowances: round2(dto.allowances),
      recurringDeductions: round2(dto.recurringDeductions),
      reason: dto.reason?.trim() || null,
      changedByUserId: actor.userId,
      changedByEmail: actor.email,
    };
    const existing = await Revision.findOne({ where: { tenantId, employeeId, effectiveFrom } });
    const before = existing
      ? { basicSalary: money(existing.basicSalary), allowances: money(existing.allowances), recurringDeductions: money(existing.recurringDeductions) }
      : { basicSalary: money(employee.basicSalary), allowances: money(employee.allowances), recurringDeductions: money(employee.recurringDeductions) };
    if (existing) await existing.update(values);
    else await Revision.create({ tenantId, employeeId, effectiveFrom, ...values });

    // The employee row mirrors whatever is in effect today.
    const inEffect = await Revision.findOne({
      where: { tenantId, employeeId, effectiveFrom: { [Op.lte]: today() } },
      order: [['effectiveFrom', 'DESC']],
    });
    if (inEffect) {
      await employee.update({
        basicSalary: money(inEffect.basicSalary),
        allowances: money(inEffect.allowances),
        recurringDeductions: money(inEffect.recurringDeductions),
        salaryEffectiveFrom: String(inEffect.effectiveFrom).slice(0, 10),
      });
    }

    await this.audit(tenantId, 'EmployeeSalary', employeeId, existing ? 'UPDATE' : 'CREATE', {
      event: { from: null, to: existing ? 'SALARY_CORRECTED' : 'SALARY_REVISED' },
      effectiveFrom: { from: null, to: effectiveFrom },
      basicSalary: { from: before.basicSalary, to: values.basicSalary },
      allowances: { from: before.allowances, to: values.allowances },
      recurringDeductions: { from: before.recurringDeductions, to: values.recurringDeductions },
      ...(values.reason ? { reason: { from: null, to: values.reason } } : {}),
    });

    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const openRun = await Run.findOne({
      where: { tenantId, step: PayrollProcessStep.REVIEW, periodEnd: { [Op.gte]: effectiveFrom } },
      order: [['periodEnd', 'ASC']],
    });

    return {
      ...(await this.getEmployeePay(tenantId, employeeId)),
      openRun: openRun ? { id: openRun.id, periodLabel: periodLabel(openRun.periodStart) } : null,
    };
  }

  /** Bank details for salary transfer. Not historical — a change applies to the next run. */
  async setEmployeeBank(tenantId: string, employeeId: string, dto: SetEmployeeBankDto) {
    this.requirePermission('payroll.edit', 'change bank details');
    const employee = await this.loadEmployee(tenantId, employeeId);
    const clean = (value: string | null | undefined) => {
      if (value === undefined) return undefined;
      const trimmed = String(value ?? '').trim();
      return trimmed === '' ? null : trimmed;
    };
    const patch: Record<string, string | null> = {};
    const bankName = clean(dto.bankName);
    const title = clean(dto.bankAccountTitle);
    const account = clean(dto.bankAccountNumber);
    const iban = clean(dto.iban);
    if (bankName !== undefined) patch.bankName = bankName;
    if (title !== undefined) patch.bankAccountTitle = title;
    if (account !== undefined) patch.bankAccountNumber = account;
    if (iban !== undefined) patch.iban = iban ? iban.replace(/\s+/g, '').toUpperCase() : null;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, value] of Object.entries(patch)) {
      const previous = (employee as any)[field] ?? null;
      if (previous === value) continue;
      // Account numbers are recorded masked — the log shows that it changed.
      const sensitive = field === 'bankAccountNumber' || field === 'iban';
      changes[field] = sensitive ? { from: mask(previous), to: mask(value) } : { from: previous, to: value };
    }
    if (Object.keys(changes).length) {
      await employee.update(patch);
      await this.audit(tenantId, 'EmployeeBank', employeeId, 'UPDATE', {
        event: { from: null, to: 'BANK_DETAILS_UPDATED' },
        ...changes,
      });
    }
    return this.getEmployeePay(tenantId, employeeId);
  }
}
