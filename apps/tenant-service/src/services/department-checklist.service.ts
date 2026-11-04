import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  ChecklistKind,
  ChecklistOwnerKind,
  CreateDepartmentChecklistItemDto,
  EmployeeStatus,
  GetDepartmentChecklistQueryDto,
  MAX_DEPARTMENT_CHECKLIST_ITEMS,
  OnboardingTaskCategory,
  TenantErrorCode,
  TenantException,
  UpdateDepartmentChecklistItemDto,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { fullName } from './workspace-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

/**
 * The responsibilities each department adds to onboarding and offboarding.
 * Setting them only affects people who join or leave afterwards: a checklist
 * or clearance already made is not rewritten.
 */
@Injectable()
export class DepartmentChecklistService {
  private readonly logger = new Logger(DepartmentChecklistService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private async view(tenantId: string, rows: any[]) {
    const departmentIds = [...new Set(rows.map((row) => row.departmentId).filter(Boolean))] as string[];
    const employeeIds = [...new Set(rows.map((row) => row.ownerEmployeeId).filter(Boolean))] as string[];
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const [departments, employees] = await Promise.all([
      departmentIds.length ? (Department.findAll({ where: { tenantId, id: { [Op.in]: departmentIds } }, attributes: ['id', 'name'], raw: true }) as Promise<any[]>) : Promise.resolve([] as any[]),
      employeeIds.length ? (Employee.findAll({ where: { tenantId, id: { [Op.in]: employeeIds } }, attributes: ['id', 'firstName', 'lastName'], raw: true }) as Promise<any[]>) : Promise.resolve([] as any[]),
    ]);
    const departmentName = new Map(departments.map((row) => [row.id, row.name as string]));
    const employeeName = new Map(employees.map((row) => [row.id, fullName(row)]));
    return rows.map((row) => ({
      id: row.id as string,
      kind: row.kind as string,
      department: row.departmentId ? { id: row.departmentId as string, name: (departmentName.get(row.departmentId) ?? null) as string | null } : null,
      title: row.title as string,
      description: (row.description ?? null) as string | null,
      owner: {
        kind: row.ownerKind as string,
        employee: row.ownerEmployeeId ? { id: row.ownerEmployeeId as string, name: (employeeName.get(row.ownerEmployeeId) ?? null) as string | null } : null,
        permission: (row.ownerPermission ?? null) as string | null,
      },
      category: row.kind === ChecklistKind.ONBOARDING ? (row.category as string) : null,
      dueInDays: row.kind === ChecklistKind.ONBOARDING ? Number(row.dueInDays) : null,
      sortOrder: Number(row.sortOrder),
      isActive: row.isActive !== false,
    }));
  }

  private async find(tenantId: string, id: string) {
    const Item = await this.modelProvider.getDepartmentChecklistItemModel(tenantId);
    const row: any = await Item.findOne({ where: { id, tenantId } });
    if (!row) this.fail(HttpStatus.NOT_FOUND, 'Checklist item not found.');
    return row;
  }

  /** What the values would be, checked against what the kind allows. */
  private async check(tenantId: string, next: { kind: string; departmentId: string | null; ownerKind: string; ownerEmployeeId: string | null; ownerPermission: string | null; category: string }) {
    if (next.departmentId) {
      const Department = await this.modelProvider.getDepartmentModel(tenantId);
      if (!(await Department.count({ where: { id: next.departmentId, tenantId } }))) this.fail(HttpStatus.BAD_REQUEST, 'That department was not found in this organization.');
    }
    if (next.kind === ChecklistKind.ONBOARDING && next.ownerKind === ChecklistOwnerKind.PERMISSION) {
      this.fail(HttpStatus.BAD_REQUEST, 'An onboarding task is given to a person: use the department head, the reporting manager, a named person, or nobody in particular.');
    }
    if (next.kind === ChecklistKind.OFFBOARDING && next.ownerKind === ChecklistOwnerKind.NONE) {
      this.fail(HttpStatus.BAD_REQUEST, 'A clearance step needs an owner: the department head, the reporting manager, a named person, or a permission.');
    }
    if (next.ownerKind === ChecklistOwnerKind.EMPLOYEE) {
      if (!next.ownerEmployeeId) this.fail(HttpStatus.BAD_REQUEST, 'Choose the person who owns it.');
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const person: any = await Employee.findOne({ where: { id: next.ownerEmployeeId, tenantId }, attributes: ['id', 'status'] });
      if (!person || !EMPLOYED.includes(person.status)) this.fail(HttpStatus.BAD_REQUEST, 'The owner was not found, or no longer works here.');
    }
    if (next.ownerKind === ChecklistOwnerKind.PERMISSION && !next.ownerPermission) this.fail(HttpStatus.BAD_REQUEST, 'Choose the permission whose holders clear it.');
    if (next.kind === ChecklistKind.ONBOARDING && !Object.values(OnboardingTaskCategory).includes(next.category as OnboardingTaskCategory)) this.fail(HttpStatus.BAD_REQUEST, 'Unknown task category.');
  }

  async list(tenantId: string, query: GetDepartmentChecklistQueryDto = {}) {
    const Item = await this.modelProvider.getDepartmentChecklistItemModel(tenantId);
    const where: any = { tenantId };
    if (query.kind) where.kind = query.kind;
    if (query.departmentId) where[Op.or] = [{ departmentId: query.departmentId }];
    const rows = (await Item.findAll({ where, order: [['kind', 'ASC'], ['sortOrder', 'ASC'], ['createdAt', 'ASC']] })) as any[];
    return { data: await this.view(tenantId, rows), limit: MAX_DEPARTMENT_CHECKLIST_ITEMS };
  }

  async create(tenantId: string, dto: CreateDepartmentChecklistItemDto) {
    const next = {
      kind: dto.kind as string,
      departmentId: dto.departmentId ?? null,
      ownerKind: dto.ownerKind as string,
      ownerEmployeeId: dto.ownerKind === ChecklistOwnerKind.EMPLOYEE ? (dto.ownerEmployeeId ?? null) : null,
      ownerPermission: dto.ownerKind === ChecklistOwnerKind.PERMISSION ? (dto.ownerPermission ?? null) : null,
      category: dto.category ?? OnboardingTaskCategory.OTHER,
    };
    await this.check(tenantId, next);

    const Item = await this.modelProvider.getDepartmentChecklistItemModel(tenantId);
    const existing = (await Item.findAll({ where: { tenantId, kind: next.kind, departmentId: next.departmentId } as any, attributes: ['id', 'title', 'sortOrder'], raw: true })) as unknown as { title: string; sortOrder: number }[];
    if (existing.length >= MAX_DEPARTMENT_CHECKLIST_ITEMS) this.fail(HttpStatus.BAD_REQUEST, `A department can add ${MAX_DEPARTMENT_CHECKLIST_ITEMS} ${next.kind.toLowerCase()} items. Remove one first.`);
    if (existing.some((row) => row.title.trim().toLowerCase() === dto.title.trim().toLowerCase())) this.fail(HttpStatus.CONFLICT, 'That department already has an item with this title.');

    const created: any = await Item.create({
      tenantId,
      ...next,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      dueInDays: next.kind === ChecklistKind.ONBOARDING ? (dto.dueInDays ?? 0) : 0,
      sortOrder: existing.length ? Math.max(...existing.map((row) => Number(row.sortOrder))) + 10 : 10,
      isActive: true,
      createdByEmail: currentRpcActor()?.email ?? null,
    } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'department_checklist_items', created.id, 'CREATE', {
      title: { from: null, to: created.title },
      kind: { from: null, to: created.kind },
      departmentId: { from: null, to: created.departmentId },
    });
    return (await this.view(tenantId, [created]))[0];
  }

  async update(tenantId: string, id: string, dto: UpdateDepartmentChecklistItemDto) {
    const row = await this.find(tenantId, id);
    const ownerKind = (dto.ownerKind ?? row.ownerKind) as string;
    const next = {
      kind: row.kind as string,
      departmentId: dto.departmentId !== undefined ? dto.departmentId : (row.departmentId ?? null),
      ownerKind,
      ownerEmployeeId: ownerKind === ChecklistOwnerKind.EMPLOYEE ? (dto.ownerEmployeeId !== undefined ? dto.ownerEmployeeId : (row.ownerEmployeeId ?? null)) : null,
      ownerPermission: ownerKind === ChecklistOwnerKind.PERMISSION ? (dto.ownerPermission !== undefined ? dto.ownerPermission : (row.ownerPermission ?? null)) : null,
      category: (dto.category ?? row.category) as string,
    };
    await this.check(tenantId, next);
    const patch: Record<string, unknown> = { ...next };
    delete patch.kind;
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
    if (dto.dueInDays !== undefined && row.kind === ChecklistKind.ONBOARDING) patch.dueInDays = dto.dueInDays;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    await row.update(patch);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'department_checklist_items', id, 'UPDATE', { title: { from: null, to: row.title } });
    return (await this.view(tenantId, [row]))[0];
  }

  async remove(tenantId: string, id: string) {
    const row = await this.find(tenantId, id);
    await row.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'department_checklist_items', id, 'DELETE', { title: { from: row.title, to: null } });
    return { deleted: true, id };
  }
}
