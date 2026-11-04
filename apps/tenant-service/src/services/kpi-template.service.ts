import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CreateKpiTemplateDto,
  KpiItemDto,
  KpiMeasurement,
  TenantErrorCode,
  TenantException,
  UpdateKpiTemplateDto,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import type { KpiItem } from '../models/performance-kpi.model';

const MAX_DEPTH = 12;

/** The department and everything under it. */
const withSubDepartments = async (modelProvider: TenantModelProviderService, tenantId: string, ids: string[]): Promise<Set<string>> => {
  const wanted = new Set(ids);
  if (!wanted.size) return wanted;
  const Department = await modelProvider.getDepartmentModel(tenantId);
  const rows = (await Department.findAll({ where: { tenantId }, attributes: ['id', 'parentDepartmentId'], raw: true })) as unknown as { id: string; parentDepartmentId: string | null }[];
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const before = wanted.size;
    for (const row of rows) if (row.parentDepartmentId && wanted.has(row.parentDepartmentId)) wanted.add(row.id);
    if (wanted.size === before) break;
  }
  return wanted;
};

/** The KPIs, tidied: an id each, nothing blank, and the weights adding up to 100. */
export const normalizeItems = (items: KpiItemDto[]): KpiItem[] =>
  items.map((item) => ({
    id: item.id ?? randomUUID(),
    title: item.title.trim(),
    description: item.description?.trim() || null,
    weight: item.weight,
    target: item.target?.trim() || null,
    unit: item.unit?.trim() || null,
    measurement: item.measurement ?? KpiMeasurement.NUMBER,
    category: item.category?.trim() || null,
  }));

export const weightTotal = (items: { weight: number }[]): number => items.reduce((sum, item) => sum + Number(item.weight || 0), 0);

/**
 * KPI templates, and which one fits someone. A template can name departments
 * (and the ones under them) and designations; the one that fits a person most
 * specifically is theirs (designation counts for more than department, and a
 * template with no criteria fits anyone). Templates only start a plan: a plan
 * keeps its own copy, so editing a template never rewrites one already made.
 */
@Injectable()
export class KpiTemplateService {
  private readonly logger = new Logger(KpiTemplateService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private view(row: any) {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description ?? null) as string | null,
      departmentIds: (Array.isArray(row.departmentIds) ? row.departmentIds : []) as string[],
      designationIds: (Array.isArray(row.designationIds) ? row.designationIds : []) as string[],
      items: (Array.isArray(row.items) ? row.items : []) as KpiItem[],
      isActive: row.isActive !== false,
      createdBy: (row.createdByEmail ?? null) as string | null,
    };
  }

  private async find(tenantId: string, id: string) {
    const Template = await this.modelProvider.getKpiTemplateModel(tenantId);
    const row: any = await Template.findOne({ where: { id, tenantId } });
    if (!row) this.fail(HttpStatus.NOT_FOUND, 'KPI template not found.');
    return row;
  }

  private async check(tenantId: string, next: { name: string; departmentIds: string[]; designationIds: string[]; items: KpiItem[] }, exceptId?: string) {
    if (weightTotal(next.items) !== 100) this.fail(HttpStatus.BAD_REQUEST, `The KPI weights add up to ${weightTotal(next.items)}. They must add up to 100.`);
    const Template = await this.modelProvider.getKpiTemplateModel(tenantId);
    const names = (await Template.findAll({ where: { tenantId }, attributes: ['id', 'name'], raw: true })) as unknown as { id: string; name: string }[];
    if (names.some((row) => row.id !== exceptId && row.name.trim().toLowerCase() === next.name.trim().toLowerCase())) this.fail(HttpStatus.CONFLICT, `There is already a template called ${next.name.trim()}.`);
    const exists = async (kind: 'Department' | 'Designation', ids: string[], label: string) => {
      if (!ids.length) return;
      const Model: any = kind === 'Department' ? await this.modelProvider.getDepartmentModel(tenantId) : await this.modelProvider.getDesignationModel(tenantId);
      if ((await Model.count({ where: { tenantId, id: { [Op.in]: ids } } })) !== ids.length) this.fail(HttpStatus.BAD_REQUEST, `A selected ${label} was not found in this organization.`);
    };
    await exists('Department', next.departmentIds, 'department');
    await exists('Designation', next.designationIds, 'designation');
  }

  async list(tenantId: string) {
    const Template = await this.modelProvider.getKpiTemplateModel(tenantId);
    const rows = (await Template.findAll({ where: { tenantId }, order: [['name', 'ASC']] })) as any[];
    return { data: rows.map((row) => this.view(row)) };
  }

  async get(tenantId: string, id: string) {
    return this.view(await this.find(tenantId, id));
  }

  async create(tenantId: string, dto: CreateKpiTemplateDto) {
    const next = { name: dto.name.trim(), departmentIds: [...new Set(dto.departmentIds ?? [])], designationIds: [...new Set(dto.designationIds ?? [])], items: normalizeItems(dto.items) };
    await this.check(tenantId, next);
    const Template = await this.modelProvider.getKpiTemplateModel(tenantId);
    const created: any = await Template.create({ tenantId, ...next, description: dto.description?.trim() || null, isActive: true, createdByEmail: currentRpcActor()?.email ?? null } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'kpi_templates', created.id, 'CREATE', { name: { from: null, to: created.name } });
    return this.view(created);
  }

  async update(tenantId: string, id: string, dto: UpdateKpiTemplateDto) {
    const row = await this.find(tenantId, id);
    const next = {
      name: dto.name !== undefined ? dto.name.trim() : row.name,
      departmentIds: dto.departmentIds !== undefined ? [...new Set(dto.departmentIds)] : row.departmentIds ?? [],
      designationIds: dto.designationIds !== undefined ? [...new Set(dto.designationIds)] : row.designationIds ?? [],
      items: dto.items !== undefined ? normalizeItems(dto.items) : (row.items as KpiItem[]),
    };
    await this.check(tenantId, next, id);
    await row.update({ ...next, ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}), ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'kpi_templates', id, 'UPDATE', { fields: { from: null, to: Object.keys(dto).join(',') } });
    return this.view(row);
  }

  async remove(tenantId: string, id: string) {
    const row = await this.find(tenantId, id);
    await row.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'kpi_templates', id, 'DELETE', { name: { from: row.name, to: null } });
    return { deleted: true, id };
  }

  /** The active template that fits this person best, or null. Ties go to the one made first. */
  async templateFor(tenantId: string, employee: { departmentId?: string | null; designationId?: string | null }): Promise<any | null> {
    const Template = await this.modelProvider.getKpiTemplateModel(tenantId);
    const rows = (await Template.findAll({ where: { tenantId, isActive: true } as any })) as any[];
    let best: { row: any; score: number } | null = null;
    for (const row of rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
      const departments: string[] = Array.isArray(row.departmentIds) ? row.departmentIds : [];
      const designations: string[] = Array.isArray(row.designationIds) ? row.designationIds : [];
      if (designations.length && !(employee.designationId && designations.includes(employee.designationId))) continue;
      if (departments.length) {
        const covered = await withSubDepartments(this.modelProvider, tenantId, departments);
        if (!(employee.departmentId && covered.has(employee.departmentId))) continue;
      }
      const score = (designations.length ? 2 : 0) + (departments.length ? 1 : 0);
      if (!best || score > best.score) best = { row, score };
    }
    return best?.row ?? null;
  }

  /** Which template a person would get, for HR to check before a cycle. */
  async match(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId }, attributes: ['id', 'departmentId', 'designationId'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found.');
    const template = await this.templateFor(tenantId, employee);
    return { employeeId, template: template ? this.view(template) : null };
  }

  /**
   * Gives a review the KPIs of the template that fits the person, as its own
   * copy. Returns how many. Nothing is added when no template fits. Best effort:
   * the review is already made.
   */
  async assignToReview(tenantId: string, review: { id: string; employeeId: string; cycleId?: string | null }, employee: any): Promise<{ templateId: string | null; count: number }> {
    try {
      const template = await this.templateFor(tenantId, employee);
      if (!template) return { templateId: null, count: 0 };
      const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
      const items = (Array.isArray(template.items) ? template.items : []) as KpiItem[];
      await Kpi.bulkCreate(
        items.map((item, index) => ({
          tenantId,
          employeeId: review.employeeId,
          reviewId: review.id,
          cycleId: review.cycleId ?? null,
          templateId: template.id,
          title: item.title,
          description: item.description ?? null,
          weight: item.weight,
          target: item.target ?? null,
          unit: item.unit ?? null,
          measurement: item.measurement ?? 'NUMBER',
          category: item.category ?? null,
          source: 'TEMPLATE',
          sortOrder: (index + 1) * 10,
        })) as any[],
      );
      return { templateId: template.id as string, count: items.length };
    } catch (error: any) {
      this.logger.warn(`KPIs were not assigned to review ${review.id}: ${error?.message ?? error}`);
      return { templateId: null, count: 0 };
    }
  }
}
