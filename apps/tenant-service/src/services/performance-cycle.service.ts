import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CreatePerformanceCycleDto,
  CycleEnrolmentMode,
  EmployeeStatus,
  EnrolInCycleDto,
  GetPerformanceCyclesQueryDto,
  PerformanceCycleStatus,
  TenantErrorCode,
  TenantException,
  UpdatePerformanceCycleDto,
  grantsPermission,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceSyncService } from './performance-sync.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { EligibilityDecision, EligibilityRules, evaluateEligibility, normalizeEligibility } from './performance-eligibility';
import { fullName } from './workspace-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const PREVIEW_ROWS = 500;
const today = () => new Date().toISOString().slice(0, 10);
const day = (value: unknown) => String(value ?? '').slice(0, 10);

/**
 * Review cycles and who is in them. A cycle names a period and says who it is
 * for; Employee Management stays the source of who each person is. When a
 * cycle launches (or as someone becomes eligible), the people the rules include
 * get a review, or wait in an HR queue, depending on the cycle. Anyone the
 * rules leave out is not given an assessment task, and the reason is always
 * shown. Their earlier reviews are untouched.
 */
@Injectable()
export class PerformanceCycleService {
  private readonly logger = new Logger(PerformanceCycleService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly performance: PerformanceDashboardService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly sync?: PerformanceSyncService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private canOverride(): boolean {
    const rpc = currentRpcActor();
    return !rpc || rpc.isFullAccess === true || grantsPermission(rpc.permissions ?? [], 'performance.manage');
  }

  // ==========================================
  // Reading and rules
  // ==========================================

  private rulesOf(cycle: any): EligibilityRules {
    return normalizeEligibility(cycle.eligibility);
  }

  private async find(tenantId: string, id: string) {
    const Cycle = await this.modelProvider.getPerformanceCycleModel(tenantId);
    const cycle: any = await Cycle.findOne({ where: { id, tenantId } });
    if (!cycle) this.fail(HttpStatus.NOT_FOUND, 'Review cycle not found.');
    return cycle;
  }

  /** The departments the rules name, with the ones under them. */
  private async departmentSet(tenantId: string, rules: EligibilityRules): Promise<Set<string>> {
    const wanted = new Set(rules.departmentIds);
    if (!wanted.size) return wanted;
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const rows = (await Department.findAll({ where: { tenantId }, attributes: ['id', 'parentDepartmentId'], raw: true })) as unknown as { id: string; parentDepartmentId: string | null }[];
    for (let depth = 0; depth < 12; depth++) {
      const before = wanted.size;
      for (const row of rows) if (row.parentDepartmentId && wanted.has(row.parentDepartmentId)) wanted.add(row.id);
      if (wanted.size === before) break;
    }
    return wanted;
  }

  private async employees(tenantId: string, scoped: boolean, ids?: string[]): Promise<any[]> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const scope = scoped && this.dataScope ? await this.dataScope.employeeWhere(tenantId, 'id') : {};
    return (await Employee.findAll({
      where: { tenantId, ...(ids ? { id: { [Op.in]: ids } } : {}), ...scope } as any,
      attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'status', 'joiningDate', 'exitDate', 'employmentType', 'probationEndDate', 'departmentId', 'designationId', 'reportingManagerId'],
      order: [['firstName', 'ASC']],
      raw: true,
    })) as any[];
  }

  private async enrolledIds(tenantId: string, cycle: any): Promise<Set<string>> {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = (await Review.findAll({ where: { tenantId }, attributes: ['employeeId', 'cycle', 'cycleId'], raw: true })) as unknown as { employeeId: string; cycle: string; cycleId: string | null }[];
    const name = String(cycle.name).trim().toLowerCase();
    return new Set(rows.filter((row) => row.cycleId === cycle.id || String(row.cycle).trim().toLowerCase() === name).map((row) => row.employeeId));
  }

  private async decisions(tenantId: string, cycle: any, scoped: boolean, ids?: string[]) {
    const rules = this.rulesOf(cycle);
    const departments = await this.departmentSet(tenantId, rules);
    const people = await this.employees(tenantId, scoped, ids);
    const now = today();
    return people.map((employee) => ({ employee, decision: evaluateEligibility(employee, { startDate: day(cycle.startDate), endDate: day(cycle.endDate) }, rules, departments, now) }));
  }

  private async view(tenantId: string, cycle: any, extra: Record<string, unknown> = {}) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const enrolled = await Review.count({ where: { tenantId, [Op.or]: [{ cycleId: cycle.id }] } as any });
    return {
      id: cycle.id as string,
      name: cycle.name as string,
      startDate: day(cycle.startDate),
      endDate: day(cycle.endDate),
      dueDate: cycle.dueDate ? day(cycle.dueDate) : null,
      status: cycle.status as string,
      enrolmentMode: cycle.enrolmentMode as string,
      eligibility: this.rulesOf(cycle),
      fallbackReviewerId: (cycle.fallbackReviewerId ?? null) as string | null,
      launchedAt: cycle.launchedAt ?? null,
      closedAt: cycle.closedAt ?? null,
      createdBy: (cycle.createdByEmail ?? null) as string | null,
      enrolled,
      ...extra,
    };
  }

  async list(tenantId: string, query: GetPerformanceCyclesQueryDto = {}) {
    const Cycle = await this.modelProvider.getPerformanceCycleModel(tenantId);
    const rows = (await Cycle.findAll({ where: { tenantId, ...(query.status ? { status: query.status } : {}) } as any, order: [['startDate', 'DESC'], ['createdAt', 'DESC']] })) as any[];
    const data = [];
    for (const row of rows) data.push(await this.view(tenantId, row));
    const all = (await Cycle.findAll({ where: { tenantId }, attributes: ['status'], raw: true })) as unknown as { status: string }[];
    const count = (status: string) => all.filter((row) => row.status === status).length;
    return { data, summary: { draft: count('DRAFT'), active: count('ACTIVE'), closed: count('CLOSED') } };
  }

  async get(tenantId: string, id: string) {
    const cycle = await this.find(tenantId, id);
    const decided = await this.decisions(tenantId, cycle, true);
    const enrolled = await this.enrolledIds(tenantId, cycle);
    const eligible = decided.filter((row) => row.decision.eligible);
    return this.view(tenantId, cycle, {
      counts: {
        eligible: eligible.length,
        excluded: decided.filter((row) => !row.decision.eligible && row.decision.code !== 'NOT_EMPLOYED').length,
        waiting: eligible.filter((row) => !enrolled.has(row.employee.id)).length,
      },
    });
  }

  // ==========================================
  // Setting up
  // ==========================================

  /** Rules checked: every department, designation and person named is real, and nobody is both in and out. */
  private async checkRules(tenantId: string, rules: EligibilityRules) {
    const overlap = rules.includeEmployeeIds.filter((id) => rules.excludeEmployeeIds.includes(id));
    if (overlap.length) this.fail(HttpStatus.BAD_REQUEST, 'Someone is both included and excluded. Choose one.');
    const exists = async (kind: 'Department' | 'Designation' | 'Employee', ids: string[], label: string) => {
      if (!ids.length) return;
      const Model: any = kind === 'Department' ? await this.modelProvider.getDepartmentModel(tenantId) : kind === 'Designation' ? await this.modelProvider.getDesignationModel(tenantId) : await this.modelProvider.getEmployeeModel(tenantId);
      if ((await Model.count({ where: { tenantId, id: { [Op.in]: ids } } })) !== ids.length) this.fail(HttpStatus.BAD_REQUEST, `A selected ${label} was not found in this organization.`);
    };
    await exists('Department', rules.departmentIds, 'department');
    await exists('Designation', rules.designationIds, 'designation');
    await exists('Employee', [...rules.includeEmployeeIds, ...rules.excludeEmployeeIds], 'employee');
  }

  private async checkFallback(tenantId: string, fallbackReviewerId: string | null | undefined) {
    if (!fallbackReviewerId) return;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const person: any = await Employee.findOne({ where: { id: fallbackReviewerId, tenantId }, attributes: ['id', 'status'] });
    if (!person || !EMPLOYED.includes(person.status)) this.fail(HttpStatus.BAD_REQUEST, 'The fallback reviewer was not found, or no longer works here.');
  }

  private async assertNameFree(tenantId: string, name: string, exceptId?: string) {
    const Cycle = await this.modelProvider.getPerformanceCycleModel(tenantId);
    const rows = (await Cycle.findAll({ where: { tenantId }, attributes: ['id', 'name'], raw: true })) as unknown as { id: string; name: string }[];
    if (rows.some((row) => row.id !== exceptId && row.name.trim().toLowerCase() === name.trim().toLowerCase())) this.fail(HttpStatus.CONFLICT, `There is already a cycle called ${name.trim()}.`);
  }

  async create(tenantId: string, dto: CreatePerformanceCycleDto) {
    const startDate = day(dto.startDate);
    const endDate = day(dto.endDate);
    if (endDate < startDate) this.fail(HttpStatus.BAD_REQUEST, 'The cycle cannot end before it starts.');
    if (dto.dueDate && day(dto.dueDate) < startDate) this.fail(HttpStatus.BAD_REQUEST, 'The due date cannot be before the cycle starts.');
    await this.assertNameFree(tenantId, dto.name);
    const rules = normalizeEligibility(dto.eligibility as any);
    await this.checkRules(tenantId, rules);
    await this.checkFallback(tenantId, dto.fallbackReviewerId);

    const Cycle = await this.modelProvider.getPerformanceCycleModel(tenantId);
    const created: any = await Cycle.create({
      tenantId,
      name: dto.name.trim(),
      startDate,
      endDate,
      dueDate: dto.dueDate ? day(dto.dueDate) : null,
      status: PerformanceCycleStatus.DRAFT,
      enrolmentMode: dto.enrolmentMode ?? CycleEnrolmentMode.AUTO_ENROL,
      eligibility: rules,
      fallbackReviewerId: dto.fallbackReviewerId ?? null,
      createdByEmail: currentRpcActor()?.email ?? null,
    } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_cycles', created.id, 'CREATE', { name: { from: null, to: created.name } });
    return this.view(tenantId, created);
  }

  async update(tenantId: string, id: string, dto: UpdatePerformanceCycleDto) {
    const cycle = await this.find(tenantId, id);
    if (cycle.status === PerformanceCycleStatus.CLOSED) this.fail(HttpStatus.CONFLICT, 'A closed cycle cannot be changed.');
    const launched = cycle.status === PerformanceCycleStatus.ACTIVE;
    if (launched && (dto.name !== undefined || dto.startDate !== undefined || dto.endDate !== undefined)) {
      this.fail(HttpStatus.CONFLICT, 'The name and period of a cycle that has launched cannot change: its reviews carry them.');
    }

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      await this.assertNameFree(tenantId, dto.name, id);
      patch.name = dto.name.trim();
    }
    const startDate = dto.startDate !== undefined ? day(dto.startDate) : day(cycle.startDate);
    const endDate = dto.endDate !== undefined ? day(dto.endDate) : day(cycle.endDate);
    if (endDate < startDate) this.fail(HttpStatus.BAD_REQUEST, 'The cycle cannot end before it starts.');
    if (dto.startDate !== undefined) patch.startDate = startDate;
    if (dto.endDate !== undefined) patch.endDate = endDate;
    if (dto.dueDate !== undefined) patch.dueDate = dto.dueDate ? day(dto.dueDate) : null;
    if (dto.enrolmentMode !== undefined) patch.enrolmentMode = dto.enrolmentMode;
    if (dto.eligibility !== undefined) {
      const rules = normalizeEligibility(dto.eligibility as any);
      await this.checkRules(tenantId, rules);
      patch.eligibility = rules;
    }
    if (dto.fallbackReviewerId !== undefined) {
      await this.checkFallback(tenantId, dto.fallbackReviewerId);
      patch.fallbackReviewerId = dto.fallbackReviewerId ?? null;
    }
    if (Object.keys(patch).length) {
      await cycle.update(patch);
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_cycles', id, 'UPDATE', { fields: { from: null, to: Object.keys(patch).join(',') } });
    }
    return this.view(tenantId, cycle);
  }

  async remove(tenantId: string, id: string) {
    const cycle = await this.find(tenantId, id);
    if (cycle.status !== PerformanceCycleStatus.DRAFT) this.fail(HttpStatus.CONFLICT, 'Only a cycle that has not launched can be deleted. Close it instead.');
    await cycle.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_cycles', id, 'DELETE', { name: { from: cycle.name, to: null } });
    return { deleted: true, id };
  }

  // ==========================================
  // Who is in it
  // ==========================================

  /** Everyone, with whether the rules include them and why not. Those who have left are counted but not listed. */
  async preview(tenantId: string, id: string) {
    const cycle = await this.find(tenantId, id);
    const decided = await this.decisions(tenantId, cycle, true);
    const enrolled = await this.enrolledIds(tenantId, cycle);
    const byReason: Record<string, number> = {};
    for (const { decision } of decided) byReason[decision.code] = (byReason[decision.code] ?? 0) + 1;
    const listed = decided.filter((row) => row.decision.code !== 'NOT_EMPLOYED');
    return {
      cycle: { id: cycle.id as string, name: cycle.name as string },
      summary: { eligible: decided.filter((row) => row.decision.eligible).length, excluded: listed.filter((row) => !row.decision.eligible).length, enrolled: enrolled.size },
      byReason,
      total: listed.length,
      data: listed.slice(0, PREVIEW_ROWS).map(({ employee, decision }) => this.person(employee, decision, enrolled.has(employee.id))),
    };
  }

  private person(employee: any, decision: EligibilityDecision, enrolled: boolean) {
    return {
      employeeId: employee.id as string,
      name: fullName(employee),
      employeeCode: (employee.employeeCode ?? null) as string | null,
      eligible: decision.eligible,
      code: decision.code,
      reason: decision.reason,
      enrolled,
    };
  }

  /** The eligible people who have no review in this cycle yet, waiting for HR (or for the next sweep). */
  async queue(tenantId: string, id: string) {
    const cycle = await this.find(tenantId, id);
    const decided = await this.decisions(tenantId, cycle, true);
    const enrolled = await this.enrolledIds(tenantId, cycle);
    const waiting = decided.filter((row) => row.decision.eligible && !enrolled.has(row.employee.id));
    return { cycle: { id: cycle.id as string, name: cycle.name as string, status: cycle.status as string, enrolmentMode: cycle.enrolmentMode as string }, total: waiting.length, data: waiting.map(({ employee, decision }) => this.person(employee, decision, false)) };
  }

  /** Reviews for the eligible people not yet in the cycle. Returns who was enrolled. */
  private async enrolEligible(tenantId: string, cycle: any): Promise<string[]> {
    const decided = await this.decisions(tenantId, cycle, false);
    const enrolled = await this.enrolledIds(tenantId, cycle);
    const made: string[] = [];
    for (const { employee, decision } of decided) {
      if (!decision.eligible || enrolled.has(employee.id)) continue;
      if (await this.performance.enrolInCycle(tenantId, employee, cycle)) made.push(employee.id);
    }
    return made;
  }

  async launch(tenantId: string, id: string) {
    const cycle = await this.find(tenantId, id);
    if (cycle.status !== PerformanceCycleStatus.DRAFT) this.fail(HttpStatus.CONFLICT, `This cycle is ${String(cycle.status).toLowerCase()}.`);
    await cycle.update({ status: PerformanceCycleStatus.ACTIVE, launchedAt: new Date() });
    const made = cycle.enrolmentMode === CycleEnrolmentMode.AUTO_ENROL ? await this.enrolEligible(tenantId, cycle) : [];
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_cycles', id, 'UPDATE', {
      event: { from: null, to: 'CYCLE_LAUNCHED' },
      status: { from: 'DRAFT', to: 'ACTIVE' },
      enrolled: { from: null, to: made.length },
    });
    return { ...(await this.view(tenantId, cycle)), launched: { enrolled: made.length, queued: cycle.enrolmentMode === CycleEnrolmentMode.HR_QUEUE ? (await this.queue(tenantId, id)).total : 0 } };
  }

  async close(tenantId: string, id: string) {
    const cycle = await this.find(tenantId, id);
    if (cycle.status !== PerformanceCycleStatus.ACTIVE) this.fail(HttpStatus.CONFLICT, `Only a cycle that is running can be closed. This one is ${String(cycle.status).toLowerCase()}.`);
    await cycle.update({ status: PerformanceCycleStatus.CLOSED, closedAt: new Date() });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_cycles', id, 'UPDATE', { event: { from: null, to: 'CYCLE_CLOSED' }, status: { from: 'ACTIVE', to: 'CLOSED' } });
    return this.view(tenantId, cycle);
  }

  /** HR puts people into a running cycle. The rules decide, unless HR overrides for someone they leave out. */
  async enrol(tenantId: string, id: string, dto: EnrolInCycleDto) {
    const cycle = await this.find(tenantId, id);
    if (cycle.status !== PerformanceCycleStatus.ACTIVE) this.fail(HttpStatus.CONFLICT, 'People can only be enrolled in a cycle that is running.');
    const ids = [...new Set(dto.employeeIds)];
    if (!ids.length) this.fail(HttpStatus.BAD_REQUEST, 'Choose at least one employee.');
    if (dto.override === true && !this.canOverride()) this.fail(HttpStatus.FORBIDDEN, 'Only someone who manages performance can enrol people the rules leave out.');

    const decided = new Map((await this.decisions(tenantId, cycle, true, ids)).map((row) => [row.employee.id, row]));
    const enrolled = await this.enrolledIds(tenantId, cycle);
    const result = { enrolled: [] as string[], alreadyIn: [] as string[], refused: [] as { employeeId: string; reason: string }[] };
    for (const employeeId of ids) {
      const row = decided.get(employeeId);
      if (!row) {
        result.refused.push({ employeeId, reason: 'Not found, or outside what you can see.' });
        continue;
      }
      if (enrolled.has(employeeId)) {
        result.alreadyIn.push(employeeId);
        continue;
      }
      if (!row.decision.eligible && dto.override !== true) {
        result.refused.push({ employeeId, reason: row.decision.reason ?? 'The rules leave them out.' });
        continue;
      }
      if (await this.performance.enrolInCycle(tenantId, row.employee, cycle)) {
        result.enrolled.push(employeeId);
        if (!row.decision.eligible) {
          await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_cycles', id, 'UPDATE', {
            event: { from: null, to: 'ELIGIBILITY_OVERRIDDEN' },
            employeeId: { from: null, to: employeeId },
            reason: { from: null, to: row.decision.reason },
          });
        }
      }
    }
    return result;
  }

  /**
   * Someone with an open review in a running cycle may no longer fit its rules
   * (a contract or department change). HR is told, and decides; nothing is
   * removed by itself. If they fit again the flag is dropped.
   */
  private async refreshEligibilityFlags(tenantId: string, employeeId: string, cycles: any[]): Promise<void> {
    if (!this.sync || !cycles.length) return;
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const reviews = (await Review.findAll({ where: { tenantId, employeeId } })) as any[];
    for (const cycle of cycles) {
      const review = reviews.find((row) => row.cycleId === cycle.id);
      if (!review || review.closedAt || review.publishedAt || review.status === 'COMPLETED') continue;
      const [row] = await this.decisions(tenantId, cycle, false, [employeeId]);
      if (!row) continue;
      if (row.decision.eligible) await this.sync.clearEligibility(tenantId, review);
      else if (row.decision.code !== 'NOT_EMPLOYED' && row.decision.reason) await this.sync.flagEligibility(tenantId, review, row.decision.reason);
    }
  }

  /**
   * Employee Management changed someone (hired, probation confirmed, moved,
   * status changed). Running AUTO_ENROL cycles that are still taking people and
   * now include them, and where they have no review yet, enrol them. Never fails
   * the change that triggered it. Returns how many reviews it made.
   */
  async onEmployeeChange(tenantId: string, employeeId: string): Promise<number> {
    const Cycle = await this.modelProvider.getPerformanceCycleModel(tenantId);
    const running = (await Cycle.findAll({ where: { tenantId, status: PerformanceCycleStatus.ACTIVE } as any })) as any[];
    await this.refreshEligibilityFlags(tenantId, employeeId, running);
    const cycles = running.filter((cycle) => cycle.enrolmentMode === CycleEnrolmentMode.AUTO_ENROL);
    const now = today();
    let made = 0;
    for (const cycle of cycles) {
      // Past its due date a cycle takes no one new.
      if (now > day(cycle.dueDate ?? cycle.endDate)) continue;
      const [row] = await this.decisions(tenantId, cycle, false, [employeeId]);
      if (!row?.decision.eligible) continue;
      if ((await this.enrolledIds(tenantId, cycle)).has(employeeId)) continue;
      if (await this.performance.enrolInCycle(tenantId, row.employee, cycle)) made++;
    }
    return made;
  }
}
