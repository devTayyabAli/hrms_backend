import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Op } from 'sequelize';
import { firstValueFrom, timeout } from 'rxjs';
import {
  MESSAGE_PATTERNS,
  PayrollProcessStep,
  SERVICES,
  toCsv,
  type CsvColumn,
} from '@app/common';
import { COMPLIANCE_TEMPLATES } from '../data/compliance-templates';
import {
  ComplianceRuleStatus,
  ComplianceRuleType,
} from '../models/compliance-rule.model';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { TenantService } from './tenant.service';
import {
  payrollActor,
  payrollError,
  writePayrollAudit,
} from './payroll-access';
import {
  taxYearBounds,
  taxYearOf,
  validateRuleConfiguration,
  type ComplianceProfile,
  type EobiConfig,
  type IncomeTaxConfig,
  type ProvidentFundConfig,
  type RuleRef,
} from './payroll-compliance';
import { renderTaxCertificatePdf } from './tax-certificate-pdf';

/** Locked months — the only ones that count toward year-to-date and reports. */
const LOCKED_STEPS = [
  PayrollProcessStep.APPROVAL,
  PayrollProcessStep.PAYMENT,
  PayrollProcessStep.COMPLETED,
];

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const nameOf = (
  employee: { firstName?: string; lastName?: string } | null | undefined,
) =>
  employee
    ? [employee.firstName, employee.lastName].filter(Boolean).join(' ')
    : '';

const monthLabel = (periodStart: string) =>
  new Date(`${String(periodStart).slice(0, 10)}T12:00:00Z`).toLocaleString(
    'en-US',
    { month: 'long', year: 'numeric', timeZone: 'UTC' },
  );

/** The profile fields a tax profile save may set. */
const PROFILE_FIELDS = [
  'effectiveFrom',
  'ntn',
  'taxStatus',
  'residency',
  'previousEmployerTaxableIncome',
  'previousEmployerTaxDeducted',
  'annualDeductibleAllowances',
  'annualTaxCredits',
  'taxAdjustment',
  'taxAdjustmentReason',
  'reductionCode',
  'medicalAllowanceMonthly',
  'freeMedicalProvided',
  'eobiCovered',
  'eobiRegistrationNumber',
  'pfMember',
  'pfJoinDate',
  'notes',
] as const;

/** Per-year fields: a year without its own profile starts these at zero. */
const YEAR_SPECIFIC = new Set([
  'previousEmployerTaxableIncome',
  'previousEmployerTaxDeducted',
  'annualDeductibleAllowances',
  'annualTaxCredits',
  'taxAdjustment',
  'taxAdjustmentReason',
]);

export interface ComplianceContext {
  rules: {
    incomeTax: RuleRef<IncomeTaxConfig> | null;
    eobi: RuleRef<EobiConfig> | null;
    pf: RuleRef<ProvidentFundConfig> | null;
  };
  /** Warnings for the whole run. */
  runNotes: string[];
  profileOf: (employeeId: string) => ComplianceProfile;
  ytdOf: (employeeId: string) => {
    taxableIncome: number;
    incomeTax: number;
    months: number;
    notes: string[];
  };
}

/**
 * Payroll compliance: the organization's statutory rules (income tax, EOBI,
 * provident fund), employees' tax profiles, and what payroll hands the
 * compliance engine each month; plus the reports, annual summaries and
 * certificates built from locked payroll snapshots.
 *
 * Permissions: `payroll.compliance.view|manage` for rules and reports,
 * `payroll.tax.view|manage` for tax profiles, summaries and certificates;
 * `payroll.manage` covers all of them. Employees reach only their own summary
 * and certificates, through their login.
 */
@Injectable()
export class PayrollComplianceService {
  private readonly logger = new Logger(PayrollComplianceService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly tenantService?: TenantService,
    @Optional()
    @Inject(SERVICES.AUTH_SERVICE)
    private readonly authClient?: ClientProxy,
  ) {}

  private require(
    permission:
      | 'payroll.compliance.view'
      | 'payroll.compliance.manage'
      | 'payroll.tax.view'
      | 'payroll.tax.manage',
    what: string,
  ) {
    // `payroll.manage` is full payroll access; `.manage` covers `.view`.
    const actor = payrollActor();
    if (!actor.present || actor.isFullAccess) return;
    const [area] = permission.split('.').slice(1);
    const held = new Set(actor.permissions);
    if (
      held.has(permission) ||
      held.has(`payroll.${area}.manage`) ||
      held.has('payroll.manage')
    )
      return;
    payrollError(`You don't have permission to ${what}.`, HttpStatus.FORBIDDEN);
  }

  private audit(
    tenantId: string,
    tableName: string,
    recordId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    changes: Record<string, { from: unknown; to: unknown }>,
  ) {
    return writePayrollAudit(
      this.modelProvider,
      this.logger,
      tenantId,
      tableName,
      recordId,
      action,
      changes,
    );
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  private ruleRow(rule: any) {
    return {
      id: rule.id,
      country: rule.country,
      ruleType: rule.ruleType,
      name: rule.name,
      taxYear: rule.taxYear ?? null,
      effectiveFrom: String(rule.effectiveFrom).slice(0, 10),
      effectiveTo: rule.effectiveTo
        ? String(rule.effectiveTo).slice(0, 10)
        : null,
      status: rule.status,
      configuration: rule.configuration,
      requiresReview: Boolean(rule.requiresReview),
      reviewNotes: rule.reviewNotes ?? null,
      source: rule.source ?? null,
      templateKey: rule.templateKey ?? null,
      validation: validateRuleConfiguration(rule.ruleType, rule.configuration),
      activatedAt: rule.activatedAt ?? null,
      activatedBy: rule.activatedByEmail ?? null,
      retiredAt: rule.retiredAt ?? null,
      updatedAt: rule.updatedAt,
      createdAt: rule.createdAt,
    };
  }

  async listRules(tenantId: string, ruleType?: string) {
    this.require('payroll.compliance.view', 'view compliance rules');
    const Rule = await this.modelProvider.getComplianceRuleModel(tenantId);
    const rows = await Rule.findAll({
      where: { tenantId, ...(ruleType ? { ruleType } : {}) },
      order: [
        ['effectiveFrom', 'DESC'],
        ['createdAt', 'DESC'],
      ],
    });
    return rows.map((rule) => this.ruleRow(rule));
  }

  listTemplates() {
    this.require('payroll.compliance.view', 'view compliance templates');
    return COMPLIANCE_TEMPLATES.map((template) => ({
      key: template.key,
      ruleType: template.ruleType,
      name: template.name,
      taxYear: template.taxYear,
      effectiveFrom: template.effectiveFrom,
      effectiveTo: template.effectiveTo,
      requiresReview: template.requiresReview,
      reviewNotes: template.reviewNotes,
      source: template.source,
      configuration: template.configuration,
    }));
  }

  private async loadRule(tenantId: string, id: string) {
    const Rule = await this.modelProvider.getComplianceRuleModel(tenantId);
    const rule = await Rule.findOne({ where: { tenantId, id } });
    if (!rule)
      payrollError(
        `Compliance rule '${id}' not found in this organization.`,
        HttpStatus.NOT_FOUND,
      );
    return rule;
  }

  private assertDates(
    effectiveFrom: string,
    effectiveTo: string | null,
    taxYear: number | null,
    ruleType: string,
  ) {
    if (effectiveTo && effectiveTo < effectiveFrom)
      payrollError(
        'The rule can’t end before it starts.',
        HttpStatus.BAD_REQUEST,
      );
    if (ruleType === ComplianceRuleType.INCOME_TAX) {
      if (!taxYear || taxYear < 2000 || taxYear > 2100)
        payrollError(
          'An income tax rule needs a valid tax year (e.g. 2027).',
          HttpStatus.BAD_REQUEST,
        );
      const { start, end } = taxYearBounds(taxYear);
      if (effectiveFrom < start || (effectiveTo ?? end) > end) {
        payrollError(
          `A tax year ${taxYear} rule must fall within ${start} to ${end}.`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

  /** A new DRAFT rule, from a template or from scratch. Never active until someone activates it. */
  async createRule(
    tenantId: string,
    dto: {
      templateKey?: string;
      ruleType?: string;
      name?: string;
      taxYear?: number | null;
      effectiveFrom?: string;
      effectiveTo?: string | null;
      configuration?: Record<string, any>;
    },
  ) {
    this.require('payroll.compliance.manage', 'create compliance rules');
    const template = dto.templateKey
      ? COMPLIANCE_TEMPLATES.find((t) => t.key === dto.templateKey)
      : null;
    if (dto.templateKey && !template)
      payrollError(
        `Unknown template '${dto.templateKey}'.`,
        HttpStatus.BAD_REQUEST,
      );
    const ruleType = template?.ruleType ?? dto.ruleType;
    if (
      !ruleType ||
      !Object.values(ComplianceRuleType).includes(
        ruleType as ComplianceRuleType,
      )
    ) {
      payrollError('Choose the rule type.', HttpStatus.BAD_REQUEST);
    }
    const effectiveFrom = String(
      dto.effectiveFrom ?? template?.effectiveFrom ?? '',
    ).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom))
      payrollError('An effective date is required.', HttpStatus.BAD_REQUEST);
    const effectiveTo =
      dto.effectiveTo !== undefined
        ? dto.effectiveTo?.slice(0, 10) || null
        : (template?.effectiveTo ?? null);
    const taxYear =
      dto.taxYear !== undefined ? dto.taxYear : (template?.taxYear ?? null);
    this.assertDates(effectiveFrom, effectiveTo, taxYear, ruleType);

    const Rule = await this.modelProvider.getComplianceRuleModel(tenantId);
    const actor = payrollActor();
    const rule = await Rule.create({
      tenantId,
      country: 'PK',
      ruleType,
      name: (dto.name ?? template?.name ?? '').trim() || 'Compliance rule',
      taxYear,
      effectiveFrom,
      effectiveTo,
      status: ComplianceRuleStatus.DRAFT,
      configuration:
        dto.configuration ??
        JSON.parse(JSON.stringify(template?.configuration ?? {})),
      requiresReview: template?.requiresReview ?? false,
      reviewNotes: template?.reviewNotes ?? null,
      source: template?.source ?? null,
      templateKey: template?.key ?? null,
      createdByEmail: actor.email,
      updatedByEmail: actor.email,
    });
    await this.audit(tenantId, 'ComplianceRule', rule.id, 'CREATE', {
      event: { from: null, to: 'COMPLIANCE_RULE_CREATED' },
      ruleType: { from: null, to: ruleType },
      name: { from: null, to: rule.name },
      effectiveFrom: { from: null, to: effectiveFrom },
      ...(template ? { template: { from: null, to: template.key } } : {}),
    });
    return this.ruleRow(rule);
  }

  /** Drafts only — an active rule is frozen; a change is a new rule. */
  async updateRule(
    tenantId: string,
    id: string,
    dto: {
      name?: string;
      taxYear?: number | null;
      effectiveFrom?: string;
      effectiveTo?: string | null;
      configuration?: Record<string, any>;
      source?: string | null;
    },
  ) {
    this.require('payroll.compliance.manage', 'edit compliance rules');
    const rule = await this.loadRule(tenantId, id);
    if (rule.status !== ComplianceRuleStatus.DRAFT) {
      payrollError(
        'Only a draft rule can be edited. Create a new rule for the new dates instead — this keeps past payrolls reproducible.',
        HttpStatus.CONFLICT,
      );
    }
    const effectiveFrom =
      dto.effectiveFrom?.slice(0, 10) ??
      String(rule.effectiveFrom).slice(0, 10);
    const effectiveTo =
      dto.effectiveTo !== undefined
        ? dto.effectiveTo?.slice(0, 10) || null
        : rule.effectiveTo;
    const taxYear = dto.taxYear !== undefined ? dto.taxYear : rule.taxYear;
    this.assertDates(effectiveFrom, effectiveTo, taxYear, rule.ruleType);
    const changed = Object.keys(dto).filter(
      (key) => (dto as any)[key] !== undefined,
    );
    await rule.update({
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.configuration !== undefined
        ? { configuration: dto.configuration }
        : {}),
      ...(dto.source !== undefined ? { source: dto.source } : {}),
      effectiveFrom,
      effectiveTo,
      taxYear,
      updatedByEmail: payrollActor().email,
    });
    await this.audit(tenantId, 'ComplianceRule', rule.id, 'UPDATE', {
      event: { from: null, to: 'COMPLIANCE_RULE_UPDATED' },
      fields: { from: null, to: changed },
    });
    return this.ruleRow(rule);
  }

  /**
   * Makes a draft the rule payroll uses for its dates. Refused while the
   * configuration is invalid, while another active rule of the same type
   * overlaps the dates, or — for a rule with figures that need confirming —
   * until someone explicitly confirms they reviewed it.
   */
  async activateRule(
    tenantId: string,
    id: string,
    dto: { confirmReviewed?: boolean } = {},
  ) {
    this.require('payroll.compliance.manage', 'activate compliance rules');
    const rule = await this.loadRule(tenantId, id);
    if (rule.status !== ComplianceRuleStatus.DRAFT)
      payrollError('Only a draft rule can be activated.', HttpStatus.CONFLICT);
    const errors = validateRuleConfiguration(rule.ruleType, rule.configuration);
    if (errors.length)
      payrollError(
        `This rule can’t be activated yet: ${errors.join(' ')}`,
        HttpStatus.BAD_REQUEST,
      );
    if (rule.requiresReview && !dto.confirmReviewed) {
      payrollError(
        'This rule has figures that need review. Confirm you have checked them against the current law to activate it.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const Rule = await this.modelProvider.getComplianceRuleModel(tenantId);
    const from = String(rule.effectiveFrom).slice(0, 10);
    const to = rule.effectiveTo ? String(rule.effectiveTo).slice(0, 10) : null;
    const clash = await Rule.findOne({
      where: {
        tenantId,
        ruleType: rule.ruleType,
        status: ComplianceRuleStatus.ACTIVE,
        id: { [Op.ne]: rule.id },
        // Ranges overlap when each starts before the other ends.
        ...(to ? { effectiveFrom: { [Op.lte]: to } } : {}),
        [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: from } }],
      } as any,
    });
    if (clash) {
      payrollError(
        `"${clash.name}" is already active from ${String(clash.effectiveFrom).slice(0, 10)}${clash.effectiveTo ? ` to ${String(clash.effectiveTo).slice(0, 10)}` : ''}. Retire it, or give this rule dates that don't overlap.`,
        HttpStatus.CONFLICT,
      );
    }

    const actor = payrollActor();
    await rule.update({
      status: ComplianceRuleStatus.ACTIVE,
      activatedAt: new Date(),
      activatedByEmail: actor.email,
      ...(rule.requiresReview
        ? {
            reviewNotes:
              `${rule.reviewNotes ?? ''}\n[Reviewed and activated by ${actor.email ?? 'an administrator'} on ${new Date().toISOString().slice(0, 10)}]`.trim(),
          }
        : {}),
    });
    await this.audit(tenantId, 'ComplianceRule', rule.id, 'UPDATE', {
      event: { from: null, to: 'COMPLIANCE_RULE_ACTIVATED' },
      status: {
        from: ComplianceRuleStatus.DRAFT,
        to: ComplianceRuleStatus.ACTIVE,
      },
      reviewed: { from: null, to: Boolean(dto.confirmReviewed) },
    });
    return this.ruleRow(rule);
  }

  /**
   * Stops a rule applying to new calculations. Past payrolls are untouched —
   * each line carries its own copy of the rule it used.
   */
  async retireRule(tenantId: string, id: string) {
    this.require('payroll.compliance.manage', 'retire compliance rules');
    const rule = await this.loadRule(tenantId, id);
    if (rule.status === ComplianceRuleStatus.RETIRED) return this.ruleRow(rule);
    const from = rule.status;
    await rule.update({
      status: ComplianceRuleStatus.RETIRED,
      retiredAt: new Date(),
      retiredByEmail: payrollActor().email,
    });
    await this.audit(tenantId, 'ComplianceRule', rule.id, 'UPDATE', {
      event: { from: null, to: 'COMPLIANCE_RULE_RETIRED' },
      status: { from, to: ComplianceRuleStatus.RETIRED },
    });
    return this.ruleRow(rule);
  }

  // ── What payroll needs ────────────────────────────────────────────────────

  /** The active rule of a type in effect on a date. */
  private async ruleOn<C>(
    tenantId: string,
    ruleType: ComplianceRuleType,
    date: string,
  ): Promise<RuleRef<C> | null> {
    const Rule = await this.modelProvider.getComplianceRuleModel(tenantId);
    const rule = await Rule.findOne({
      where: {
        tenantId,
        ruleType,
        status: ComplianceRuleStatus.ACTIVE,
        effectiveFrom: { [Op.lte]: date },
        [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: date } }],
      } as any,
      order: [['effectiveFrom', 'DESC']],
    });
    if (!rule) return null;
    return {
      id: rule.id,
      name: rule.name,
      taxYear: rule.taxYear ?? null,
      effectiveFrom: String(rule.effectiveFrom).slice(0, 10),
      effectiveTo: rule.effectiveTo
        ? String(rule.effectiveTo).slice(0, 10)
        : null,
      // A copy — the snapshot must not share an object with anything live.
      configuration: JSON.parse(JSON.stringify(rule.configuration)) as C,
    };
  }

  private profileRowToCompliance(
    row: any,
    forThisYear: boolean,
  ): ComplianceProfile {
    const yearValue = (field: string) => (forThisYear ? num(row?.[field]) : 0);
    return {
      forThisYear,
      residency:
        row?.residency === 'NON_RESIDENT' ? 'NON_RESIDENT' : 'RESIDENT',
      previousEmployerTaxableIncome: yearValue('previousEmployerTaxableIncome'),
      previousEmployerTaxDeducted: yearValue('previousEmployerTaxDeducted'),
      annualDeductibleAllowances: yearValue('annualDeductibleAllowances'),
      annualTaxCredits: yearValue('annualTaxCredits'),
      taxAdjustment: yearValue('taxAdjustment'),
      reductionCode: forThisYear ? (row?.reductionCode ?? null) : null,
      medicalAllowanceMonthly: num(row?.medicalAllowanceMonthly),
      freeMedicalProvided: Boolean(row?.freeMedicalProvided),
      eobiCovered: row ? row.eobiCovered !== false : true,
      pfMember: row?.pfMember ?? null,
      pfJoinDate: row?.pfJoinDate ? String(row.pfJoinDate).slice(0, 10) : null,
    };
  }

  /**
   * Everything payroll hands the compliance engine for a period: the rules
   * in effect on its first day, each employee's profile for the tax year,
   * and their locked year-to-date. `excludeRunId` is the run being
   * calculated, so it never counts itself.
   */
  async contextForPeriod(
    tenantId: string,
    periodStart: string,
    employeeIds: string[],
    excludeRunId?: string,
  ): Promise<ComplianceContext> {
    const taxYear = taxYearOf(periodStart);
    const { start } = taxYearBounds(taxYear);
    const [incomeTax, eobi, pf] = await Promise.all([
      this.ruleOn<IncomeTaxConfig>(
        tenantId,
        ComplianceRuleType.INCOME_TAX,
        periodStart,
      ),
      this.ruleOn<EobiConfig>(tenantId, ComplianceRuleType.EOBI, periodStart),
      this.ruleOn<ProvidentFundConfig>(
        tenantId,
        ComplianceRuleType.PROVIDENT_FUND,
        periodStart,
      ),
    ]);
    const runNotes: string[] = [];
    if (!incomeTax)
      runNotes.push(
        `No active income tax rule covers ${monthLabel(periodStart)} — no income tax was deducted. Activate a tax year ${taxYear} rule under Payroll → Compliance, then recalculate.`,
      );

    const Profile =
      await this.modelProvider.getEmployeeTaxProfileModel(tenantId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);

    const profiles = employeeIds.length
      ? ((await Profile.findAll({
          where: {
            tenantId,
            employeeId: { [Op.in]: employeeIds },
            taxYear: { [Op.lte]: taxYear },
          },
          raw: true,
        })) as any[])
      : [];
    const earlierRuns = (await Run.findAll({
      where: {
        tenantId,
        periodStart: { [Op.gte]: start, [Op.lt]: periodStart },
      } as any,
      raw: true,
    })) as any[];
    const locked = earlierRuns.filter(
      (run) => LOCKED_STEPS.includes(run.step) && run.id !== excludeRunId,
    );
    const open = earlierRuns.filter(
      (run) =>
        run.step === PayrollProcessStep.REVIEW && run.id !== excludeRunId,
    );
    if (open.length) {
      runNotes.push(
        `${open.map((run) => monthLabel(run.periodStart)).join(', ')} ${open.length === 1 ? 'is' : 'are'} still in Review, so ${open.length === 1 ? 'it isn’t' : 'they aren’t'} counted in this year’s tax to date.`,
      );
    }
    const records =
      locked.length && employeeIds.length
        ? ((await Record.findAll({
            where: {
              tenantId,
              payrollRunId: { [Op.in]: locked.map((run) => run.id) },
              employeeId: { [Op.in]: employeeIds },
            },
            raw: true,
          })) as any[])
        : [];

    const profileOf = (employeeId: string): ComplianceProfile => {
      const mine = profiles
        .filter((row) => row.employeeId === employeeId)
        .sort((a, b) => b.taxYear - a.taxYear);
      const exact = mine.find((row) => row.taxYear === taxYear);
      return this.profileRowToCompliance(
        exact ?? mine[0] ?? null,
        Boolean(exact),
      );
    };
    const ytdOf = (employeeId: string) => {
      const mine = records.filter((row) => row.employeeId === employeeId);
      const notes: string[] = [];
      let taxableIncome = 0;
      let incomeTax = 0;
      for (const row of mine) {
        if (row.complianceSnapshot) {
          taxableIncome += num(row.taxableIncome);
          incomeTax += num(row.incomeTax);
        } else {
          // Calculated before compliance existed: its gross is the best
          // available taxable figure, and no tax was deducted.
          taxableIncome += num(row.grossPay);
        }
      }
      if (mine.some((row) => !row.complianceSnapshot)) {
        notes.push(
          'Some earlier months this tax year were paid before tax was configured — their gross pay counts as taxable, with no tax deducted.',
        );
      }
      return { taxableIncome, incomeTax, months: mine.length, notes };
    };

    return { rules: { incomeTax, eobi, pf }, runNotes, profileOf, ytdOf };
  }

  // ── Tax profiles ──────────────────────────────────────────────────────────

  private profileRow(row: any, taxYear: number, employee?: any) {
    return {
      employeeId: row?.employeeId ?? employee?.id,
      taxYear,
      exists: Boolean(row && row.taxYear === taxYear),
      inheritedFrom: row && row.taxYear !== taxYear ? row.taxYear : null,
      employee: employee
        ? {
            id: employee.id,
            name: nameOf(employee),
            employeeCode: employee.employeeCode,
            department: employee.department?.name ?? null,
          }
        : undefined,
      ...Object.fromEntries(
        PROFILE_FIELDS.map((field) => {
          const value = row?.[field] ?? null;
          if (row && row.taxYear !== taxYear && YEAR_SPECIFIC.has(field))
            return [field, field === 'taxAdjustmentReason' ? null : 0];
          if (
            [
              'previousEmployerTaxableIncome',
              'previousEmployerTaxDeducted',
              'annualDeductibleAllowances',
              'annualTaxCredits',
              'taxAdjustment',
              'medicalAllowanceMonthly',
            ].includes(field)
          )
            return [field, num(value)];
          if (field === 'eobiCovered')
            return [field, row ? row.eobiCovered !== false : true];
          if (field === 'freeMedicalProvided') return [field, Boolean(value)];
          if (field === 'residency') return [field, value ?? 'RESIDENT'];
          return [field, value];
        }),
      ),
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedByEmail ?? null,
    };
  }

  private async employeeInclude(tenantId: string) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    return [
      {
        model: Department,
        as: 'department',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: Designation,
        as: 'designation',
        attributes: ['id', 'title'],
        required: false,
      },
    ];
  }

  /** Every current employee and whether they have a profile for the tax year. */
  async listTaxProfiles(tenantId: string, taxYear: number) {
    this.require('payroll.tax.view', 'view tax profiles');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Profile =
      await this.modelProvider.getEmployeeTaxProfileModel(tenantId);
    const employees = (await Employee.findAll({
      where: { tenantId, status: { [Op.in]: ['ACTIVE', 'ON_LEAVE'] } },
      include: await this.employeeInclude(tenantId),
      order: [['firstName', 'ASC']],
    })) as any[];
    const profiles = (await Profile.findAll({
      where: { tenantId, taxYear: { [Op.lte]: taxYear } },
      raw: true,
    })) as any[];
    return employees.map((employee) => {
      const mine = profiles
        .filter((row) => row.employeeId === employee.id)
        .sort((a, b) => b.taxYear - a.taxYear);
      return this.profileRow(
        mine.find((row) => row.taxYear === taxYear) ?? mine[0] ?? null,
        taxYear,
        employee,
      );
    });
  }

  async getTaxProfile(tenantId: string, employeeId: string, taxYear: number) {
    this.require('payroll.tax.view', 'view tax profiles');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({
      where: { tenantId, id: employeeId },
      include: await this.employeeInclude(tenantId),
    });
    if (!employee)
      payrollError(
        `Employee '${employeeId}' not found in this organization.`,
        HttpStatus.NOT_FOUND,
      );
    const Profile =
      await this.modelProvider.getEmployeeTaxProfileModel(tenantId);
    const rows = (await Profile.findAll({
      where: { tenantId, employeeId, taxYear: { [Op.lte]: taxYear } },
      raw: true,
    })) as any[];
    rows.sort((a, b) => b.taxYear - a.taxYear);
    return this.profileRow(
      rows.find((row) => row.taxYear === taxYear) ?? rows[0] ?? null,
      taxYear,
      employee,
    );
  }

  /** Saves the profile for one tax year. Audited by field name — never the values. */
  async saveTaxProfile(
    tenantId: string,
    employeeId: string,
    taxYear: number,
    dto: Record<string, any>,
  ) {
    this.require('payroll.tax.manage', 'edit tax profiles');
    if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100)
      payrollError('Choose a valid tax year.', HttpStatus.BAD_REQUEST);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    if (!(await Employee.findOne({ where: { tenantId, id: employeeId } }))) {
      payrollError(
        `Employee '${employeeId}' not found in this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }
    for (const field of [
      'previousEmployerTaxableIncome',
      'previousEmployerTaxDeducted',
      'annualDeductibleAllowances',
      'annualTaxCredits',
      'medicalAllowanceMonthly',
    ]) {
      if (
        dto[field] !== undefined &&
        dto[field] !== null &&
        Number(dto[field]) < 0
      )
        payrollError(`${field} can’t be negative.`, HttpStatus.BAD_REQUEST);
    }
    if (dto.taxAdjustment && !String(dto.taxAdjustmentReason ?? '').trim()) {
      payrollError(
        'Give a reason for the tax adjustment.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const Profile =
      await this.modelProvider.getEmployeeTaxProfileModel(tenantId);
    const existing = await Profile.findOne({
      where: { tenantId, employeeId, taxYear },
    });
    const values: Record<string, any> = {};
    for (const field of PROFILE_FIELDS) {
      if (dto[field] === undefined) continue;
      const value =
        typeof dto[field] === 'string' ? dto[field].trim() || null : dto[field];
      values[field] = value;
    }
    values.updatedByEmail = payrollActor().email;
    const changed = PROFILE_FIELDS.filter(
      (field) =>
        dto[field] !== undefined &&
        String((existing as any)?.[field] ?? '') !==
          String(values[field] ?? ''),
    );

    if (existing) await existing.update(values);
    else await Profile.create({ tenantId, employeeId, taxYear, ...values });

    await this.audit(
      tenantId,
      'EmployeeTaxProfile',
      employeeId,
      existing ? 'UPDATE' : 'CREATE',
      {
        event: { from: null, to: 'TAX_PROFILE_SAVED' },
        taxYear: { from: null, to: taxYear },
        // Which fields changed — not their values.
        fields: { from: null, to: changed },
      },
    );
    return this.getTaxProfile(tenantId, employeeId, taxYear);
  }

  // ── Reports ───────────────────────────────────────────────────────────────

  /** Lines of locked (or, by filter, any) runs in the filtered months. */
  private async reportLines(
    tenantId: string,
    filters: {
      month?: string;
      taxYear?: number;
      departmentId?: string;
      employeeId?: string;
      status?: string;
    },
  ) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);

    const where: Record<string, any> = { tenantId };
    if (filters.month) where.periodStart = `${filters.month}-01`;
    else if (filters.taxYear) {
      const { start, end } = taxYearBounds(filters.taxYear);
      where.periodStart = { [Op.between]: [start, end] };
    }
    if (filters.status) where.step = filters.status;
    else where.step = { [Op.in]: LOCKED_STEPS };
    const runs = (await Run.findAll({
      where,
      order: [['periodStart', 'ASC']],
      raw: true,
    })) as any[];
    if (!runs.length) return [];
    const runOf = new Map(runs.map((run) => [run.id, run]));

    const records = (await Record.findAll({
      where: {
        tenantId,
        payrollRunId: { [Op.in]: runs.map((run) => run.id) },
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      },
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: [
            'id',
            'employeeCode',
            'firstName',
            'lastName',
            'departmentId',
          ],
          include: await this.employeeInclude(tenantId),
        },
      ],
    })) as any[];
    return records
      .filter(
        (record) =>
          !filters.departmentId ||
          record.employee?.departmentId === filters.departmentId,
      )
      .map((record) => ({ record, run: runOf.get(record.payrollRunId) }))
      .sort(
        (a, b) =>
          String(a.run.periodStart).localeCompare(String(b.run.periodStart)) ||
          nameOf(a.record.employee).localeCompare(nameOf(b.record.employee)),
      );
  }

  private person(record: any) {
    return {
      employeeId: record.employeeId,
      employee: nameOf(record.employee),
      employeeCode: record.employee?.employeeCode ?? '',
      department: record.employee?.department?.name ?? null,
    };
  }

  async report(
    tenantId: string,
    type: 'TAX' | 'EOBI' | 'PF',
    filters: Record<string, any> = {},
  ) {
    this.require(
      type === 'TAX' ? 'payroll.tax.view' : 'payroll.compliance.view',
      'view compliance reports',
    );
    const lines = await this.reportLines(tenantId, filters);
    const rows = lines.map(({ record, run }) => {
      const base = {
        ...this.person(record),
        payrollMonth: monthLabel(run.periodStart),
        periodStart: String(run.periodStart).slice(0, 10),
        runStatus: run.step,
        taxYear: record.taxYear ?? taxYearOf(String(run.periodStart)),
      };
      const snapshot = record.complianceSnapshot ?? null;
      if (type === 'TAX') {
        const adjustment = num(snapshot?.result?.taxAdjustmentPortion);
        return {
          ...base,
          taxableIncome: num(record.taxableIncome),
          taxDeducted: num(num(record.incomeTax) - adjustment),
          taxAdjustment: adjustment,
          netTax: num(record.incomeTax),
          rule: snapshot?.rules?.incomeTax?.name ?? null,
        };
      }
      if (type === 'EOBI') {
        const wage = num(snapshot?.result?.eobiWage);
        return {
          ...base,
          applicableWage: wage,
          employeeContribution: num(record.eobiEmployee),
          employerContribution: num(record.eobiEmployer),
          totalContribution: num(
            num(record.eobiEmployee) + num(record.eobiEmployer),
          ),
        };
      }
      return {
        ...base,
        contributionBase: num(snapshot?.result?.pfBase),
        employeeContribution: num(record.pfEmployee),
        employerContribution: num(record.pfEmployer),
        totalContribution: num(num(record.pfEmployee) + num(record.pfEmployer)),
      };
    });
    const sum = (key: string) =>
      num(rows.reduce((total, row: any) => total + (row[key] ?? 0), 0));
    const totals =
      type === 'TAX'
        ? {
            taxableIncome: sum('taxableIncome'),
            taxDeducted: sum('taxDeducted'),
            taxAdjustment: sum('taxAdjustment'),
            netTax: sum('netTax'),
          }
        : {
            employeeContribution: sum('employeeContribution'),
            employerContribution: sum('employerContribution'),
            totalContribution: sum('totalContribution'),
          };
    return { type, rows, totals, count: rows.length };
  }

  async exportReport(
    tenantId: string,
    type: 'TAX' | 'EOBI' | 'PF',
    filters: Record<string, any> = {},
  ) {
    const report = await this.report(tenantId, type, filters);
    const common: CsvColumn<any>[] = [
      { header: 'Employee', value: (r) => r.employee },
      { header: 'Employee ID', value: (r) => r.employeeCode },
      { header: 'Department', value: (r) => r.department },
      { header: 'Tax Year', value: (r) => r.taxYear },
      { header: 'Payroll Month', value: (r) => r.payrollMonth },
    ];
    const specific: CsvColumn<any>[] =
      type === 'TAX'
        ? [
            { header: 'Taxable Income', value: (r) => r.taxableIncome },
            { header: 'Tax Deducted', value: (r) => r.taxDeducted },
            { header: 'Tax Adjustment', value: (r) => r.taxAdjustment },
            { header: 'Net Tax', value: (r) => r.netTax },
          ]
        : [
            {
              header: type === 'EOBI' ? 'Applicable Wage' : 'Contribution Base',
              value: (r) =>
                type === 'EOBI' ? r.applicableWage : r.contributionBase,
            },
            {
              header: 'Employee Contribution',
              value: (r) => r.employeeContribution,
            },
            {
              header: 'Employer Contribution',
              value: (r) => r.employerContribution,
            },
            { header: 'Total Contribution', value: (r) => r.totalContribution },
          ];
    const csv = toCsv(report.rows, [...common, ...specific]);
    await this.audit(tenantId, 'ComplianceReport', type, 'CREATE', {
      event: { from: null, to: 'COMPLIANCE_REPORT_EXPORTED' },
      report: { from: null, to: type },
      filters: { from: null, to: filters },
      rows: { from: null, to: report.count },
    });
    const suffix =
      filters.month ??
      (filters.taxYear
        ? `TY${filters.taxYear}`
        : new Date().toISOString().slice(0, 10));
    return { filename: `${type.toLowerCase()}-report-${suffix}.csv`, csv };
  }

  // ── Annual summary & certificate ─────────────────────────────────────────

  /** The tax year for one employee, from locked payroll snapshots only. */
  private async annualSummary(
    tenantId: string,
    employeeId: string,
    taxYear: number,
  ) {
    const lines = (
      await this.reportLines(tenantId, { taxYear, employeeId })
    ).filter(({ run }) => LOCKED_STEPS.includes(run.step));
    const Profile =
      await this.modelProvider.getEmployeeTaxProfileModel(tenantId);
    const profile = (await Profile.findOne({
      where: { tenantId, employeeId, taxYear },
      raw: true,
    })) as any;
    const gross = num(
      lines.reduce((sum, { record }) => sum + num(record.grossPay), 0),
    );
    const taxable = num(
      lines.reduce(
        (sum, { record }) =>
          sum +
          (record.complianceSnapshot
            ? num(record.taxableIncome)
            : num(record.grossPay)),
        0,
      ),
    );
    const taxDeducted = num(
      lines.reduce((sum, { record }) => sum + num(record.incomeTax), 0),
    );
    const adjustmentsRecovered = num(
      lines.reduce(
        (sum, { record }) =>
          sum + num(record.complianceSnapshot?.result?.taxAdjustmentPortion),
        0,
      ),
    );
    const previousTaxable = num(profile?.previousEmployerTaxableIncome);
    const previousTax = num(profile?.previousEmployerTaxDeducted);
    return {
      taxYear,
      period: taxYearBounds(taxYear),
      months: lines.map(({ run, record }) => ({
        month: monthLabel(run.periodStart),
        periodStart: String(run.periodStart).slice(0, 10),
        gross: num(record.grossPay),
        taxable: record.complianceSnapshot
          ? num(record.taxableIncome)
          : num(record.grossPay),
        tax: num(record.incomeTax),
        status: run.step,
      })),
      grossSalary: gross,
      taxableSalary: taxable,
      exemptSalary: num(Math.max(0, gross - taxable)),
      // No benefits in kind are paid through payroll yet — shown for completeness.
      taxableBenefits: 0,
      taxDeducted: num(taxDeducted - adjustmentsRecovered),
      taxAdjustments: adjustmentsRecovered,
      totalTax: taxDeducted,
      previousEmployer:
        previousTaxable || previousTax
          ? { taxableIncome: previousTaxable, taxDeducted: previousTax }
          : null,
      ntn: profile?.ntn ?? null,
      notes: lines.some(({ record }) => !record.complianceSnapshot)
        ? [
            'Some months were paid before tax was configured; their gross pay is counted as taxable and no tax was deducted.',
          ]
        : [],
    };
  }

  private async employee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({
      where: { tenantId, id: employeeId },
      include: await this.employeeInclude(tenantId),
    });
    if (!employee)
      payrollError(
        `Employee '${employeeId}' not found in this organization.`,
        HttpStatus.NOT_FOUND,
      );
    return employee as any;
  }

  async getTaxSummary(tenantId: string, employeeId: string, taxYear: number) {
    this.require('payroll.tax.view', 'view tax summaries');
    const employee = await this.employee(tenantId, employeeId);
    return {
      employee: {
        id: employee.id,
        name: nameOf(employee),
        employeeCode: employee.employeeCode,
        department: employee.department?.name ?? null,
      },
      ...(await this.annualSummary(tenantId, employeeId, taxYear)),
    };
  }

  async listTaxSummaries(tenantId: string, taxYear: number) {
    this.require('payroll.tax.view', 'view tax summaries');
    const lines = await this.reportLines(tenantId, { taxYear });
    const byEmployee = new Map<string, any>();
    for (const { record } of lines) {
      const row = byEmployee.get(record.employeeId) ?? {
        ...this.person(record),
        months: 0,
        grossSalary: 0,
        taxableSalary: 0,
        totalTax: 0,
      };
      row.months += 1;
      row.grossSalary = num(row.grossSalary + num(record.grossPay));
      row.taxableSalary = num(
        row.taxableSalary +
          (record.complianceSnapshot
            ? num(record.taxableIncome)
            : num(record.grossPay)),
      );
      row.totalTax = num(row.totalTax + num(record.incomeTax));
      byEmployee.set(record.employeeId, row);
    }
    return [...byEmployee.values()].sort((a, b) =>
      a.employee.localeCompare(b.employee),
    );
  }

  private certificateRow(row: any) {
    return {
      id: row.id,
      employeeId: row.employeeId,
      taxYear: row.taxYear,
      certificateNumber: row.certificateNumber,
      generatedAt: row.generatedAt,
      generatedBy: row.generatedByEmail ?? null,
      totals: {
        grossSalary: num(row.summary?.grossSalary),
        taxableSalary: num(row.summary?.taxableSalary),
        totalTax: num(row.summary?.totalTax),
      },
      monthsCovered: row.summary?.months?.length ?? 0,
    };
  }

  /**
   * Issues the tax year's certificate from locked snapshots. If nothing has
   * changed since the last one it is returned as is; otherwise a new number
   * is issued and the old certificate stays on record.
   */
  async issueCertificate(
    tenantId: string,
    employeeId: string,
    taxYear: number,
  ) {
    this.require('payroll.tax.manage', 'issue tax certificates');
    const employee = await this.employee(tenantId, employeeId);
    const summary = await this.annualSummary(tenantId, employeeId, taxYear);
    if (!summary.months.length)
      payrollError(
        `No approved payroll for tax year ${taxYear} yet — nothing to certify.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    const organization = await this.organization(tenantId);
    const content = {
      ...summary,
      employee: {
        name: nameOf(employee),
        employeeCode: employee.employeeCode,
        designation: employee.designation?.title ?? null,
        department: employee.department?.name ?? null,
        cnic: employee.nationalId ?? null,
      },
      employer: organization,
    };

    const Certificate =
      await this.modelProvider.getTaxCertificateModel(tenantId);
    const latest = await Certificate.findOne({
      where: { tenantId, employeeId, taxYear },
      order: [['sequence', 'DESC']],
    });
    const figures = (s: any) =>
      JSON.stringify([
        s.grossSalary,
        s.taxableSalary,
        s.totalTax,
        s.months?.length,
      ]);
    if (latest && figures(latest.summary) === figures(content))
      return this.certificateRow(latest);

    const actor = payrollActor();
    const sequelize: any = Certificate.sequelize;
    const created = await sequelize.transaction(
      async (transaction: unknown) => {
        if (typeof sequelize.query === 'function') {
          // No model method takes an advisory lock. The statement is a
          // constant — nothing dynamic is interpolated — and it serializes
          // certificate numbering so two issues can't take the same sequence.
          // eslint-disable-next-line no-restricted-syntax
          await sequelize.query(
            `SELECT pg_advisory_xact_lock(hashtext('tax_certificate_sequence'))`,
            { transaction },
          );
        }
        const sequence =
          (Number(await Certificate.max('sequence', { transaction } as any)) ||
            0) + 1;
        return Certificate.create(
          {
            tenantId,
            employeeId,
            taxYear,
            sequence,
            certificateNumber: `TC-${taxYear}-${String(sequence).padStart(6, '0')}`,
            summary: content,
            generatedAt: new Date(),
            generatedByEmail: actor.email,
          },
          { transaction } as any,
        );
      },
    );
    await this.audit(tenantId, 'TaxCertificate', created.id, 'CREATE', {
      event: { from: null, to: 'TAX_CERTIFICATE_ISSUED' },
      employeeId: { from: null, to: employeeId },
      taxYear: { from: null, to: taxYear },
      certificateNumber: { from: null, to: created.certificateNumber },
    });
    return this.certificateRow(created);
  }

  async listCertificates(
    tenantId: string,
    filters: { taxYear?: number; employeeId?: string } = {},
  ) {
    this.require('payroll.tax.view', 'view tax certificates');
    const Certificate =
      await this.modelProvider.getTaxCertificateModel(tenantId);
    const rows = await Certificate.findAll({
      where: {
        tenantId,
        ...(filters.taxYear ? { taxYear: filters.taxYear } : {}),
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      },
      order: [['sequence', 'DESC']],
    });
    return rows.map((row) => this.certificateRow(row));
  }

  private async certificatePdf(tenantId: string, certificate: any) {
    const logo = await this.logoBytes(
      certificate.summary?.employer?.logoUrl ?? null,
    );
    const bytes = await renderTaxCertificatePdf(
      {
        ...certificate.summary,
        certificateNumber: certificate.certificateNumber,
        generatedAt: certificate.generatedAt,
      },
      { logo },
    );
    return {
      filename: `Tax-Certificate-${certificate.certificateNumber}.pdf`,
      mimeType: 'application/pdf' as const,
      contentBase64: bytes.toString('base64'),
    };
  }

  async getCertificatePdf(tenantId: string, certificateId: string) {
    this.require('payroll.tax.view', 'download tax certificates');
    const Certificate =
      await this.modelProvider.getTaxCertificateModel(tenantId);
    const certificate = await Certificate.findOne({
      where: { tenantId, id: certificateId },
    });
    if (!certificate)
      payrollError('Tax certificate not found.', HttpStatus.NOT_FOUND);
    return this.certificatePdf(tenantId, certificate);
  }

  // ── The employee's own ────────────────────────────────────────────────────

  private async me(tenantId: string, userId: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee = await Employee.findOne({ where: { tenantId, userId } });
    if (!employee && email?.trim())
      employee = await Employee.findOne({
        where: { tenantId, email: { [Op.iLike]: email.trim() } } as any,
      });
    if (!employee)
      payrollError(
        'No employee profile is linked to this login.',
        HttpStatus.NOT_FOUND,
      );
    return employee as any;
  }

  async myTaxSummary(
    tenantId: string,
    userId: string,
    email: string | undefined,
    taxYear: number,
  ) {
    const me = await this.me(tenantId, userId, email);
    const summary = await this.annualSummary(tenantId, me.id, taxYear);
    // Payroll's own notes about data quality stay with payroll staff.
    return { ...summary, notes: [] };
  }

  async myCertificates(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Certificate =
      await this.modelProvider.getTaxCertificateModel(tenantId);
    const rows = await Certificate.findAll({
      where: { tenantId, employeeId: me.id },
      order: [['sequence', 'DESC']],
    });
    return rows.map((row) => this.certificateRow(row));
  }

  async myCertificatePdf(
    tenantId: string,
    userId: string,
    email: string | undefined,
    certificateId: string,
  ) {
    const me = await this.me(tenantId, userId, email);
    const Certificate =
      await this.modelProvider.getTaxCertificateModel(tenantId);
    // Someone else's certificate reads as not found.
    const certificate = await Certificate.findOne({
      where: { tenantId, id: certificateId, employeeId: me.id },
    });
    if (!certificate)
      payrollError('Tax certificate not found.', HttpStatus.NOT_FOUND);
    return this.certificatePdf(tenantId, certificate);
  }

  // ── Branding ──────────────────────────────────────────────────────────────

  private async organization(tenantId: string) {
    try {
      const tenant: any = await this.tenantService?.getTenantById(tenantId);
      if (tenant) {
        const address = [tenant.address, tenant.city, tenant.country]
          .map((p) => String(p ?? '').trim())
          .filter(Boolean)
          .join(', ');
        return {
          name: String(
            tenant.organizationName || tenant.name || 'Organization',
          ).trim(),
          legalName: tenant.legalName || null,
          address: address || null,
          phone: tenant.phone || null,
          email: tenant.officialEmail || tenant.email || null,
          logoUrl: tenant.logoUrl || null,
        };
      }
    } catch (error: any) {
      this.logger.warn(
        `Could not load the organization for a certificate: ${error?.message ?? error}`,
      );
    }
    return {
      name: 'Organization',
      legalName: null,
      address: null,
      phone: null,
      email: null,
      logoUrl: null,
    };
  }

  private async logoBytes(logoUrl: string | null): Promise<Buffer | null> {
    const fileId = logoUrl?.match(/files\/public\/([0-9a-f-]{36})/i)?.[1];
    if (!fileId || !this.authClient) return null;
    try {
      const result: any = await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.FILE.DOWNLOAD_PUBLIC_FILE, { fileId })
          .pipe(timeout(8_000)),
      );
      return result?.buffer
        ? Buffer.from(result.buffer.data ?? result.buffer)
        : null;
    } catch {
      return null;
    }
  }
}
