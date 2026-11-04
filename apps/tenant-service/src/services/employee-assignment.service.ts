import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CreateEmployeeAssignmentDto,
  EmployeeNotificationKind,
  EmployeeStatus,
  EndEmployeeAssignmentDto,
  MAX_ACTIVE_ASSIGNMENTS,
  TenantErrorCode,
  TenantException,
  UpdateEmployeeAssignmentDto,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { OrganizationHierarchyService } from './organization-hierarchy.service';
import { fullName } from './workspace-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const today = () => new Date().toISOString().slice(0, 10);
const day = (value: unknown) => String(value ?? '').slice(0, 10);

/**
 * Additional roles beside a person's primary position: a second department
 * they support, a dotted-line manager, a named responsibility. The primary
 * department, designation and reporting manager stay on the employee and are
 * what approvals follow. These assignments add visibility (the other manager
 * and department head can see the person) and a record of who else they work
 * for. Adding or ending one goes into the hierarchy history.
 */
@Injectable()
export class EmployeeAssignmentService {
  private readonly logger = new Logger(EmployeeAssignmentService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly hierarchy?: OrganizationHierarchyService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private isActive(row: any): boolean {
    return !row.endDate || day(row.endDate) >= today();
  }

  private async employed(tenantId: string, id: string, what: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const row: any = await Employee.findOne({ where: { id, tenantId } });
    if (!row) this.fail(HttpStatus.NOT_FOUND, `${what} was not found in this organization.`);
    if (!EMPLOYED.includes(row.status)) this.fail(HttpStatus.BAD_REQUEST, `${what} no longer works here.`);
    return row;
  }

  private async reach(tenantId: string, employeeId: string) {
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, employeeId, 'Employee');
  }

  private async references(tenantId: string, rows: any[]) {
    const ids = (key: string) => [...new Set(rows.map((row) => row[key]).filter(Boolean))] as string[];
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const [departments, designations, managers] = await Promise.all([
      ids('departmentId').length ? (Department.findAll({ where: { tenantId, id: { [Op.in]: ids('departmentId') } }, attributes: ['id', 'name'], raw: true }) as Promise<any[]>) : Promise.resolve([] as any[]),
      ids('designationId').length ? (Designation.findAll({ where: { tenantId, id: { [Op.in]: ids('designationId') } }, attributes: ['id', 'title'], raw: true }) as Promise<any[]>) : Promise.resolve([] as any[]),
      ids('reportingManagerId').length ? (Employee.findAll({ where: { tenantId, id: { [Op.in]: ids('reportingManagerId') } }, attributes: ['id', 'firstName', 'lastName'], raw: true }) as Promise<any[]>) : Promise.resolve([] as any[]),
    ]);
    return {
      department: new Map(departments.map((row) => [row.id, row])),
      designation: new Map(designations.map((row) => [row.id, row])),
      manager: new Map(managers.map((row) => [row.id, row])),
    };
  }

  private view(row: any, refs: Awaited<ReturnType<EmployeeAssignmentService['references']>>) {
    const department = row.departmentId ? refs.department.get(row.departmentId) : null;
    const designation = row.designationId ? refs.designation.get(row.designationId) : null;
    const manager = row.reportingManagerId ? refs.manager.get(row.reportingManagerId) : null;
    return {
      id: row.id as string,
      employeeId: row.employeeId as string,
      department: department ? { id: department.id as string, name: department.name as string } : null,
      designation: designation ? { id: designation.id as string, title: designation.title as string } : null,
      title: (row.title ?? null) as string | null,
      reportingManager: manager ? { id: manager.id as string, name: fullName(manager) } : null,
      responsibilities: (row.responsibilities ?? null) as string | null,
      startDate: day(row.startDate),
      endDate: row.endDate ? day(row.endDate) : null,
      active: this.isActive(row),
      createdBy: (row.createdByEmail ?? null) as string | null,
    };
  }

  /** What the history says about an assignment. */
  private label(view: ReturnType<EmployeeAssignmentService['view']>): string {
    return [view.title, view.designation?.title, view.department?.name, view.reportingManager ? `reporting to ${view.reportingManager.name}` : null].filter(Boolean).join(' · ') || 'Additional assignment';
  }

  private async record(tenantId: string, employeeId: string, changeType: 'ASSIGNMENT_ADDED' | 'ASSIGNMENT_ENDED', assignmentId: string, label: string, effectiveFrom: string) {
    try {
      const Change = await this.modelProvider.getHierarchyChangeModel(tenantId);
      const rpc = currentRpcActor();
      const added = changeType === 'ASSIGNMENT_ADDED';
      await Change.create({
        tenantId,
        subjectType: 'EMPLOYEE',
        subjectId: employeeId,
        changeType,
        previousId: added ? null : assignmentId,
        previousLabel: added ? null : label,
        nextId: added ? assignmentId : null,
        nextLabel: added ? label : null,
        effectiveFrom,
        changedByEmail: rpc?.email ?? null,
      } as any);
    } catch (error: any) {
      this.logger.warn(`An assignment change for ${employeeId} was saved but not recorded in the history: ${error?.message ?? error}`);
    }
  }

  private async notify(tenantId: string, employeeId: string | null | undefined, title: string, body: string) {
    if (!employeeId) return;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.GENERAL, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`An assignment notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  /**
   * An additional manager came or went: whatever of theirs is waiting for approval
   * follows the new route (it only changes where a policy has an additional-manager
   * stage). A failure here does not undo the assignment.
   */
  private async followRoute(tenantId: string, employeeId: string) {
    if (!this.hierarchy) return;
    try {
      await this.hierarchy.followApprovalRoute(tenantId, employeeId);
    } catch (error: any) {
      this.logger.warn(`Pending approvals for ${employeeId} were not re-routed after an assignment change: ${error?.message ?? error}`);
    }
  }

  private async rowsOf(tenantId: string, employeeId: string) {
    const Assignment = await this.modelProvider.getEmployeeAssignmentModel(tenantId);
    return (await Assignment.findAll({ where: { tenantId, employeeId }, order: [['startDate', 'DESC'], ['createdAt', 'DESC']] })) as any[];
  }

  private async find(tenantId: string, employeeId: string, assignmentId: string) {
    const Assignment = await this.modelProvider.getEmployeeAssignmentModel(tenantId);
    const row: any = await Assignment.findOne({ where: { id: assignmentId, tenantId, employeeId } });
    if (!row) this.fail(HttpStatus.NOT_FOUND, 'Assignment not found.');
    return row;
  }

  /** What the values would be, checked: at least a department, a manager or a title, and each reference real. */
  private async check(tenantId: string, employee: any, next: { departmentId: string | null; designationId: string | null; title: string | null; reportingManagerId: string | null }) {
    if (!next.departmentId && !next.reportingManagerId && !next.title) {
      this.fail(HttpStatus.BAD_REQUEST, 'Give the department they also work for, an additional manager, or a title for the role.');
    }
    if (next.departmentId) {
      const Department = await this.modelProvider.getDepartmentModel(tenantId);
      if (!(await Department.count({ where: { id: next.departmentId, tenantId } }))) this.fail(HttpStatus.BAD_REQUEST, 'That department was not found in this organization.');
    }
    if (next.designationId) {
      const Designation = await this.modelProvider.getDesignationModel(tenantId);
      if (!(await Designation.count({ where: { id: next.designationId, tenantId } }))) this.fail(HttpStatus.BAD_REQUEST, 'That designation was not found in this organization.');
    }
    if (next.reportingManagerId) {
      if (next.reportingManagerId === employee.id) this.fail(HttpStatus.BAD_REQUEST, 'Someone cannot be their own additional manager.');
      await this.employed(tenantId, next.reportingManagerId, 'The additional manager');
    }
  }

  // ==========================================
  // HR: a person's assignments
  // ==========================================

  async list(tenantId: string, employeeId: string) {
    await this.reach(tenantId, employeeId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found.');
    const rows = await this.rowsOf(tenantId, employeeId);
    const primary = await this.references(tenantId, [{ departmentId: employee.departmentId, designationId: employee.designationId, reportingManagerId: employee.reportingManagerId }, ...rows]);
    const views = rows.map((row) => this.view(row, primary));
    return {
      employee: { id: employee.id as string, name: fullName(employee), employeeCode: (employee.employeeCode ?? null) as string | null },
      primary: {
        department: employee.departmentId ? (primary.department.get(employee.departmentId) ? { id: employee.departmentId as string, name: primary.department.get(employee.departmentId).name as string } : null) : null,
        designation: employee.designationId ? (primary.designation.get(employee.designationId)?.title ?? null) : null,
        reportingManager: employee.reportingManagerId && primary.manager.get(employee.reportingManagerId) ? { id: employee.reportingManagerId as string, name: fullName(primary.manager.get(employee.reportingManagerId)) } : null,
      },
      data: [...views.filter((view) => view.active), ...views.filter((view) => !view.active)],
    };
  }

  async add(tenantId: string, employeeId: string, dto: CreateEmployeeAssignmentDto) {
    await this.reach(tenantId, employeeId);
    const employee = await this.employed(tenantId, employeeId, 'The employee');
    const next = {
      departmentId: dto.departmentId ?? null,
      designationId: dto.designationId ?? null,
      title: dto.title?.trim() || null,
      reportingManagerId: dto.reportingManagerId ?? null,
    };
    await this.check(tenantId, employee, next);

    const rows = await this.rowsOf(tenantId, employeeId);
    const active = rows.filter((row) => this.isActive(row));
    if (active.length >= MAX_ACTIVE_ASSIGNMENTS) this.fail(HttpStatus.BAD_REQUEST, `A person can hold ${MAX_ACTIVE_ASSIGNMENTS} additional assignments at a time. End one first.`);
    const same = active.some(
      (row) => (row.departmentId ?? null) === next.departmentId && (row.reportingManagerId ?? null) === next.reportingManagerId && String(row.title ?? '').toLowerCase() === String(next.title ?? '').toLowerCase(),
    );
    if (same) this.fail(HttpStatus.CONFLICT, 'They already hold that assignment.');

    const startDate = dto.startDate ? day(dto.startDate) : today();
    const Assignment = await this.modelProvider.getEmployeeAssignmentModel(tenantId);
    const created: any = await Assignment.create({
      tenantId,
      employeeId,
      ...next,
      responsibilities: dto.responsibilities?.trim() || null,
      startDate,
      endDate: null,
      createdByEmail: currentRpcActor()?.email ?? null,
    } as any);

    const view = this.view(created, await this.references(tenantId, [created]));
    await this.record(tenantId, employeeId, 'ASSIGNMENT_ADDED', created.id, this.label(view), startDate);
    await this.notify(tenantId, employeeId, 'New additional role', `You now also work as: ${this.label(view)}.`);
    if (next.reportingManagerId) {
      await this.notify(tenantId, next.reportingManagerId, 'Added to your team', `${fullName(employee)} now also works with you (${this.label(view)}).`);
      await this.followRoute(tenantId, employeeId);
    }
    return view;
  }

  async update(tenantId: string, employeeId: string, assignmentId: string, dto: UpdateEmployeeAssignmentDto) {
    await this.reach(tenantId, employeeId);
    const employee = await this.employed(tenantId, employeeId, 'The employee');
    const row = await this.find(tenantId, employeeId, assignmentId);
    if (!this.isActive(row)) this.fail(HttpStatus.CONFLICT, 'This assignment has ended and cannot be changed.');
    const pick = <T>(key: keyof UpdateEmployeeAssignmentDto, current: T) => ((dto as any)[key] !== undefined ? (((dto as any)[key] as T) ?? null) : current);
    const next = {
      departmentId: pick('departmentId', row.departmentId ?? null) as string | null,
      designationId: pick('designationId', row.designationId ?? null) as string | null,
      title: dto.title !== undefined ? (dto.title?.trim() || null) : (row.title ?? null),
      reportingManagerId: pick('reportingManagerId', row.reportingManagerId ?? null) as string | null,
    };
    await this.check(tenantId, employee, next);
    const managerChanged = (row.reportingManagerId ?? null) !== next.reportingManagerId;
    await row.update({ ...next, ...(dto.responsibilities !== undefined ? { responsibilities: dto.responsibilities?.trim() || null } : {}) });
    if (managerChanged) await this.followRoute(tenantId, employeeId);
    return this.view(row, await this.references(tenantId, [row]));
  }

  async end(tenantId: string, employeeId: string, assignmentId: string, dto: EndEmployeeAssignmentDto = {}) {
    await this.reach(tenantId, employeeId);
    const row = await this.find(tenantId, employeeId, assignmentId);
    if (!this.isActive(row)) this.fail(HttpStatus.CONFLICT, 'This assignment has already ended.');
    const endDate = dto.endDate ? day(dto.endDate) : today();
    if (endDate < day(row.startDate)) this.fail(HttpStatus.BAD_REQUEST, 'The end date cannot be before the start date.');
    await row.update({ endDate });
    const view = this.view(row, await this.references(tenantId, [row]));
    await this.record(tenantId, employeeId, 'ASSIGNMENT_ENDED', row.id, this.label(view), endDate);
    if (row.reportingManagerId) await this.followRoute(tenantId, employeeId);
    return view;
  }

  // ==========================================
  // The employee: my roles, and who I also manage
  // ==========================================

  async listMine(tenantId: string, userId: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let me: any = userId ? await Employee.findOne({ where: { tenantId, userId } }) : null;
    if (!me && email?.trim()) me = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } });
    if (!me) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');

    const Assignment = await this.modelProvider.getEmployeeAssignmentModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const headed = ((await Department.findAll({ where: { tenantId, managerId: me.id }, attributes: ['id'], raw: true })) as unknown as { id: string }[]).map((row) => row.id);
    const [mine, supporting] = await Promise.all([
      this.rowsOf(tenantId, me.id),
      (Assignment.findAll({
        where: { tenantId, employeeId: { [Op.ne]: me.id }, [Op.or]: [{ reportingManagerId: me.id }, ...(headed.length ? [{ departmentId: { [Op.in]: headed } }] : [])] } as any,
        order: [['startDate', 'DESC']],
        limit: 200,
      }) as Promise<any[]>),
    ]);
    const activeSupporting = supporting.filter((row) => this.isActive(row));
    const people = await this.references(tenantId, [...mine, ...activeSupporting]);
    const peopleRows = activeSupporting.length
      ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: [...new Set(activeSupporting.map((row) => row.employeeId))] } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], raw: true })) as any[])
      : [];
    const byId = new Map(peopleRows.map((row) => [row.id, row]));
    return {
      assignments: mine.filter((row) => this.isActive(row)).map((row) => this.view(row, people)),
      alsoSupporting: activeSupporting.map((row) => {
        const person = byId.get(row.employeeId);
        return { ...this.view(row, people), employee: person ? { id: person.id as string, name: fullName(person), employeeCode: (person.employeeCode ?? null) as string | null } : null };
      }),
    };
  }
}
