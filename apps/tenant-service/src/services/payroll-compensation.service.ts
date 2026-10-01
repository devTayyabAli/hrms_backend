import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { PayrollProcessStep } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { payrollActor, payrollError, writePayrollAudit } from './payroll-access';
import {
  COMPONENT_CATEGORIES,
  NOT_IN_COMPENSATION,
  legacyCompensation,
  phase1Totals,
  resolveCompensation,
  validateComponentRule,
  type CompensationLine,
  type ComponentRule,
  type TaxTreatment,
} from './payroll-components';
import type { RecoveryInput, RecurringItemInput } from './payroll-calculation';

/**
 * Payroll Phase 4 — compensation: the component catalog, salary structures,
 * employees' effective-dated compensation, recurring earnings and
 * deductions, loans and advances, reimbursements and the compensation
 * import. It never calculates a payroll line: it hands the Phase 1
 * calculation what it needs (`contextForPeriod`) and is told when a run's
 * lines are saved and locked.
 *
 * Access — `<area>.manage` covers `<area>.view`, `payroll.manage` covers
 * everything; the existing grants keep what they could already do:
 *   components    view: payroll.components.view | payroll.view
 *                 manage: payroll.components.manage
 *   compensation  view: payroll.compensation.view | payroll.view
 *                 manage: payroll.compensation.manage | payroll.edit
 *   loans         view / manage: payroll.loans.view / .manage only
 *   adjustments   view: payroll.adjustments.view | payroll.view
 *                 manage: payroll.adjustments.manage | payroll.edit
 * A manager's or team lead's grants never include any of these.
 */

type Area = 'components' | 'compensation' | 'loans' | 'adjustments';
const LEGACY: Record<Area, { view: string[]; manage: string[] }> = {
  components: { view: ['payroll.view'], manage: [] },
  compensation: { view: ['payroll.view'], manage: ['payroll.edit'] },
  loans: { view: [], manage: [] },
  adjustments: { view: ['payroll.view'], manage: ['payroll.edit'] },
};

const LOCKED_STEPS = [PayrollProcessStep.APPROVAL, PayrollProcessStep.PAYMENT, PayrollProcessStep.COMPLETED] as string[];
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10));
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const nameOf = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');
const monthOf = (date: string) => date.slice(0, 7);
const lastDayOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export const RECURRING_EARNING_CATEGORIES = ['ALLOWANCE', 'BONUS', 'COMMISSION', 'OTHER'];
export const RECURRING_DEDUCTION_CATEGORIES = ['RECOVERY', 'PENALTY', 'OTHER_DEDUCTION'];

/** What payroll needs from compensation for one period. */
export interface CompensationContext {
  recurringOf: (employeeId: string) => RecurringItemInput[];
  recoveriesOf: (employeeId: string) => RecoveryInput[];
  reimbursementsOf: (employeeId: string) => { id: string; amount: number; category: string; description: string }[];
  overtimeBase: 'BASIC' | 'COMPONENTS';
}

@Injectable()
export class PayrollCompensationService {
  private readonly logger = new Logger(PayrollCompensationService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  // ── Access & audit ────────────────────────────────────────────────────────

  private allowed(area: Area, level: 'view' | 'manage') {
    const actor = payrollActor();
    if (!actor.present || actor.isFullAccess) return true;
    const held = new Set(actor.permissions);
    const grants = [
      'payroll.manage',
      `payroll.${area}.manage`,
      ...(level === 'view' ? [`payroll.${area}.view`, ...LEGACY[area].view] : []),
      ...LEGACY[area].manage,
    ];
    return grants.some((grant) => held.has(grant));
  }

  private require(area: Area, level: 'view' | 'manage', what: string) {
    if (!this.allowed(area, level)) payrollError(`You don't have permission to ${what}.`, HttpStatus.FORBIDDEN);
  }

  private audit(tenantId: string, tableName: string, recordId: string, action: 'CREATE' | 'UPDATE' | 'DELETE', changes: Record<string, { from: unknown; to: unknown }>) {
    return writePayrollAudit(this.modelProvider, this.logger, tenantId, tableName, recordId, action, changes);
  }

  private bad(message: string): never {
    payrollError(message, HttpStatus.BAD_REQUEST);
    throw new Error(message);
  }

  private notFound(what: string): never {
    payrollError(`${what} not found in this organization.`, HttpStatus.NOT_FOUND);
    throw new Error(what);
  }

  private async loadEmployee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({ where: { tenantId, id: employeeId } });
    if (!employee) this.notFound(`Employee '${employeeId}'`);
    return employee as any;
  }

  /** The latest locked payroll whose month reaches `date`, if any. */
  private async lockedPayrollOn(tenantId: string, date: string) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    return (await Run.findOne({
      where: { tenantId, step: { [Op.in]: LOCKED_STEPS }, periodEnd: { [Op.gte]: date } },
      order: [['periodEnd', 'DESC']],
    })) as any;
  }

  private async refuseLockedPeriod(tenantId: string, date: string, what: string) {
    const locked = await this.lockedPayrollOn(tenantId, date);
    if (locked) {
      const label = new Date(`${String(locked.periodStart).slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      payrollError(
        `${what} can’t take effect on ${date}: the ${label} payroll is already approved and locked. Choose a date after it — for money owed for earlier months, add an Arrears earning to the next payroll.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  // ── Components ────────────────────────────────────────────────────────────

  /** Every organization has a Basic Salary component; created the first time it's needed. */
  async ensureSystemComponents(tenantId: string) {
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const existing = await Component.findOne({ where: { tenantId, isSystem: true } });
    if (existing) return existing;
    return Component.create({
      tenantId,
      code: 'BASIC',
      name: 'Basic Salary',
      type: 'EARNING',
      category: 'BASIC',
      calculationMethod: 'FIXED',
      value: null,
      percentageBase: null,
      baseComponents: [],
      formula: null,
      taxTreatment: 'RULE_DEPENDENT',
      includedInGross: true,
      includedInOvertimeBase: true,
      includedInLeaveBase: true,
      effectiveFrom: '2000-01-01',
      status: 'ACTIVE',
      description: 'The basic salary. Base for percentage components, overtime and unpaid days.',
      isSystem: true,
    });
  }

  private componentRow(row: any) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      category: row.category,
      calculationMethod: row.calculationMethod,
      value: row.value === null || row.value === undefined ? null : Number(row.value),
      percentageBase: row.percentageBase ?? null,
      baseComponents: row.baseComponents ?? [],
      formula: row.formula ?? null,
      taxTreatment: row.taxTreatment,
      includedInGross: Boolean(row.includedInGross),
      includedInOvertimeBase: Boolean(row.includedInOvertimeBase),
      includedInLeaveBase: Boolean(row.includedInLeaveBase),
      effectiveFrom: day(row.effectiveFrom),
      effectiveTo: day(row.effectiveTo),
      status: row.status,
      description: row.description ?? null,
      isSystem: Boolean(row.isSystem),
      updatedAt: row.updatedAt,
    };
  }

  async listComponents(tenantId: string, filters: { type?: string; status?: string } = {}) {
    this.require('components', 'view', 'view payroll components');
    await this.ensureSystemComponents(tenantId);
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const rows = await Component.findAll({
      where: { tenantId, ...(filters.type ? { type: filters.type } : {}), ...(filters.status ? { status: filters.status } : {}) },
      order: [['type', 'ASC'], ['name', 'ASC']],
    });
    return rows.map((row) => this.componentRow(row));
  }

  private ruleFromDto(dto: Record<string, any>, current?: any): ComponentRule {
    const pick = <T>(key: string, fallback: T): T => (dto[key] !== undefined ? dto[key] : (current?.[key] ?? fallback));
    const value = pick<number | string | null>('value', null);
    return {
      code: String(pick('code', '')).trim().toUpperCase(),
      name: String(pick('name', '')).trim(),
      type: pick('type', 'EARNING'),
      category: pick('category', ''),
      calculationMethod: pick('calculationMethod', 'FIXED'),
      value: value === null || value === '' ? null : Number(value),
      percentageBase: pick('percentageBase', null),
      baseComponents: (pick<string[]>('baseComponents', []) ?? []).map((code) => String(code).toUpperCase()),
      formula: pick<string | null>('formula', null),
      taxTreatment: pick('taxTreatment', 'RULE_DEPENDENT'),
      includedInGross: Boolean(pick('includedInGross', true)),
      includedInOvertimeBase: Boolean(pick('includedInOvertimeBase', false)),
      includedInLeaveBase: Boolean(pick('includedInLeaveBase', false)),
    };
  }

  async createComponent(tenantId: string, dto: Record<string, any>) {
    this.require('components', 'manage', 'create payroll components');
    await this.ensureSystemComponents(tenantId);
    const rule = this.ruleFromDto(dto);
    const errors = validateComponentRule(rule);
    if (rule.category === 'BASIC') errors.push('The organization already has its Basic Salary component.');
    // Without a date a component can be used on any compensation, including
    // salaries entered for earlier months; a date restricts it from then on.
    const effectiveFrom = day(dto.effectiveFrom) ?? '2000-01-01';
    const effectiveTo = day(dto.effectiveTo);
    if (!isDate(effectiveFrom)) errors.push('Enter a valid effective date.');
    if (effectiveTo && effectiveTo < effectiveFrom) errors.push('The end date can’t be before the effective date.');
    if (errors.length) this.bad(errors.join(' '));
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    if (await Component.findOne({ where: { tenantId, code: rule.code } })) {
      payrollError(`A component with the code ${rule.code} already exists.`, HttpStatus.CONFLICT);
    }
    const actor = payrollActor();
    const row = await Component.create({
      tenantId,
      ...rule,
      effectiveFrom,
      effectiveTo,
      status: 'ACTIVE',
      description: dto.description?.trim() || null,
      isSystem: false,
      createdByEmail: actor.email,
      updatedByEmail: actor.email,
    });
    await this.audit(tenantId, 'PayrollComponent', row.id, 'CREATE', {
      event: { from: null, to: 'COMPONENT_CREATED' },
      code: { from: null, to: rule.code },
      type: { from: null, to: rule.type },
      method: { from: null, to: rule.calculationMethod },
    });
    return this.componentRow(row);
  }

  /**
   * Edits a catalog component. Nobody's pay changes: compensation keeps the
   * settings it was saved with until it is revised.
   */
  async updateComponent(tenantId: string, id: string, dto: Record<string, any>) {
    this.require('components', 'manage', 'edit payroll components');
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const row: any = await Component.findOne({ where: { tenantId, id } });
    if (!row) this.notFound('Component');
    if (dto.code !== undefined && String(dto.code).toUpperCase() !== row.code) this.bad('A component’s code can’t change — formulas and imports refer to it.');
    const locked = row.isSystem ? ['type', 'category', 'calculationMethod', 'percentageBase', 'baseComponents', 'formula'] : [];
    for (const key of locked) if (dto[key] !== undefined && JSON.stringify(dto[key]) !== JSON.stringify(row[key])) this.bad(`The Basic Salary’s ${key} can’t change.`);
    const rule = this.ruleFromDto({ ...dto, code: row.code }, row);
    const errors = validateComponentRule(rule);
    if (!row.isSystem && rule.category === 'BASIC') errors.push('Only the system Basic Salary component can be the basic.');
    const effectiveFrom = dto.effectiveFrom !== undefined ? day(dto.effectiveFrom) : day(row.effectiveFrom);
    const effectiveTo = dto.effectiveTo !== undefined ? day(dto.effectiveTo) : day(row.effectiveTo);
    if (!isDate(effectiveFrom)) errors.push('Enter a valid effective date.');
    if (effectiveTo && effectiveFrom && effectiveTo < effectiveFrom) errors.push('The end date can’t be before the effective date.');
    if (errors.length) this.bad(errors.join(' '));
    const changed = Object.keys(dto).filter((key) => key !== 'code' && dto[key] !== undefined && JSON.stringify(dto[key]) !== JSON.stringify(row[key]));
    await row.update({
      ...rule,
      effectiveFrom,
      effectiveTo,
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      updatedByEmail: payrollActor().email,
    });
    await this.audit(tenantId, 'PayrollComponent', row.id, 'UPDATE', {
      event: { from: null, to: 'COMPONENT_UPDATED' },
      code: { from: null, to: row.code },
      fields: { from: null, to: changed },
    });
    return this.componentRow(row);
  }

  async setComponentStatus(tenantId: string, id: string, status: 'ACTIVE' | 'INACTIVE') {
    this.require('components', 'manage', 'change payroll components');
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const row: any = await Component.findOne({ where: { tenantId, id } });
    if (!row) this.notFound('Component');
    if (row.isSystem && status !== 'ACTIVE') this.bad('The Basic Salary component can’t be disabled.');
    if (row.status === status) return this.componentRow(row);
    const from = row.status;
    await row.update({ status, updatedByEmail: payrollActor().email });
    await this.audit(tenantId, 'PayrollComponent', row.id, 'UPDATE', {
      event: { from: null, to: status === 'ACTIVE' ? 'COMPONENT_ENABLED' : 'COMPONENT_DISABLED' },
      code: { from: null, to: row.code },
      status: { from, to: status },
    });
    return this.componentRow(row);
  }

  // ── Salary structures ─────────────────────────────────────────────────────

  private structureRow(row: any, components: any[], lines: any[]) {
    const byId = new Map(components.map((c) => [c.id, c]));
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description ?? null,
      effectiveFrom: day(row.effectiveFrom),
      status: row.status,
      updatedAt: row.updatedAt,
      components: lines
        .filter((line) => line.structureId === row.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((line) => {
          const component = byId.get(line.componentId);
          return {
            componentId: line.componentId,
            code: component?.code ?? '?',
            name: component?.name ?? 'Unknown component',
            type: component?.type,
            category: component?.category,
            calculationMethod: line.calculationMethod ?? component?.calculationMethod,
            value: line.value !== null && line.value !== undefined ? Number(line.value) : component?.value !== null && component?.value !== undefined ? Number(component.value) : null,
            percentageBase: line.percentageBase ?? component?.percentageBase ?? null,
            baseComponents: line.baseComponents ?? component?.baseComponents ?? [],
            formula: line.formula ?? component?.formula ?? null,
            overridden: Boolean(line.calculationMethod || line.value !== null || line.percentageBase || line.formula || line.baseComponents),
          };
        }),
    };
  }

  async listStructures(tenantId: string) {
    this.require('compensation', 'view', 'view salary structures');
    const Structure = await this.modelProvider.getSalaryStructureModel(tenantId);
    const Line = await this.modelProvider.getSalaryStructureComponentModel(tenantId);
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    const [rows, lines, components, revisions] = await Promise.all([
      Structure.findAll({ where: { tenantId }, order: [['name', 'ASC']] }),
      Line.findAll({ where: { tenantId }, raw: true }),
      Component.findAll({ where: { tenantId }, raw: true }),
      Revision.findAll({ where: { tenantId, structureId: { [Op.ne]: null } }, attributes: ['employeeId', 'structureId'], raw: true }),
    ]);
    return rows.map((row: any) => ({
      ...this.structureRow(row, components as any[], lines as any[]),
      employees: new Set((revisions as any[]).filter((r) => r.structureId === row.id).map((r) => r.employeeId)).size,
    }));
  }

  /** A structure's lines as component rules: the component's settings, overridden where the structure says. */
  private async structureRules(tenantId: string, structureId: string) {
    const Structure = await this.modelProvider.getSalaryStructureModel(tenantId);
    const Line = await this.modelProvider.getSalaryStructureComponentModel(tenantId);
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const structure: any = await Structure.findOne({ where: { tenantId, id: structureId } });
    if (!structure) this.notFound('Salary structure');
    const lines = ((await Line.findAll({ where: { tenantId, structureId }, raw: true })) as any[]).sort((a, b) => a.sortOrder - b.sortOrder);
    const components = (await Component.findAll({ where: { tenantId, id: { [Op.in]: lines.map((l) => l.componentId) } }, raw: true })) as any[];
    const byId = new Map(components.map((c) => [c.id, c]));
    return {
      structure,
      rules: lines.map((line) => {
        const component = byId.get(line.componentId);
        return {
          component,
          rule: this.ruleFromDto(
            {
              ...(line.calculationMethod ? { calculationMethod: line.calculationMethod } : {}),
              ...(line.value !== null && line.value !== undefined ? { value: line.value } : {}),
              ...(line.percentageBase ? { percentageBase: line.percentageBase } : {}),
              ...(line.baseComponents ? { baseComponents: line.baseComponents } : {}),
              ...(line.formula ? { formula: line.formula } : {}),
            },
            component,
          ),
        };
      }),
    };
  }

  private async saveStructureLines(tenantId: string, structureId: string, items: Record<string, any>[]) {
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const Line = await this.modelProvider.getSalaryStructureComponentModel(tenantId);
    if (!items?.length) this.bad('A structure needs at least one component.');
    const components = (await Component.findAll({ where: { tenantId, id: { [Op.in]: items.map((i) => i.componentId) } }, raw: true })) as any[];
    const byId = new Map(components.map((c) => [c.id, c]));
    const rules: (ComponentRule & { componentId: string })[] = [];
    for (const item of items) {
      const component = byId.get(item.componentId);
      if (!component) this.bad(`Component '${item.componentId}' not found.`);
      if (component.status !== 'ACTIVE') this.bad(`${component.name} is disabled and can’t be added.`);
      if (NOT_IN_COMPENSATION[component.category]) this.bad(`${component.name}: ${NOT_IN_COMPENSATION[component.category]}`);
      rules.push({ ...this.ruleFromDto(item, component), code: component.code, componentId: component.id });
    }
    // Amounts left for the employee (null) are checked as zero here: only
    // the shape — references, cycles, bases — must hold for a template.
    const check = resolveCompensation(rules.map((rule) => ({ ...rule, value: rule.value ?? 0 })));
    if (check.errors.length) this.bad(check.errors.join(' '));
    await Line.destroy({ where: { tenantId, structureId } });
    await Line.bulkCreate(
      items.map((item, index) => ({
        tenantId,
        structureId,
        componentId: item.componentId,
        calculationMethod: item.calculationMethod ?? null,
        value: item.value === undefined || item.value === '' ? null : item.value,
        percentageBase: item.percentageBase ?? null,
        baseComponents: item.baseComponents ?? null,
        formula: item.formula ?? null,
        sortOrder: index,
      })),
    );
    return rules.map((rule) => rule.code);
  }

  async createStructure(tenantId: string, dto: Record<string, any>) {
    this.require('compensation', 'manage', 'create salary structures');
    await this.ensureSystemComponents(tenantId);
    const code = String(dto.code ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) this.bad('The code must be 2–32 capital letters, digits or underscores.');
    if (!String(dto.name ?? '').trim()) this.bad('Give the structure a name.');
    const effectiveFrom = day(dto.effectiveFrom) ?? today();
    if (!isDate(effectiveFrom)) this.bad('Enter a valid effective date.');
    const Structure = await this.modelProvider.getSalaryStructureModel(tenantId);
    if (await Structure.findOne({ where: { tenantId, code } })) payrollError(`A structure with the code ${code} already exists.`, HttpStatus.CONFLICT);
    const actor = payrollActor();
    const row = await Structure.create({
      tenantId,
      code,
      name: String(dto.name).trim(),
      description: dto.description?.trim() || null,
      effectiveFrom,
      status: 'ACTIVE',
      createdByEmail: actor.email,
      updatedByEmail: actor.email,
    });
    let codes: string[];
    try {
      codes = await this.saveStructureLines(tenantId, row.id, dto.components ?? []);
    } catch (error) {
      await row.destroy();
      throw error;
    }
    await this.audit(tenantId, 'SalaryStructure', row.id, 'CREATE', {
      event: { from: null, to: 'STRUCTURE_CREATED' },
      code: { from: null, to: code },
      components: { from: null, to: codes },
    });
    return (await this.listStructures(tenantId)).find((s) => s.id === row.id);
  }

  /** Edits a structure. Employees already on it keep what they were assigned. */
  async updateStructure(tenantId: string, id: string, dto: Record<string, any>) {
    this.require('compensation', 'manage', 'edit salary structures');
    const Structure = await this.modelProvider.getSalaryStructureModel(tenantId);
    const row: any = await Structure.findOne({ where: { tenantId, id } });
    if (!row) this.notFound('Salary structure');
    const patch: Record<string, any> = { updatedByEmail: payrollActor().email };
    if (dto.name !== undefined) patch.name = String(dto.name).trim() || row.name;
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
    if (dto.effectiveFrom !== undefined) {
      if (!isDate(dto.effectiveFrom)) this.bad('Enter a valid effective date.');
      patch.effectiveFrom = day(dto.effectiveFrom);
    }
    if (dto.status !== undefined) {
      if (!['ACTIVE', 'INACTIVE'].includes(dto.status)) this.bad('Status is ACTIVE or INACTIVE.');
      patch.status = dto.status;
    }
    const codes = dto.components ? await this.saveStructureLines(tenantId, row.id, dto.components) : null;
    await row.update(patch);
    await this.audit(tenantId, 'SalaryStructure', row.id, 'UPDATE', {
      event: { from: null, to: 'STRUCTURE_UPDATED' },
      code: { from: null, to: row.code },
      fields: { from: null, to: Object.keys(dto).filter((k) => dto[k] !== undefined) },
      ...(codes ? { components: { from: null, to: codes } } : {}),
    });
    return (await this.listStructures(tenantId)).find((s) => s.id === row.id);
  }

  // ── Employee compensation ─────────────────────────────────────────────────

  /** A revision's components, or — saved before components — its three totals as components. */
  revisionLines(revision: any): CompensationLine[] {
    if (Array.isArray(revision?.components) && revision.components.length) return revision.components as CompensationLine[];
    return legacyCompensation({
      basicSalary: money(revision?.basicSalary),
      allowances: money(revision?.allowances),
      recurringDeductions: money(revision?.recurringDeductions),
    });
  }

  private compensationView(lines: CompensationLine[]) {
    const resolved = resolveCompensation(lines);
    return {
      lines: lines.map((line) => ({
        componentId: line.componentId,
        code: line.code,
        name: line.name,
        type: line.type,
        category: line.category,
        calculationMethod: line.calculationMethod,
        value: line.value,
        percentageBase: line.percentageBase,
        baseComponents: line.baseComponents ?? [],
        formula: line.formula,
        taxTreatment: line.taxTreatment,
        monthlyAmount: line.monthlyAmount,
        explanation: line.explanation,
      })),
      totals: resolved.totals,
    };
  }

  private async revisionsOf(tenantId: string, employeeId: string) {
    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    return (await Revision.findAll({ where: { tenantId, employeeId }, order: [['effectiveFrom', 'DESC']] })) as any[];
  }

  private inEffectOn(revisions: any[], date: string) {
    return revisions
      .filter((r) => String(r.effectiveFrom).slice(0, 10) <= date)
      .sort((a, b) => (String(a.effectiveFrom) < String(b.effectiveFrom) ? 1 : -1))[0];
  }

  private historyRow(revision: any) {
    const view = this.compensationView(this.revisionLines(revision));
    return {
      id: revision.id,
      effectiveFrom: String(revision.effectiveFrom).slice(0, 10),
      structureId: revision.structureId ?? null,
      structureName: revision.structureName ?? null,
      source: revision.source ?? (revision.components ? 'MANUAL' : 'SALARY_FORM'),
      reason: revision.reason ?? null,
      scheduled: String(revision.effectiveFrom).slice(0, 10) > today(),
      changedAt: revision.updatedAt ?? revision.createdAt,
      changedBy: revision.changedByEmail ?? null,
      ...view,
      previous: revision.previousComponents ? this.compensationView(revision.previousComponents).totals : null,
    };
  }

  /**
   * Every current employee with their compensation in effect today — for
   * payroll staff, under payroll grants (not the employee directory's).
   */
  async listEmployeeCompensation(tenantId: string) {
    this.require('compensation', 'view', 'view compensation');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const employees = (await Employee.findAll({
      where: { tenantId, status: { [Op.in]: ['ACTIVE', 'ON_LEAVE'] } },
      include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
      order: [['firstName', 'ASC']],
    })) as any[];
    const revisions = employees.length
      ? ((await Revision.findAll({ where: { tenantId, employeeId: { [Op.in]: employees.map((e) => e.id) } }, raw: true })) as any[])
      : [];
    const now = today();
    return employees.map((employee) => {
      const mine = revisions.filter((r) => r.employeeId === employee.id);
      const current = this.inEffectOn(mine, now);
      const scheduled = mine.filter((r) => String(r.effectiveFrom).slice(0, 10) > now).length;
      const totals = current
        ? resolveCompensation(this.revisionLines(current)).totals
        : { basic: money(employee.basicSalary), allowances: money(employee.allowances), gross: round2(money(employee.basicSalary) + money(employee.allowances)), deductions: money(employee.recurringDeductions), employerContributions: 0 };
      return {
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        name: nameOf(employee),
        department: employee.department?.name ?? null,
        joiningDate: day(employee.joiningDate),
        structureName: current?.structureName ?? null,
        effectiveFrom: current ? String(current.effectiveFrom).slice(0, 10) : null,
        revisions: mine.length,
        scheduled,
        totals,
      };
    });
  }

  /** An employee's compensation now, what is scheduled, and the history. */
  async getCompensation(tenantId: string, employeeId: string) {
    this.require('compensation', 'view', 'view compensation');
    const employee = await this.loadEmployee(tenantId, employeeId);
    const revisions = await this.revisionsOf(tenantId, employeeId);
    const now = today();
    const current = this.inEffectOn(revisions, now);
    const lines = current
      ? this.revisionLines(current)
      : legacyCompensation({ basicSalary: money(employee.basicSalary), allowances: money(employee.allowances), recurringDeductions: money(employee.recurringDeductions) });
    return {
      employeeId,
      current: {
        revisionId: current?.id ?? null,
        effectiveFrom: current ? String(current.effectiveFrom).slice(0, 10) : (employee.salaryEffectiveFrom ?? null),
        structureId: current?.structureId ?? null,
        structureName: current?.structureName ?? null,
        ...this.compensationView(lines),
      },
      history: revisions.map((revision) => this.historyRow(revision)),
    };
  }

  /**
   * Builds the lines a compensation save would store: from a structure
   * and/or explicit lines, each on a catalog component that is active on the
   * effective date. Returns the resolved lines, or the problems.
   */
  private async buildLines(tenantId: string, dto: { structureId?: string | null; lines?: Record<string, any>[]; effectiveFrom: string }) {
    await this.ensureSystemComponents(tenantId);
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const errors: string[] = [];
    const rules = new Map<string, ComponentRule & { componentId: string }>();
    let structure: any = null;
    if (dto.structureId) {
      const built = await this.structureRules(tenantId, dto.structureId);
      structure = built.structure;
      if (structure.status !== 'ACTIVE') errors.push(`The ${structure.name} structure is inactive.`);
      for (const { component, rule } of built.rules) if (component) rules.set(component.id, { ...rule, componentId: component.id });
    }
    const explicit = dto.lines ?? [];
    const components = explicit.length
      ? ((await Component.findAll({ where: { tenantId, id: { [Op.in]: explicit.map((l) => l.componentId) } }, raw: true })) as any[])
      : [];
    const byId = new Map(components.map((c) => [c.id, c]));
    for (const line of explicit) {
      const component = byId.get(line.componentId);
      if (!component) {
        errors.push(`Component '${line.componentId}' not found.`);
        continue;
      }
      const base = rules.get(component.id) ?? this.ruleFromDto({}, component);
      rules.set(component.id, { ...this.ruleFromDto(line, base), code: component.code, name: component.name, componentId: component.id });
    }
    const componentRows = (await Component.findAll({ where: { tenantId, id: { [Op.in]: [...rules.keys()] } }, raw: true })) as any[];
    for (const component of componentRows) {
      if (component.status !== 'ACTIVE') errors.push(`${component.name} is disabled — remove it or enable it first.`);
      else if (String(component.effectiveFrom).slice(0, 10) > dto.effectiveFrom || (component.effectiveTo && String(component.effectiveTo).slice(0, 10) < dto.effectiveFrom)) {
        errors.push(`${component.name} isn’t available on ${dto.effectiveFrom}.`);
      }
    }
    for (const rule of rules.values()) {
      if (rule.calculationMethod !== 'FORMULA' && (rule.value === null || rule.value === undefined)) {
        errors.push(`Enter ${rule.calculationMethod === 'PERCENTAGE' ? 'the percentage' : 'the amount'} for ${rule.name}.`);
      }
    }
    const resolved = resolveCompensation([...rules.values()]);
    return { structure, resolved, errors: [...errors, ...resolved.errors] };
  }

  /** The compensation a save would store, worked out — nothing is saved. */
  async previewCompensation(tenantId: string, employeeId: string, dto: Record<string, any>) {
    this.require('compensation', 'view', 'preview compensation');
    await this.loadEmployee(tenantId, employeeId);
    const effectiveFrom = day(dto.effectiveFrom) ?? today();
    const { resolved, errors } = await this.buildLines(tenantId, { structureId: dto.structureId, lines: dto.lines, effectiveFrom });
    return { ...this.compensationView(resolved.lines), errors };
  }

  /**
   * Saves an employee's compensation from a date: a new revision, or — same
   * date — a correction of that revision. Never back into a month whose
   * payroll is approved. The revision keeps the components as worked out
   * now, so later structure or component edits don't change it.
   */
  async saveCompensation(tenantId: string, employeeId: string, dto: Record<string, any>, options: { source?: string; skipAudit?: boolean } = {}) {
    this.require('compensation', 'manage', 'change compensation');
    const employee = await this.loadEmployee(tenantId, employeeId);
    const effectiveFrom = day(dto.effectiveFrom);
    if (!isDate(effectiveFrom)) this.bad('An effective date is required.');
    if (employee.joiningDate && effectiveFrom < String(employee.joiningDate).slice(0, 10)) {
      this.bad(`Compensation can’t take effect before the joining date (${String(employee.joiningDate).slice(0, 10)}).`);
    }
    await this.refuseLockedPeriod(tenantId, effectiveFrom, 'This compensation change');
    const { structure, resolved, errors } = await this.buildLines(tenantId, { structureId: dto.structureId, lines: dto.lines, effectiveFrom });
    if (errors.length) this.bad(errors.join(' '));
    if (resolved.totals.gross <= 0) this.bad('The compensation adds up to nothing — enter a basic salary.');

    const revisions = await this.revisionsOf(tenantId, employeeId);
    const existing = revisions.find((r) => String(r.effectiveFrom).slice(0, 10) === effectiveFrom);
    const dayBefore = new Date(`${effectiveFrom}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const previous = this.inEffectOn(revisions.filter((r) => r !== existing), dayBefore.toISOString().slice(0, 10));
    const previousLines = previous
      ? this.revisionLines(previous)
      : money(employee.basicSalary) + money(employee.allowances) > 0
        ? legacyCompensation({ basicSalary: money(employee.basicSalary), allowances: money(employee.allowances), recurringDeductions: money(employee.recurringDeductions) })
        : null;

    const actor = payrollActor();
    const totals = phase1Totals(resolved.lines);
    const values = {
      ...totals,
      structureId: structure?.id ?? null,
      structureName: structure?.name ?? null,
      components: resolved.lines,
      previousComponents: previousLines,
      source: options.source ?? (structure ? 'STRUCTURE' : 'MANUAL'),
      reason: String(dto.reason ?? '').trim() || null,
      changedByUserId: actor.userId,
      changedByEmail: actor.email,
    };
    const Revision = await this.modelProvider.getSalaryRevisionModel(tenantId);
    const saved: any = existing ? await existing.update(values) : await Revision.create({ tenantId, employeeId, effectiveFrom, ...values });
    await this.mirrorEmployee(tenantId, employee);

    if (!options.skipAudit) {
      const before = new Set((previousLines ?? []).map((l) => l.code));
      const after = new Set(resolved.lines.map((l) => l.code));
      await this.audit(tenantId, 'EmployeeCompensation', employeeId, existing ? 'UPDATE' : 'CREATE', {
        event: { from: null, to: structure && !previous?.structureId ? 'COMPENSATION_ASSIGNED' : existing ? 'COMPENSATION_CORRECTED' : 'SALARY_REVISED' },
        employeeId: { from: null, to: employeeId },
        effectiveFrom: { from: null, to: effectiveFrom },
        structure: { from: previous?.structureName ?? null, to: structure?.name ?? null },
        // Which components — not what they pay.
        components: { from: [...before], to: [...after] },
        ...(values.reason ? { reason: { from: null, to: values.reason } } : {}),
      });
    }

    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const openRun: any = await Run.findOne({
      where: { tenantId, step: PayrollProcessStep.REVIEW, periodEnd: { [Op.gte]: effectiveFrom } },
      order: [['periodEnd', 'ASC']],
    });
    return {
      revision: this.historyRow(saved),
      openRun: openRun
        ? { id: openRun.id, periodLabel: new Date(`${String(openRun.periodStart).slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
        : null,
    };
  }

  /** The employee row keeps Phase 1's figures in step with what is in effect today. */
  private async mirrorEmployee(tenantId: string, employee: any) {
    const revisions = await this.revisionsOf(tenantId, employee.id);
    const inEffect = this.inEffectOn(revisions, today());
    if (!inEffect) return;
    await employee.update({
      basicSalary: money(inEffect.basicSalary),
      allowances: money(inEffect.allowances),
      recurringDeductions: money(inEffect.recurringDeductions),
      salaryEffectiveFrom: String(inEffect.effectiveFrom).slice(0, 10),
    });
  }

  // ── Recurring earnings & deductions ───────────────────────────────────────

  /** Amounts taken for each source on payroll lines, leaving out one run. */
  private async takenBySource(tenantId: string, employeeIds: string[], excludeRunId?: string, sources: string[] = ['RECURRING', 'LOAN', 'ADVANCE']) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const taken = new Map<string, { total: number; locked: number }>();
    if (!employeeIds.length) return taken;
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const records = (await Record.findAll({
      where: { tenantId, employeeId: { [Op.in]: employeeIds }, ...(excludeRunId ? { payrollRunId: { [Op.ne]: excludeRunId } } : {}) },
      attributes: ['payrollRunId', 'employeeId', 'components'],
      raw: true,
    })) as any[];
    const runIds = [...new Set(records.map((r) => r.payrollRunId))];
    const runs = runIds.length ? ((await Run.findAll({ where: { tenantId, id: { [Op.in]: runIds } }, attributes: ['id', 'step'], raw: true })) as any[]) : [];
    const lockedRuns = new Set(runs.filter((run) => LOCKED_STEPS.includes(run.step)).map((run) => run.id));
    for (const record of records) {
      for (const line of record.components?.deductions ?? []) {
        if (!line.sourceId || !sources.includes(line.source)) continue;
        const entry = taken.get(line.sourceId) ?? { total: 0, locked: 0 };
        entry.total = round2(entry.total + money(line.amount));
        if (lockedRuns.has(record.payrollRunId)) entry.locked = round2(entry.locked + money(line.amount));
        taken.set(line.sourceId, entry);
      }
    }
    return taken;
  }

  private recurringRow(row: any, taken?: { total: number; locked: number }) {
    const total = row.totalAmount === null || row.totalAmount === undefined ? null : money(row.totalAmount);
    const end = day(row.endDate);
    return {
      id: row.id,
      employeeId: row.employeeId,
      kind: row.kind,
      name: row.name,
      category: row.category,
      calculationMethod: row.calculationMethod,
      amount: Number(row.amount),
      percentageBase: row.percentageBase ?? null,
      frequency: row.frequency,
      startDate: day(row.startDate),
      endDate: end,
      totalAmount: total,
      taken: taken?.locked ?? 0,
      remaining: total === null ? null : round2(Math.max(0, total - (taken?.locked ?? 0))),
      taxTreatment: row.taxTreatment,
      status: row.status === 'ACTIVE' && end && end < today() ? 'ENDED' : row.status,
      reason: row.reason ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async listRecurringItems(tenantId: string, employeeId: string) {
    this.require('compensation', 'view', 'view recurring earnings and deductions');
    await this.loadEmployee(tenantId, employeeId);
    const Item = await this.modelProvider.getEmployeeRecurringItemModel(tenantId);
    const rows = (await Item.findAll({ where: { tenantId, employeeId }, order: [['startDate', 'DESC']] })) as any[];
    const taken = await this.takenBySource(tenantId, [employeeId], undefined, ['RECURRING']);
    return rows.map((row) => this.recurringRow(row, taken.get(row.id)));
  }

  private validateRecurring(dto: Record<string, any>) {
    const errors: string[] = [];
    if (!['EARNING', 'DEDUCTION'].includes(dto.kind)) errors.push('Choose earning or deduction.');
    const categories = dto.kind === 'EARNING' ? RECURRING_EARNING_CATEGORIES : RECURRING_DEDUCTION_CATEGORIES;
    if (!categories.includes(dto.category)) errors.push(`Choose a category: ${categories.join(', ')}.`);
    if (!String(dto.name ?? '').trim()) errors.push('Give it a name.');
    if (!['FIXED', 'PERCENTAGE'].includes(dto.calculationMethod ?? 'FIXED')) errors.push('Choose fixed amount or percentage.');
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push('Enter an amount greater than zero.');
    if (dto.calculationMethod === 'PERCENTAGE' && !['BASIC', 'GROSS'].includes(dto.percentageBase)) errors.push('A percentage needs a base: Basic or Gross.');
    if (!['MONTHLY', 'ONE_TIME'].includes(dto.frequency ?? 'MONTHLY')) errors.push('Frequency is monthly or one-time.');
    if (!isDate(dto.startDate)) errors.push('A start date is required.');
    if (dto.endDate && (!isDate(dto.endDate) || dto.endDate < dto.startDate)) errors.push('The end date can’t be before the start date.');
    if (dto.totalAmount !== undefined && dto.totalAmount !== null) {
      if (dto.kind !== 'DEDUCTION') errors.push('Only a deduction can have a total.');
      else if (!(Number(dto.totalAmount) > 0)) errors.push('The total must be greater than zero.');
    }
    if (dto.taxTreatment && !['TAXABLE', 'NON_TAXABLE', 'RULE_DEPENDENT'].includes(dto.taxTreatment)) errors.push('Choose a tax treatment.');
    if (errors.length) this.bad(errors.join(' '));
  }

  async createRecurringItem(tenantId: string, employeeId: string, dto: Record<string, any>) {
    this.require('compensation', 'manage', 'add recurring earnings and deductions');
    const employee = await this.loadEmployee(tenantId, employeeId);
    this.validateRecurring(dto);
    if (employee.joiningDate && dto.startDate < String(employee.joiningDate).slice(0, 10)) this.bad('It can’t start before the joining date.');
    await this.refuseLockedPeriod(tenantId, dto.startDate, 'This item');
    const Item = await this.modelProvider.getEmployeeRecurringItemModel(tenantId);
    const actor = payrollActor();
    const row = await Item.create({
      tenantId,
      employeeId,
      kind: dto.kind,
      name: String(dto.name).trim(),
      category: dto.category,
      calculationMethod: dto.calculationMethod ?? 'FIXED',
      amount: Number(dto.amount),
      percentageBase: dto.calculationMethod === 'PERCENTAGE' ? dto.percentageBase : null,
      frequency: dto.frequency ?? 'MONTHLY',
      startDate: dto.startDate,
      endDate: dto.endDate || null,
      totalAmount: dto.kind === 'DEDUCTION' && dto.totalAmount ? Number(dto.totalAmount) : null,
      taxTreatment: dto.kind === 'EARNING' ? (dto.taxTreatment ?? 'RULE_DEPENDENT') : 'RULE_DEPENDENT',
      status: 'ACTIVE',
      reason: String(dto.reason ?? '').trim() || null,
      createdByEmail: actor.email,
      updatedByEmail: actor.email,
    });
    await this.audit(tenantId, 'EmployeeRecurringItem', row.id, 'CREATE', {
      event: { from: null, to: dto.kind === 'EARNING' ? 'RECURRING_EARNING_ADDED' : 'RECURRING_DEDUCTION_ADDED' },
      employeeId: { from: null, to: employeeId },
      name: { from: null, to: row.name },
      startDate: { from: null, to: dto.startDate },
      ...(row.reason ? { reason: { from: null, to: row.reason } } : {}),
    });
    return this.recurringRow(row);
  }

  /**
   * Changes a recurring item for payroll calculated from now on. Payroll
   * already approved keeps what it paid or took.
   */
  async updateRecurringItem(tenantId: string, id: string, dto: Record<string, any>) {
    this.require('compensation', 'manage', 'change recurring earnings and deductions');
    const Item = await this.modelProvider.getEmployeeRecurringItemModel(tenantId);
    const row: any = await Item.findOne({ where: { tenantId, id } });
    if (!row) this.notFound('Recurring item');
    const merged = {
      kind: row.kind,
      name: dto.name ?? row.name,
      category: dto.category ?? row.category,
      calculationMethod: dto.calculationMethod ?? row.calculationMethod,
      amount: dto.amount ?? Number(row.amount),
      percentageBase: dto.percentageBase ?? row.percentageBase,
      frequency: dto.frequency ?? row.frequency,
      startDate: dto.startDate ?? day(row.startDate),
      endDate: dto.endDate !== undefined ? dto.endDate || null : day(row.endDate),
      totalAmount: dto.totalAmount !== undefined ? dto.totalAmount : row.totalAmount === null ? null : Number(row.totalAmount),
      taxTreatment: dto.taxTreatment ?? row.taxTreatment,
    };
    this.validateRecurring(merged);
    if (dto.status !== undefined && !['ACTIVE', 'STOPPED'].includes(dto.status)) this.bad('Status is ACTIVE or STOPPED.');
    if (dto.startDate && dto.startDate !== day(row.startDate)) await this.refuseLockedPeriod(tenantId, dto.startDate, 'This item');
    const changed = Object.keys(dto).filter((key) => dto[key] !== undefined && key !== 'reason');
    await row.update({
      ...merged,
      totalAmount: merged.kind === 'DEDUCTION' ? merged.totalAmount : null,
      percentageBase: merged.calculationMethod === 'PERCENTAGE' ? merged.percentageBase : null,
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.reason !== undefined ? { reason: String(dto.reason ?? '').trim() || null } : {}),
      updatedByEmail: payrollActor().email,
    });
    await this.audit(tenantId, 'EmployeeRecurringItem', row.id, 'UPDATE', {
      event: { from: null, to: dto.status === 'STOPPED' ? 'RECURRING_ITEM_STOPPED' : 'RECURRING_ITEM_UPDATED' },
      employeeId: { from: null, to: row.employeeId },
      fields: { from: null, to: changed },
      ...(dto.reason ? { reason: { from: null, to: dto.reason } } : {}),
    });
    const taken = await this.takenBySource(tenantId, [row.employeeId], undefined, ['RECURRING']);
    return this.recurringRow(row, taken.get(row.id));
  }

  // ── Loans & advances ──────────────────────────────────────────────────────

  private loanRow(row: any, taken?: { total: number; locked: number }, employee?: any) {
    const principal = money(row.principal);
    const recovered = taken?.locked ?? 0;
    const remaining = round2(Math.max(0, principal - recovered));
    return {
      id: row.id,
      employeeId: row.employeeId,
      employee: employee ? { id: employee.id, name: nameOf(employee), employeeCode: employee.employeeCode } : undefined,
      kind: row.kind,
      principal,
      installmentAmount: money(row.installmentAmount),
      installments: row.installments ?? null,
      issuedOn: day(row.issuedOn),
      startDate: day(row.startDate),
      recovered,
      /** Instalments on payroll still in Review. */
      scheduled: round2((taken?.total ?? 0) - recovered),
      remaining,
      installmentsLeft: money(row.installmentAmount) > 0 ? Math.ceil(remaining / money(row.installmentAmount)) : null,
      status: row.status === 'ACTIVE' && remaining <= 0 ? 'COMPLETED' : row.status,
      reason: row.reason ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async listLoans(tenantId: string, filters: { employeeId?: string; kind?: string; status?: string } = {}) {
    this.require('loans', 'view', 'view loans and advances');
    const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Loan.findAll({
      where: { tenantId, ...(filters.employeeId ? { employeeId: filters.employeeId } : {}), ...(filters.kind ? { kind: filters.kind } : {}) },
      order: [['issuedOn', 'DESC']],
    })) as any[];
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const [taken, employees] = await Promise.all([
      this.takenBySource(tenantId, employeeIds, undefined, ['LOAN', 'ADVANCE']),
      employeeIds.length ? Employee.findAll({ where: { tenantId, id: { [Op.in]: employeeIds } }, raw: true }) : Promise.resolve([]),
    ]);
    const byId = new Map((employees as any[]).map((e) => [e.id, e]));
    const list = rows.map((row) => this.loanRow(row, taken.get(row.id), byId.get(row.employeeId)));
    return filters.status ? list.filter((loan) => loan.status === filters.status) : list;
  }

  private validateLoan(dto: Record<string, any>) {
    const errors: string[] = [];
    if (!['LOAN', 'ADVANCE'].includes(dto.kind)) errors.push('Choose loan or advance.');
    const principal = Number(dto.principal);
    if (!(principal > 0)) errors.push('Enter the amount given.');
    const installment = Number(dto.installmentAmount);
    if (!(installment > 0)) errors.push('Enter the amount recovered each month.');
    else if (installment > principal) errors.push('The monthly recovery can’t be more than the amount given.');
    if (!isDate(dto.issuedOn)) errors.push('Enter the date it was given.');
    if (!isDate(dto.startDate)) errors.push('Enter the first recovery month.');
    if (errors.length) this.bad(errors.join(' '));
  }

  async createLoan(tenantId: string, dto: Record<string, any>) {
    this.require('loans', 'manage', 'record loans and advances');
    await this.loadEmployee(tenantId, dto.employeeId);
    // Instalment count → amount, when only the count is given.
    const principal = Number(dto.principal);
    const installmentAmount =
      dto.installmentAmount !== undefined && dto.installmentAmount !== null && dto.installmentAmount !== ''
        ? Number(dto.installmentAmount)
        : dto.installments
          ? round2(principal / Number(dto.installments))
          : dto.kind === 'ADVANCE'
            ? principal
            : NaN;
    const values = { ...dto, installmentAmount, startDate: dto.startDate ?? dto.issuedOn };
    this.validateLoan(values);
    await this.refuseLockedPeriod(tenantId, lastDayOf(monthOf(values.startDate)), 'Recovery');
    const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
    const actor = payrollActor();
    const row = await Loan.create({
      tenantId,
      employeeId: dto.employeeId,
      kind: dto.kind,
      principal,
      installmentAmount,
      installments: dto.kind === 'LOAN' ? Math.ceil(principal / installmentAmount) : null,
      issuedOn: dto.issuedOn,
      startDate: `${monthOf(values.startDate)}-01`,
      status: 'ACTIVE',
      reason: String(dto.reason ?? '').trim() || null,
      createdByEmail: actor.email,
      updatedByEmail: actor.email,
    });
    await this.audit(tenantId, 'EmployeeLoan', row.id, 'CREATE', {
      event: { from: null, to: dto.kind === 'LOAN' ? 'LOAN_CREATED' : 'ADVANCE_CREATED' },
      employeeId: { from: null, to: dto.employeeId },
      firstRecovery: { from: null, to: monthOf(values.startDate) },
      ...(row.reason ? { reason: { from: null, to: row.reason } } : {}),
    });
    return this.loanRow(row);
  }

  /** Future recovery only: payroll already calculated keeps its instalment. */
  async updateLoan(tenantId: string, id: string, dto: Record<string, any>) {
    this.require('loans', 'manage', 'change loans and advances');
    const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
    const row: any = await Loan.findOne({ where: { tenantId, id } });
    if (!row) this.notFound('Loan or advance');
    const taken = (await this.takenBySource(tenantId, [row.employeeId], undefined, ['LOAN', 'ADVANCE'])).get(row.id);
    const merged = {
      kind: row.kind,
      principal: dto.principal ?? money(row.principal),
      installmentAmount: dto.installmentAmount ?? money(row.installmentAmount),
      issuedOn: dto.issuedOn ?? day(row.issuedOn),
      startDate: dto.startDate ?? day(row.startDate),
    };
    this.validateLoan(merged);
    if (Number(merged.principal) < (taken?.total ?? 0)) this.bad(`${(taken?.total ?? 0).toLocaleString('en-US')} has already been recovered — the amount can’t be less than that.`);
    if (dto.status !== undefined && !['ACTIVE', 'ON_HOLD', 'CANCELLED'].includes(dto.status)) this.bad('Status is ACTIVE, ON_HOLD or CANCELLED.');
    if (dto.startDate && dto.startDate !== day(row.startDate)) await this.refuseLockedPeriod(tenantId, lastDayOf(monthOf(dto.startDate)), 'Recovery');
    const changed = Object.keys(dto).filter((key) => dto[key] !== undefined && key !== 'reason');
    await row.update({
      principal: merged.principal,
      installmentAmount: merged.installmentAmount,
      issuedOn: merged.issuedOn,
      startDate: `${monthOf(merged.startDate)}-01`,
      installments: row.kind === 'LOAN' ? Math.ceil(Number(merged.principal) / Number(merged.installmentAmount)) : null,
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.reason !== undefined ? { reason: String(dto.reason ?? '').trim() || null } : {}),
      updatedByEmail: payrollActor().email,
    });
    await this.audit(tenantId, 'EmployeeLoan', row.id, 'UPDATE', {
      event: { from: null, to: row.kind === 'LOAN' ? 'LOAN_UPDATED' : 'ADVANCE_UPDATED' },
      employeeId: { from: null, to: row.employeeId },
      fields: { from: null, to: changed },
      ...(dto.reason ? { reason: { from: null, to: dto.reason } } : {}),
    });
    return this.loanRow(row, taken);
  }

  // ── Reimbursements ────────────────────────────────────────────────────────

  private reimbursementRow(row: any, employee?: any) {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employee: employee ? { id: employee.id, name: nameOf(employee), employeeCode: employee.employeeCode } : undefined,
      amount: money(row.amount),
      category: row.category,
      expenseDate: day(row.expenseDate),
      description: row.description,
      document: row.fileId ? { fileId: row.fileId, fileName: row.fileName, mimeType: row.mimeType ?? null } : null,
      status: row.status,
      payrollPeriod: row.payrollPeriod ?? null,
      payrollRunId: row.payrollRunId ?? null,
      submittedBy: row.submittedByEmail ?? null,
      decidedBy: row.decidedByEmail ?? null,
      decidedAt: row.decidedAt ?? null,
      decisionNote: row.decisionNote ?? null,
      createdAt: row.createdAt,
    };
  }

  private validateReimbursement(dto: Record<string, any>) {
    const errors: string[] = [];
    if (!(Number(dto.amount) > 0)) errors.push('Enter the amount.');
    if (!String(dto.category ?? '').trim()) errors.push('Choose a category.');
    if (!isDate(dto.expenseDate)) errors.push('Enter the expense date.');
    else if (dto.expenseDate > today()) errors.push('The expense date can’t be in the future.');
    if (String(dto.description ?? '').trim().length < 3) errors.push('Describe the expense.');
    if (dto.payrollPeriod && !/^\d{4}-(0[1-9]|1[0-2])$/.test(dto.payrollPeriod)) errors.push('The payroll period is YYYY-MM.');
    if (errors.length) this.bad(errors.join(' '));
  }

  private async createReimbursementRow(tenantId: string, employeeId: string, dto: Record<string, any>) {
    this.validateReimbursement(dto);
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const row = await Reimbursement.create({
      tenantId,
      employeeId,
      amount: round2(Number(dto.amount)),
      category: String(dto.category).trim().toUpperCase().slice(0, 40),
      expenseDate: dto.expenseDate,
      description: String(dto.description).trim(),
      fileId: dto.fileId ?? null,
      fileName: dto.fileName ?? null,
      mimeType: dto.mimeType ?? null,
      status: 'SUBMITTED',
      payrollPeriod: dto.payrollPeriod ?? null,
      submittedByEmail: payrollActor().email,
    });
    await this.audit(tenantId, 'Reimbursement', row.id, 'CREATE', {
      event: { from: null, to: 'REIMBURSEMENT_SUBMITTED' },
      employeeId: { from: null, to: employeeId },
      category: { from: null, to: row.category },
    });
    return row;
  }

  async listReimbursements(tenantId: string, filters: { status?: string; employeeId?: string } = {}) {
    this.require('adjustments', 'view', 'view reimbursements');
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Reimbursement.findAll({
      where: { tenantId, ...(filters.status ? { status: filters.status } : {}), ...(filters.employeeId ? { employeeId: filters.employeeId } : {}) },
      order: [['createdAt', 'DESC']],
    })) as any[];
    const ids = [...new Set(rows.map((r) => r.employeeId))];
    const employees = ids.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, raw: true })) as any[]) : [];
    const byId = new Map(employees.map((e) => [e.id, e]));
    return rows.map((row) => this.reimbursementRow(row, byId.get(row.employeeId)));
  }

  /** Payroll staff recording a claim for an employee. */
  async createReimbursement(tenantId: string, dto: Record<string, any>) {
    this.require('adjustments', 'manage', 'record reimbursements');
    await this.loadEmployee(tenantId, dto.employeeId);
    return this.reimbursementRow(await this.createReimbursementRow(tenantId, dto.employeeId, dto));
  }

  /**
   * Approve or reject a submitted claim. Approved claims are paid in the
   * next payroll calculated for their period.
   */
  async decideReimbursement(tenantId: string, id: string, dto: { decision: 'APPROVE' | 'REJECT'; note?: string; payrollPeriod?: string | null }) {
    this.require('adjustments', 'manage', 'approve reimbursements');
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const row: any = await Reimbursement.findOne({ where: { tenantId, id } });
    if (!row) this.notFound('Reimbursement');
    if (row.status !== 'SUBMITTED') this.bad(`This claim is ${row.status.toLowerCase()} — only a submitted claim can be decided.`);
    if (dto.decision === 'REJECT' && String(dto.note ?? '').trim().length < 3) this.bad('Say why the claim is rejected.');
    if (dto.payrollPeriod && !/^\d{4}-(0[1-9]|1[0-2])$/.test(dto.payrollPeriod)) this.bad('The payroll period is YYYY-MM.');
    const actor = payrollActor();
    const status = dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await row.update({
      status,
      decidedByEmail: actor.email,
      decidedAt: new Date(),
      decisionNote: String(dto.note ?? '').trim() || null,
      ...(dto.payrollPeriod !== undefined ? { payrollPeriod: dto.payrollPeriod || null } : {}),
    });
    await this.audit(tenantId, 'Reimbursement', row.id, 'UPDATE', {
      event: { from: null, to: status === 'APPROVED' ? 'REIMBURSEMENT_APPROVED' : 'REIMBURSEMENT_REJECTED' },
      employeeId: { from: null, to: row.employeeId },
      status: { from: 'SUBMITTED', to: status },
      ...(row.decisionNote ? { reason: { from: null, to: row.decisionNote } } : {}),
    });
    return this.reimbursementRow(row);
  }

  // ── What payroll needs ────────────────────────────────────────────────────

  /**
   * Recurring items, due instalments and approved reimbursements for a
   * period. Balances leave out `runId` (the run being calculated), so
   * recalculating never counts its own instalments twice.
   */
  async contextForPeriod(tenantId: string, periodStart: string, periodEnd: string, employeeIds: string[], runId?: string): Promise<CompensationContext> {
    const Item = await this.modelProvider.getEmployeeRecurringItemModel(tenantId);
    const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const month = monthOf(periodStart);
    const [items, loans, claims] = employeeIds.length
      ? await Promise.all([
          Item.findAll({
            where: {
              tenantId,
              employeeId: { [Op.in]: employeeIds },
              status: 'ACTIVE',
              startDate: { [Op.lte]: periodEnd },
              [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: periodStart } }],
            } as any,
            raw: true,
          }),
          Loan.findAll({ where: { tenantId, employeeId: { [Op.in]: employeeIds }, status: 'ACTIVE', startDate: { [Op.lte]: periodEnd } }, raw: true }),
          Reimbursement.findAll({ where: { tenantId, employeeId: { [Op.in]: employeeIds }, status: 'APPROVED' }, raw: true }),
        ])
      : [[], [], []];
    const needBalance = [...new Set([...(items as any[]).filter((i) => i.totalAmount !== null).map((i) => i.employeeId), ...(loans as any[]).map((l) => l.employeeId)])];
    const taken = await this.takenBySource(tenantId, needBalance, runId);
    const group = <T extends { employeeId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
      return map;
    };
    const itemsOf = group(items as any[]);
    const loansOf = group(loans as any[]);
    const claimsOf = group(
      (claims as any[]).filter(
        (c) => (!c.payrollRunId || c.payrollRunId === runId) && (!c.payrollPeriod || c.payrollPeriod <= month) && String(c.expenseDate).slice(0, 10) <= periodEnd,
      ),
    );
    const Policy = await this.modelProvider.getOrganizationPolicyModel(tenantId).catch(() => null);
    let overtimeBase: 'BASIC' | 'COMPONENTS' = 'BASIC';
    try {
      const policy: any = await Policy?.findOne({ where: { tenantId, policyType: 'PAYROLL', status: 'ACTIVE' }, order: [['updatedAt', 'DESC']] });
      if (policy?.configuration?.overtimeBase === 'COMPONENTS') overtimeBase = 'COMPONENTS';
    } catch {
      // The Phase 1 default.
    }
    return {
      overtimeBase,
      recurringOf: (employeeId) =>
        (itemsOf.get(employeeId) ?? []).map((item: any) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          category: item.category,
          calculationMethod: item.calculationMethod,
          amount: Number(item.amount),
          percentageBase: item.percentageBase ?? null,
          startDate: String(item.startDate).slice(0, 10),
          endDate: item.endDate ? String(item.endDate).slice(0, 10) : null,
          frequency: item.frequency,
          remaining: item.totalAmount === null || item.totalAmount === undefined ? null : round2(Math.max(0, money(item.totalAmount) - (taken.get(item.id)?.total ?? 0))),
          taxTreatment: item.taxTreatment as TaxTreatment,
        })),
      recoveriesOf: (employeeId) =>
        (loansOf.get(employeeId) ?? [])
          .map((loan: any) => ({
            id: loan.id,
            kind: loan.kind,
            name: loan.kind === 'LOAN' ? 'Loan Recovery' : 'Advance Recovery',
            installment: money(loan.installmentAmount),
            remaining: round2(Math.max(0, money(loan.principal) - (taken.get(loan.id)?.total ?? 0))),
          }))
          .filter((recovery) => recovery.remaining > 0),
      reimbursementsOf: (employeeId) =>
        (claimsOf.get(employeeId) ?? []).map((claim: any) => ({ id: claim.id, amount: money(claim.amount), category: claim.category, description: claim.description })),
    };
  }

  /** After a run's lines are saved: each approved claim points at the line paying it. */
  async linkReimbursements(tenantId: string, runId: string, links: { reimbursementId: string; recordId: string }[]) {
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    // Unlink everything this run held, then link what it pays now.
    await Reimbursement.update({ payrollRunId: null, payrollRecordId: null }, { where: { tenantId, payrollRunId: runId, status: 'APPROVED' } });
    for (const link of links) {
      await Reimbursement.update({ payrollRunId: runId, payrollRecordId: link.recordId }, { where: { tenantId, id: link.reimbursementId, status: 'APPROVED' } });
    }
  }

  /** A run was approved: its claims are now paid through payroll. */
  async onRunLocked(tenantId: string, runId: string) {
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    await Reimbursement.update({ status: 'INCLUDED' }, { where: { tenantId, payrollRunId: runId, status: 'APPROVED' } });
  }

  // ── Import ────────────────────────────────────────────────────────────────

  /**
   * Bulk compensation from CSV: Employee ID, Component, Amount, Effective
   * Date. Every row is checked first; nothing is saved unless every row is
   * valid and `apply` is set. Rows for the same employee and date become one
   * revision, starting from what is in effect on that date.
   */
  async importCompensation(tenantId: string, dto: { csv: string; apply?: boolean }) {
    this.require('compensation', 'manage', 'import compensation');
    await this.ensureSystemComponents(tenantId);
    const rows = parseCsv(String(dto.csv ?? ''));
    if (rows.length < 2) this.bad('The file needs a header row and at least one data row.');
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));
    const cEmployee = col(['employeeid', 'employeecode', 'employee']);
    const cComponent = col(['component', 'componentcode', 'code']);
    const cAmount = col(['amount', 'value']);
    const cDate = col(['effectivedate', 'effectivefrom', 'date']);
    if ([cEmployee, cComponent, cAmount, cDate].some((i) => i < 0)) this.bad('The header must have: Employee ID, Component, Amount, Effective Date.');
    if (rows.length > 5001) this.bad('Import up to 5,000 rows at a time.');

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Component = await this.modelProvider.getPayrollComponentModel(tenantId);
    const [employees, components] = await Promise.all([Employee.findAll({ where: { tenantId }, raw: true }), Component.findAll({ where: { tenantId }, raw: true })]);
    const employeeByCode = new Map((employees as any[]).map((e) => [String(e.employeeCode).trim().toUpperCase(), e]));
    const componentByCode = new Map((components as any[]).map((c) => [String(c.code).toUpperCase(), c]));

    type Row = { line: number; employeeCode: string; component: string; amount: string; effectiveDate: string; errors: string[]; warnings: string[] };
    const checked: Row[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.every((cell) => !cell.trim())) continue;
      const row: Row = {
        line: i + 1,
        employeeCode: (cells[cEmployee] ?? '').trim(),
        component: (cells[cComponent] ?? '').trim().toUpperCase(),
        amount: (cells[cAmount] ?? '').trim(),
        effectiveDate: (cells[cDate] ?? '').trim(),
        errors: [],
        warnings: [],
      };
      const employee = employeeByCode.get(row.employeeCode.toUpperCase());
      const component = componentByCode.get(row.component);
      if (!employee) row.errors.push(`No employee with ID ${row.employeeCode || '(blank)'}.`);
      if (!component) row.errors.push(`No component with code ${row.component || '(blank)'}.`);
      else if (component.status !== 'ACTIVE') row.errors.push(`${component.name} is disabled.`);
      else if (NOT_IN_COMPENSATION[component.category]) row.errors.push(NOT_IN_COMPENSATION[component.category]);
      else if (component.calculationMethod === 'FORMULA') row.errors.push(`${component.name} is worked out by formula — it has no amount to import.`);
      const amount = Number(row.amount.replace(/,/g, ''));
      if (!row.amount || !Number.isFinite(amount) || amount < 0) row.errors.push('The amount must be a number, zero or more.');
      if (!isDate(row.effectiveDate)) row.errors.push('The effective date must be YYYY-MM-DD.');
      else {
        if (employee?.joiningDate && row.effectiveDate < String(employee.joiningDate).slice(0, 10)) row.errors.push('Before the joining date.');
        if (row.effectiveDate > today()) row.warnings.push('A future date — scheduled, not yet in effect.');
      }
      const key = `${row.employeeCode.toUpperCase()}|${row.component}|${row.effectiveDate}`;
      if (seen.has(key)) row.errors.push('The same employee, component and date appear twice.');
      seen.add(key);
      checked.push(row);
    }

    // Group by employee and date, and check each group as the revision it would be.
    const groups = new Map<string, Row[]>();
    for (const row of checked) {
      const key = `${row.employeeCode.toUpperCase()}|${row.effectiveDate}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const plans: { employee: any; effectiveFrom: string; lines: Record<string, any>[]; structureId: string | null; rows: Row[] }[] = [];
    for (const group of groups.values()) {
      if (group.some((row) => row.errors.length)) continue;
      const employee = employeeByCode.get(group[0].employeeCode.toUpperCase());
      const effectiveFrom = group[0].effectiveDate;
      const locked = await this.lockedPayrollOn(tenantId, effectiveFrom);
      if (locked) {
        group.forEach((row) => row.errors.push('That month’s payroll is already approved.'));
        continue;
      }
      const revisions = await this.revisionsOf(tenantId, employee.id);
      const base = this.inEffectOn(revisions, effectiveFrom);
      const baseLines: CompensationLine[] = base ? this.revisionLines(base) : [];
      if (!base) group.forEach((row) => row.warnings.push('No compensation before this date — only the imported components will be on it.'));
      const lines = new Map<string, Record<string, any>>();
      for (const line of baseLines) {
        const component = line.componentId ? (components as any[]).find((c) => c.id === line.componentId) : componentByCode.get(line.code);
        if (component) lines.set(component.id, { componentId: component.id, calculationMethod: line.calculationMethod, value: line.value, percentageBase: line.percentageBase, baseComponents: line.baseComponents, formula: line.formula });
        else group[0].warnings.push(`${line.name} isn’t a catalog component and will be dropped.`);
      }
      for (const row of group) {
        const component = componentByCode.get(row.component)!;
        lines.set(component.id, { ...(lines.get(component.id) ?? { componentId: component.id }), value: Number(row.amount.replace(/,/g, '')) });
      }
      const { resolved, errors } = await this.buildLines(tenantId, { structureId: null, lines: [...lines.values()], effectiveFrom });
      if (errors.length) group.forEach((row) => row.errors.push(...errors));
      else if (resolved.totals.gross <= 0) group.forEach((row) => row.errors.push('The compensation would add up to nothing.'));
      else plans.push({ employee, effectiveFrom, lines: [...lines.values()], structureId: base?.structureId ?? null, rows: group });
    }

    const invalid = checked.filter((row) => row.errors.length).length;
    let applied = 0;
    if (dto.apply) {
      if (invalid) this.bad(`${invalid} row(s) have errors — nothing was imported. Fix them and try again.`);
      for (const plan of plans) {
        // structureId stays a reference only: the lines are explicit.
        await this.saveCompensation(tenantId, plan.employee.id, { effectiveFrom: plan.effectiveFrom, lines: plan.lines, reason: 'Compensation import' }, { source: 'IMPORT', skipAudit: true });
        applied++;
      }
      await this.audit(tenantId, 'CompensationImport', tenantId, 'CREATE', {
        event: { from: null, to: 'COMPENSATION_IMPORTED' },
        rows: { from: null, to: checked.length },
        revisions: { from: null, to: applied },
        employees: { from: null, to: [...new Set(plans.map((p) => p.employee.id))] },
      });
    }
    return {
      rows: checked,
      valid: checked.length - invalid,
      invalid,
      warnings: checked.reduce((sum, row) => sum + row.warnings.length, 0),
      revisions: plans.length,
      applied,
    };
  }

  // ── The employee's own ────────────────────────────────────────────────────

  private async me(tenantId: string, userId: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee = await Employee.findOne({ where: { tenantId, userId } });
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } as any });
    if (!employee) payrollError('No employee profile is linked to this login.', HttpStatus.NOT_FOUND);
    return employee as any;
  }

  /** My compensation, history, recurring items, loans and reimbursements — mine only. */
  async myCompensation(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const revisions = await this.revisionsOf(tenantId, me.id);
    const now = today();
    const current = this.inEffectOn(revisions, now);
    const Item = await this.modelProvider.getEmployeeRecurringItemModel(tenantId);
    const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
    const [items, loans, taken] = await Promise.all([
      Item.findAll({ where: { tenantId, employeeId: me.id }, raw: true }),
      Loan.findAll({ where: { tenantId, employeeId: me.id }, raw: true }),
      this.takenBySource(tenantId, [me.id]),
    ]);
    const view = (revision: any) => {
      const full = this.compensationView(this.revisionLines(revision));
      // Employees see their own pay items; how a percentage was configured stays with payroll.
      return { lines: full.lines.map(({ code, name, type, category, monthlyAmount }) => ({ code, name, type, category, monthlyAmount })), totals: full.totals };
    };
    return {
      current: current ? { effectiveFrom: String(current.effectiveFrom).slice(0, 10), structureName: current.structureName ?? null, ...view(current) } : null,
      history: revisions
        .filter((r) => String(r.effectiveFrom).slice(0, 10) <= now)
        .map((r) => ({ effectiveFrom: String(r.effectiveFrom).slice(0, 10), structureName: r.structureName ?? null, totals: view(r).totals })),
      recurring: (items as any[]).map((row) => {
        const item = this.recurringRow(row, taken.get(row.id));
        return { id: item.id, kind: item.kind, name: item.name, amount: item.amount, calculationMethod: item.calculationMethod, percentageBase: item.percentageBase, startDate: item.startDate, endDate: item.endDate, remaining: item.remaining, status: item.status };
      }),
      loans: (loans as any[]).map((row) => {
        const loan = this.loanRow(row, taken.get(row.id));
        return { id: loan.id, kind: loan.kind, principal: loan.principal, installmentAmount: loan.installmentAmount, recovered: loan.recovered, remaining: loan.remaining, installmentsLeft: loan.installmentsLeft, startDate: loan.startDate, status: loan.status };
      }),
    };
  }

  async myReimbursements(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const rows = (await Reimbursement.findAll({ where: { tenantId, employeeId: me.id }, order: [['createdAt', 'DESC']] })) as any[];
    return rows.map((row) => {
      const { payrollRunId: _run, submittedBy: _by, ...rest } = this.reimbursementRow(row);
      return rest;
    });
  }

  /** An employee submitting their own claim — for themselves only. */
  async submitMyReimbursement(tenantId: string, userId: string, email: string | undefined, dto: Record<string, any>) {
    const me = await this.me(tenantId, userId, email);
    const { payrollPeriod: _ignored, ...claim } = dto;
    return this.reimbursementRow(await this.createReimbursementRow(tenantId, me.id, claim));
  }

  /** Category lists for the forms. */
  catalogOptions() {
    return {
      componentCategories: COMPONENT_CATEGORIES,
      notInCompensation: NOT_IN_COMPENSATION,
      recurringEarningCategories: RECURRING_EARNING_CATEGORIES,
      recurringDeductionCategories: RECURRING_DEDUCTION_CATEGORIES,
    };
  }
}

/** A small RFC 4180 CSV reader: quoted fields, doubled quotes, CRLF. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};
