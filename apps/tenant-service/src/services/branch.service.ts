import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, fn, col } from 'sequelize';
import {
  AssignBranchEmployeesDto,
  BranchStatusFilter,
  CreateBranchDto,
  EmployeeStatus,
  GetBranchesQueryDto,
  TenantErrorCode,
  TenantException,
  UpdateBranchDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, fullName } from './workspace-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
const MAX_BRANCHES = 500;

/**
 * The offices and locations an organization works from. An employee works
 * from at most one. A branch has a head; a role whose data scope is BRANCH
 * sees the branches its person heads, or the branch they work in.
 */
@Injectable()
export class BranchService {
  private readonly logger = new Logger(BranchService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  // ==========================================
  // Reading
  // ==========================================

  private async headsOf(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map<string, any>();
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: unique } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl'] })) as any[];
    return new Map(rows.map((row) => [row.id as string, row]));
  }

  /** How many people work from each branch, among those still employed. */
  private async headcounts(tenantId: string): Promise<Map<string, number>> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({
      where: { tenantId, branchId: { [Op.ne]: null }, status: { [Op.in]: EMPLOYED } } as any,
      attributes: ['branchId', [fn('COUNT', col('id')), 'count']],
      group: ['branchId'],
      raw: true,
    })) as unknown as { branchId: string; count: string }[];
    return new Map(rows.map((row) => [row.branchId, Number(row.count)]));
  }

  private toRow(branch: any, head: any | undefined, headcount: number) {
    return {
      id: branch.id as string,
      name: branch.name as string,
      code: (branch.code ?? null) as string | null,
      address: (branch.address ?? null) as string | null,
      city: (branch.city ?? null) as string | null,
      country: (branch.country ?? null) as string | null,
      phone: (branch.phone ?? null) as string | null,
      isActive: branch.isActive !== false,
      head: head ? { employeeId: head.id as string, name: fullName(head), employeeCode: (head.employeeCode ?? null) as string | null, avatarUrl: (head.avatarUrl ?? null) as string | null } : null,
      employeeCount: headcount,
      createdAt: branch.createdAt as Date,
      updatedAt: branch.updatedAt as Date,
    };
  }

  /** The branches, with their heads and how many people work from each. */
  async getBranches(tenantId: string, query: GetBranchesQueryDto = {}) {
    const Branch = await this.modelProvider.getBranchModel(tenantId);
    const where: Record<string | symbol, unknown> = { tenantId };
    if (query.status === BranchStatusFilter.ACTIVE) where.isActive = true;
    if (query.status === BranchStatusFilter.INACTIVE) where.isActive = false;
    const term = query.search?.trim();
    if (term) {
      const like = `%${ESCAPE(term)}%`;
      where[Op.or] = [{ name: { [Op.iLike]: like } }, { code: { [Op.iLike]: like } }, { city: { [Op.iLike]: like } }];
    }
    const rows = (await Branch.findAll({ where: where as any, order: [['name', 'ASC']], limit: MAX_BRANCHES })) as any[];
    const [heads, counts, all] = await Promise.all([
      this.headsOf(tenantId, rows.map((row) => row.headEmployeeId)),
      this.headcounts(tenantId),
      Branch.findAll({ where: { tenantId }, attributes: ['isActive'], raw: true }) as unknown as Promise<{ isActive: boolean }[]>,
    ]);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const unassigned = await Employee.count({ where: { tenantId, branchId: null, status: { [Op.in]: EMPLOYED } } as any });
    return {
      data: rows.map((row) => this.toRow(row, heads.get(row.headEmployeeId), counts.get(row.id) ?? 0)),
      summary: {
        total: all.length,
        active: all.filter((row) => row.isActive !== false).length,
        inactive: all.filter((row) => row.isActive === false).length,
        employeesWithoutBranch: unassigned,
      },
    };
  }

  private async find(tenantId: string, branchId: string) {
    const Branch = await this.modelProvider.getBranchModel(tenantId);
    const branch: any = await Branch.findOne({ where: { id: branchId, tenantId } });
    if (!branch) this.fail(HttpStatus.NOT_FOUND, `Branch '${branchId}' not found in this organization.`);
    return branch;
  }

  /** One branch with its departments' headcounts. */
  async getBranch(tenantId: string, branchId: string) {
    const branch = await this.find(tenantId, branchId);
    const [heads, counts] = await Promise.all([this.headsOf(tenantId, [branch.headEmployeeId]), this.headcounts(tenantId)]);

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const byDepartment = (await Employee.findAll({
      where: { tenantId, branchId, status: { [Op.in]: EMPLOYED } } as any,
      attributes: ['departmentId', [fn('COUNT', col('id')), 'count']],
      group: ['departmentId'],
      raw: true,
    })) as unknown as { departmentId: string | null; count: string }[];
    const ids = byDepartment.map((row) => row.departmentId).filter(Boolean) as string[];
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const names = ids.length ? ((await Department.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'name'], raw: true })) as unknown as { id: string; name: string }[]) : [];
    const nameOf = new Map(names.map((row) => [row.id, row.name]));
    const linked = (await Department.findAll({ where: { tenantId, branchIds: { [Op.contains]: [branchId] } } as any, attributes: ['id', 'name'], raw: true })) as unknown as { id: string; name: string }[];
    return {
      ...this.toRow(branch, heads.get(branch.headEmployeeId), counts.get(branch.id) ?? 0),
      linkedDepartments: linked.map((row) => ({ departmentId: row.id, name: row.name })).sort((a, b) => a.name.localeCompare(b.name)),
      departments: byDepartment
        .map((row) => ({ departmentId: row.departmentId, name: row.departmentId ? (nameOf.get(row.departmentId) ?? null) : 'No department', employeeCount: Number(row.count) }))
        .sort((a, b) => b.employeeCount - a.employeeCount || String(a.name).localeCompare(String(b.name))),
    };
  }

  // ==========================================
  // Changing
  // ==========================================

  private async assertNameFree(tenantId: string, name: string, code: string | null | undefined, exceptId?: string) {
    const Branch = await this.modelProvider.getBranchModel(tenantId);
    const sameName: any = await Branch.findOne({ where: { tenantId, name: { [Op.iLike]: ESCAPE(name) }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) } as any });
    if (sameName) this.fail(HttpStatus.CONFLICT, `A branch named '${sameName.name}' already exists.`);
    if (code) {
      const sameCode: any = await Branch.findOne({ where: { tenantId, code, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) } as any });
      if (sameCode) this.fail(HttpStatus.CONFLICT, `The code '${code}' is already used by ${sameCode.name}.`);
    }
  }

  private async assertHead(tenantId: string, headEmployeeId: string | null | undefined) {
    if (!headEmployeeId) return;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const head: any = await Employee.findOne({ where: { tenantId, id: headEmployeeId }, attributes: ['id', 'status'] });
    if (!head) this.fail(HttpStatus.BAD_REQUEST, 'The branch head was not found in this organization.');
    if (!EMPLOYED.includes(head.status)) this.fail(HttpStatus.BAD_REQUEST, 'The branch head no longer works here.');
  }

  async createBranch(tenantId: string, dto: CreateBranchDto) {
    await this.assertNameFree(tenantId, dto.name, dto.code);
    await this.assertHead(tenantId, dto.headEmployeeId);
    const Branch = await this.modelProvider.getBranchModel(tenantId);
    const branch: any = await Branch.create({
      tenantId,
      name: dto.name,
      code: dto.code ?? null,
      address: dto.address ?? null,
      city: dto.city ?? null,
      country: dto.country ?? null,
      phone: dto.phone ?? null,
      headEmployeeId: dto.headEmployeeId ?? null,
      isActive: true,
    } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'branches', branch.id, 'CREATE', {
      name: { from: null, to: branch.name },
      headEmployeeId: { from: null, to: branch.headEmployeeId },
    });
    return this.getBranch(tenantId, branch.id);
  }

  async updateBranch(tenantId: string, branchId: string, dto: UpdateBranchDto) {
    const branch = await this.find(tenantId, branchId);
    if (dto.name !== undefined || dto.code !== undefined) {
      await this.assertNameFree(tenantId, dto.name ?? branch.name, dto.code !== undefined ? dto.code : branch.code, branchId);
    }
    if (dto.headEmployeeId !== undefined) await this.assertHead(tenantId, dto.headEmployeeId);

    const next: Record<string, unknown> = {};
    for (const key of ['name', 'code', 'address', 'city', 'country', 'phone', 'headEmployeeId', 'isActive'] as const) {
      if (dto[key] !== undefined) next[key] = dto[key];
    }
    const changes = diffFields(branch.get({ plain: true }), next);
    if (Object.keys(changes).length) {
      await branch.update(next);
      await writeAudit(this.modelProvider, this.logger, tenantId, 'branches', branchId, 'UPDATE', changes);
    }
    return this.getBranch(tenantId, branchId);
  }

  /** Only a branch nobody works from can go; otherwise make it inactive. */
  async deleteBranch(tenantId: string, branchId: string) {
    const branch = await this.find(tenantId, branchId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const people = await Employee.count({ where: { tenantId, branchId } });
    if (people) {
      this.fail(HttpStatus.CONFLICT, `${people} ${people === 1 ? 'person is' : 'people are'} assigned to this branch. Move them to another branch first, or make the branch inactive.`);
    }
    await branch.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'branches', branchId, 'DELETE', { name: { from: branch.name, to: null } });
    return { deleted: true, id: branchId };
  }

  // ==========================================
  // Who works where
  // ==========================================

  /** Employees the caller may change, from the ids given. Others are counted as not found. */
  private async reachable(tenantId: string, employeeIds: string[]) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const scope = this.dataScope ? await this.dataScope.employeeWhere(tenantId, 'id') : {};
    const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: employeeIds }, ...scope } as any, attributes: ['id', 'branchId'] })) as any[];
    return rows;
  }

  /** Puts people in the branch. Anyone already there is left, and people outside the caller's reach are reported. */
  async assignEmployees(tenantId: string, branchId: string, dto: AssignBranchEmployeesDto) {
    const branch = await this.find(tenantId, branchId);
    if (branch.isActive === false) this.fail(HttpStatus.CONFLICT, 'This branch is inactive. Make it active before moving people into it.');
    const found = await this.reachable(tenantId, dto.employeeIds);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const toMove = found.filter((row) => row.branchId !== branchId);
    if (toMove.length) await Employee.update({ branchId } as any, { where: { tenantId, id: { [Op.in]: toMove.map((row) => row.id) } } as any });
    if (toMove.length) {
      await writeAudit(this.modelProvider, this.logger, tenantId, 'branches', branchId, 'UPDATE', {
        peopleMovedIn: { from: 0, to: toMove.length },
      });
    }
    return { branchId, moved: toMove.length, alreadyThere: found.length - toMove.length, notFound: dto.employeeIds.length - found.length };
  }

  /** Takes people out of the branch; they are left with no branch. Only those who are in it. */
  async removeEmployees(tenantId: string, branchId: string, dto: AssignBranchEmployeesDto) {
    await this.find(tenantId, branchId);
    const found = (await this.reachable(tenantId, dto.employeeIds)).filter((row) => row.branchId === branchId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    if (found.length) {
      await Employee.update({ branchId: null } as any, { where: { tenantId, id: { [Op.in]: found.map((row) => row.id) } } as any });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'branches', branchId, 'UPDATE', { peopleMovedOut: { from: 0, to: found.length } });
    }
    return { branchId, removed: found.length, notInThisBranch: dto.employeeIds.length - found.length };
  }

  /**
   * The old way of naming an office was free text on a department. This turns
   * each distinct location into a branch, and puts the people of those
   * departments in it, unless they already have a branch. It shows what it
   * would do until told to apply.
   */
  async fromLocations(tenantId: string, apply = false) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Branch = await this.modelProvider.getBranchModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const departments = (await Department.findAll({ where: { tenantId, location: { [Op.ne]: null } } as any, attributes: ['id', 'location'], raw: true })) as unknown as { id: string; location: string }[];

    const groups = new Map<string, { name: string; departmentIds: string[] }>();
    for (const department of departments) {
      const name = String(department.location ?? '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const group = groups.get(key) ?? { name, departmentIds: [] };
      group.departmentIds.push(department.id);
      groups.set(key, group);
    }

    const existing = (await Branch.findAll({ where: { tenantId }, attributes: ['id', 'name'], raw: true })) as unknown as { id: string; name: string }[];
    const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row.id]));

    const plan = [];
    for (const [key, group] of groups) {
      const people = (await Employee.findAll({
        where: { tenantId, departmentId: { [Op.in]: group.departmentIds }, branchId: null, status: { [Op.in]: EMPLOYED } } as any,
        attributes: ['id'],
        raw: true,
      })) as unknown as { id: string }[];
      plan.push({ name: group.name, key, departments: group.departmentIds.length, employees: people.length, exists: byName.has(key), peopleIds: people.map((row) => row.id) });
    }

    let created = 0;
    let moved = 0;
    if (apply) {
      for (const item of plan) {
        let branchId = byName.get(item.key);
        if (!branchId) {
          const branch: any = await Branch.create({ tenantId, name: item.name.slice(0, 120), isActive: true } as any);
          branchId = branch.id as string;
          created++;
          await writeAudit(this.modelProvider, this.logger, tenantId, 'branches', branchId, 'CREATE', { name: { from: null, to: branch.name }, source: { from: null, to: 'department locations' } });
        }
        if (item.peopleIds.length) {
          await Employee.update({ branchId } as any, { where: { tenantId, id: { [Op.in]: item.peopleIds } } as any });
          moved += item.peopleIds.length;
        }
      }
    }
    return {
      applied: apply,
      branches: plan.map(({ name, departments: count, employees, exists }) => ({ name, departments: count, employees, exists })),
      created,
      employeesMoved: moved,
    };
  }
}
