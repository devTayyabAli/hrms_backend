import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, QueryTypes, Transaction, UniqueConstraintError, literal } from 'sequelize';
import {
  AssetActorDto,
  AssetCondition,
  AssetMaintenanceType,
  AssetSpecificationDto,
  AssetStatus,
  AssignAssetDto,
  CompleteMaintenanceDto,
  CreateAssetCategoryDto,
  CreateAssetDto,
  DisposeAssetDto,
  EXPORT_MAX_ROWS,
  EmployeeStatus,
  ExportAssetsQueryDto,
  ExportResult,
  GetAssetsQueryDto,
  HandoverChecklistItemDto,
  ReturnAssetDto,
  StartMaintenanceDto,
  TenantErrorCode,
  TenantException,
  UpdateAssetCategoryDto,
  UpdateAssetDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

/** Who can be given an asset: people still employed. */
const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const CODE_PREFIX = 'AST-';
const CODE_RETRIES = 5;
const NOTE_MAX = 500;
/** An asset in one of these can be handed to someone (or taken from one holder and given to another). */
const ASSIGNABLE: string[] = [AssetStatus.AVAILABLE, AssetStatus.IN_USE];
/** An asset with a holder in one of these can be handed back. */
const RETURNABLE: string[] = [AssetStatus.IN_USE, AssetStatus.DAMAGED, AssetStatus.LOST];
/** Where an asset can be sent for maintenance or repair from. A lost asset cannot be repaired. */
const SERVICEABLE: string[] = [AssetStatus.AVAILABLE, AssetStatus.IN_USE, AssetStatus.DAMAGED];

/** The categories an organization starts with, the first time it opens Assets. */
export const DEFAULT_ASSET_CATEGORIES: { name: string; icon: string }[] = [
  { name: 'Laptop', icon: 'laptop' },
  { name: 'Monitor', icon: 'monitor' },
  { name: 'Mobile Phone', icon: 'smartphone' },
  { name: 'Furniture', icon: 'armchair' },
  { name: 'IT Equipment', icon: 'server' },
];

const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
const todayUtc = () => new Date().toISOString().slice(0, 10);

export interface AssetRow {
  id: string;
  assetCode: string;
  name: string;
  category: { id: string; name: string; icon: string | null } | null;
  brand: string | null;
  serialNumber: string | null;
  specifications: { key: string; value: string }[];
  status: AssetStatus;
  assignedTo: {
    employeeId: string;
    name: string;
    employeeCode: string | null;
    avatarUrl: string | null;
    department: { id: string; name: string } | null;
  } | null;
  assignedAt: Date | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  warrantyExpiry: string | null;
  vendor: string | null;
  location: string | null;
  notes: string | null;
  disposedAt: Date | null;
  disposalReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetHistoryRow {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  employee: { employeeId: string | null; name: string } | null;
  note: string | null;
  /** What was recorded with the event: the handover checklist and date, the condition on return, the maintenance job. */
  details: Record<string, unknown> | null;
  by: string | null;
  at: Date;
}

export interface MaintenanceRow {
  id: string;
  type: string;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  issue: string | null;
  vendor: string | null;
  estimatedCost: number | null;
  cost: number | null;
  startedOn: string;
  expectedOn: string | null;
  completedOn: string | null;
  resolution: string | null;
  startedBy: string | null;
  completedBy: string | null;
}

interface EventInput {
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  employeeId?: string | null;
  employeeName?: string | null;
  note?: string | null;
  details?: Record<string, unknown> | null;
}

const fullName = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');
const toNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/**
 * Assets: the company's equipment — what exists, who has it, what state it is in.
 *
 * An asset is AVAILABLE (in stock), IN_USE (an employee has it), under
 * MAINTENANCE, DAMAGED (broken, not yet being fixed), LOST, or DISPOSED
 * (finished: nobody has it and it cannot change any more). Damaged, lost and
 * maintenance keep the holder on record: it is their asset that broke or went
 * missing, and they get it back after a repair. Moving between states is done
 * through explicit actions, each of which writes a line in the asset's history,
 * which is also where the "since last month" figures on the page come from.
 *
 * Handing an asset over needs the handover checklist, fully ticked, and takes
 * the day it was handed over. A return says what condition it came back in.
 * Maintenance is a record of its own — the problem, the vendor, the cost, the
 * dates — not just a status.
 */
@Injectable()
export class AssetService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  // ==========================================
  // Errors
  // ==========================================

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private notFound(assetId: string): never {
    this.fail(HttpStatus.NOT_FOUND, `Asset '${assetId}' not found in this organization.`);
  }

  // ==========================================
  // Categories
  // ==========================================

  /** A brand-new organization has no categories; give it the usual ones so the page is usable straight away. */
  private async ensureCategories(tenantId: string) {
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    if ((await Category.count({ where: { tenantId } })) > 0) return;
    for (const [index, category] of DEFAULT_ASSET_CATEGORIES.entries()) {
      try {
        await Category.create({ tenantId, ...category, sortOrder: index } as any);
      } catch (error) {
        // Two first visits at once: the other one already made it.
        if (!(error instanceof UniqueConstraintError)) throw error;
      }
    }
  }

  private async assetCountsByCategory(tenantId: string): Promise<Map<string, number>> {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const rows = (await Asset.sequelize!.query(
      `SELECT "categoryId" AS "categoryId", COUNT(*)::int AS "count" FROM assets WHERE "tenantId" = :tenantId GROUP BY "categoryId"`,
      { replacements: { tenantId }, type: QueryTypes.SELECT },
    )) as { categoryId: string; count: number }[];
    return new Map(rows.map((row) => [row.categoryId, Number(row.count)]));
  }

  /** The categories with how many assets each holds — the Categories panel, and the picker in the Add Asset form. */
  async getCategories(tenantId: string) {
    await this.ensureCategories(tenantId);
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const [categories, counts] = await Promise.all([
      Category.findAll({ where: { tenantId }, order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
      this.assetCountsByCategory(tenantId),
    ]);
    return {
      data: (categories as any[]).map((category) => ({
        id: category.id,
        name: category.name,
        icon: category.icon ?? null,
        assetCount: counts.get(category.id) ?? 0,
      })),
    };
  }

  private async assertCategoryNameFree(tenantId: string, name: string, exceptId?: string) {
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const clash = await Category.findOne({
      where: { tenantId, name: { [Op.iLike]: ESCAPE(name) }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
      attributes: ['id'],
    });
    if (clash) this.fail(HttpStatus.CONFLICT, `A category named '${name}' already exists.`);
  }

  async createCategory(actor: AssetActorDto, dto: CreateAssetCategoryDto) {
    const { tenantId } = actor;
    await this.ensureCategories(tenantId);
    const name = dto.name.trim();
    await this.assertCategoryNameFree(tenantId, name);
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const last: any = await Category.findOne({ where: { tenantId }, order: [['sortOrder', 'DESC']], attributes: ['sortOrder'] });
    try {
      const created: any = await Category.create({ tenantId, name, icon: dto.icon ?? null, sortOrder: (last?.sortOrder ?? -1) + 1 } as any);
      return { id: created.id, name: created.name, icon: created.icon ?? null, assetCount: 0 };
    } catch (error) {
      if (error instanceof UniqueConstraintError) this.fail(HttpStatus.CONFLICT, `A category named '${name}' already exists.`);
      throw error;
    }
  }

  async updateCategory(actor: AssetActorDto, categoryId: string, dto: UpdateAssetCategoryDto) {
    const { tenantId } = actor;
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const category: any = await Category.findOne({ where: { id: categoryId, tenantId } });
    if (!category) this.fail(HttpStatus.NOT_FOUND, `Category '${categoryId}' not found in this organization.`);

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      await this.assertCategoryNameFree(tenantId, name, categoryId);
      patch.name = name;
    }
    if (dto.icon !== undefined) patch.icon = dto.icon;
    try {
      await category.update(patch);
    } catch (error) {
      if (error instanceof UniqueConstraintError) this.fail(HttpStatus.CONFLICT, `A category named '${dto.name}' already exists.`);
      throw error;
    }
    const counts = await this.assetCountsByCategory(tenantId);
    return { id: category.id, name: category.name, icon: category.icon ?? null, assetCount: counts.get(category.id) ?? 0 };
  }

  async deleteCategory(actor: AssetActorDto, categoryId: string) {
    const { tenantId } = actor;
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const category: any = await Category.findOne({ where: { id: categoryId, tenantId } });
    if (!category) this.fail(HttpStatus.NOT_FOUND, `Category '${categoryId}' not found in this organization.`);

    const inUse = await Asset.count({ where: { tenantId, categoryId } });
    if (inUse > 0) {
      this.fail(HttpStatus.CONFLICT, `'${category.name}' has ${inUse} asset${inUse === 1 ? '' : 's'}. Move or delete them first.`);
    }
    await category.destroy();
    return { deleted: true, id: categoryId };
  }

  // ==========================================
  // Reading assets
  // ==========================================

  private async includes(tenantId: string) {
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    return [
      { model: Category, as: 'category', attributes: ['id', 'name', 'icon'], required: false },
      {
        model: Employee,
        as: 'assignee',
        attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl', 'departmentId'],
        required: false,
        include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
      },
    ];
  }

  private toRow(asset: any): AssetRow {
    const assignee = asset.assignee;
    return {
      id: asset.id,
      assetCode: asset.assetCode,
      name: asset.name,
      category: asset.category ? { id: asset.category.id, name: asset.category.name, icon: asset.category.icon ?? null } : null,
      brand: asset.brand ?? null,
      serialNumber: asset.serialNumber ?? null,
      specifications: Array.isArray(asset.specifications) ? asset.specifications : [],
      status: asset.status,
      assignedTo: assignee
        ? {
            employeeId: assignee.id,
            name: fullName(assignee),
            employeeCode: assignee.employeeCode ?? null,
            avatarUrl: assignee.avatarUrl ?? null,
            department: assignee.department ? { id: assignee.department.id, name: assignee.department.name } : null,
          }
        : null,
      assignedAt: asset.assignedAt ?? null,
      purchaseDate: asset.purchaseDate ?? null,
      purchaseCost: toNumber(asset.purchaseCost),
      warrantyExpiry: asset.warrantyExpiry ?? null,
      vendor: asset.vendor ?? null,
      location: asset.location ?? null,
      notes: asset.notes ?? null,
      disposedAt: asset.disposedAt ?? null,
      disposalReason: asset.disposalReason ?? null,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  }

  private buildWhere(tenantId: string, query: ExportAssetsQueryDto) {
    const where: Record<string | symbol, unknown> = { tenantId };
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.assignedEmployeeId) where.assignedEmployeeId = query.assignedEmployeeId;
    // The department of whoever has it: an unassigned asset has none.
    if (query.departmentId) where['$assignee.departmentId$'] = query.departmentId;

    const term = query.search?.trim();
    if (term) {
      const like = `%${ESCAPE(term)}%`;
      where[Op.or] = [
        { name: { [Op.iLike]: like } },
        { assetCode: { [Op.iLike]: like } },
        { serialNumber: { [Op.iLike]: like } },
        { brand: { [Op.iLike]: like } },
        { '$assignee.firstName$': { [Op.iLike]: like } },
        { '$assignee.lastName$': { [Op.iLike]: like } },
      ];
    }
    return where;
  }

  private buildOrder(query: ExportAssetsQueryDto): any[] {
    const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    switch (query.sortBy) {
      case 'name':
        return [['name', direction], ['createdAt', 'DESC']];
      case 'assetCode':
        return [['assetCode', direction]];
      case 'serialNumber':
        return [['serialNumber', direction], ['createdAt', 'DESC']];
      case 'status':
        return [['status', direction], ['name', 'ASC']];
      case 'purchaseDate':
        return [['purchaseDate', direction], ['createdAt', 'DESC']];
      case 'category':
        return [[literal('"category"."name"'), direction], ['name', 'ASC']];
      case 'assignedTo':
        return [[literal('"assignee"."firstName"'), direction], [literal('"assignee"."lastName"'), direction], ['name', 'ASC']];
      default:
        return [['createdAt', direction], ['id', 'ASC']];
    }
  }

  /** The asset table: filtered, searched, sorted and paged. */
  async getAssets(tenantId: string, query: GetAssetsQueryDto = {}) {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;

    const { rows, count } = await Asset.findAndCountAll({
      where: this.buildWhere(tenantId, query) as any,
      include: await this.includes(tenantId),
      order: this.buildOrder(query),
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return {
      data: (rows as any[]).map((asset) => this.toRow(asset)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /** Every asset matching the filters, up to the export cap. */
  async exportAssets(tenantId: string, query: ExportAssetsQueryDto = {}): Promise<ExportResult<AssetRow>> {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const { rows, count } = await Asset.findAndCountAll({
      where: this.buildWhere(tenantId, query) as any,
      include: await this.includes(tenantId),
      order: this.buildOrder(query),
      limit: EXPORT_MAX_ROWS,
      distinct: true,
    });
    return {
      rows: (rows as any[]).map((asset) => this.toRow(asset)),
      totalMatched: count,
      truncated: count > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  private async loadFull(tenantId: string, assetId: string) {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const asset = await Asset.findOne({ where: { id: assetId, tenantId }, include: await this.includes(tenantId) });
    if (!asset) this.notFound(assetId);
    return asset;
  }

  private async history(tenantId: string, assetId: string): Promise<AssetHistoryRow[]> {
    const Event = await this.modelProvider.getAssetEventModel(tenantId);
    const events = (await Event.findAll({ where: { tenantId, assetId }, order: [['createdAt', 'DESC'], ['id', 'ASC']], limit: 200 })) as any[];
    return events.map((event) => ({
      id: event.id,
      type: event.type,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      employee: event.employeeName ? { employeeId: event.employeeId ?? null, name: event.employeeName } : null,
      note: event.note ?? null,
      details: event.details ?? null,
      by: event.actorEmail ?? null,
      at: event.createdAt,
    }));
  }

  private toMaintenanceRow(record: any): MaintenanceRow {
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      issue: record.issue ?? null,
      vendor: record.vendor ?? null,
      estimatedCost: toNumber(record.estimatedCost),
      cost: toNumber(record.cost),
      startedOn: record.startedOn,
      expectedOn: record.expectedOn ?? null,
      completedOn: record.completedOn ?? null,
      resolution: record.resolution ?? null,
      startedBy: record.startedBy ?? null,
      completedBy: record.completedBy ?? null,
    };
  }

  /** The asset's maintenance and repair jobs, the one in progress (if any) first and then newest. */
  private async maintenance(tenantId: string, assetId: string): Promise<MaintenanceRow[]> {
    const Maintenance = await this.modelProvider.getAssetMaintenanceModel(tenantId);
    const records = (await Maintenance.findAll({ where: { tenantId, assetId }, order: [['startedOn', 'DESC'], ['createdAt', 'DESC']], limit: 100 })) as any[];
    const rows = records.map((record) => this.toMaintenanceRow(record));
    return [...rows.filter((row) => row.status === 'OPEN'), ...rows.filter((row) => row.status !== 'OPEN')];
  }

  /** One asset with everything on it, its maintenance jobs and its history, newest first. */
  async getAsset(tenantId: string, assetId: string) {
    return this.serialize(tenantId, assetId);
  }

  // ==========================================
  // The page header and side panels
  // ==========================================

  /** Status counts as they stood at a moment, worked out from the history. */
  private async statusCountsAt(tenantId: string, moment: Date): Promise<Map<string, number>> {
    const Event = await this.modelProvider.getAssetEventModel(tenantId);
    const rows = (await Event.sequelize!.query(
      `SELECT latest."toStatus" AS "status", COUNT(*)::int AS "count"
         FROM (
           SELECT DISTINCT ON ("assetId") "assetId", "toStatus"
             FROM asset_events
            WHERE "tenantId" = :tenantId AND "toStatus" IS NOT NULL AND "createdAt" < :moment
            ORDER BY "assetId", "createdAt" DESC, id DESC
         ) latest
         JOIN assets a ON a.id = latest."assetId"
        GROUP BY latest."toStatus"`,
      { replacements: { tenantId, moment }, type: QueryTypes.SELECT },
    )) as { status: string; count: number }[];
    return new Map(rows.map((row) => [row.status, Number(row.count)]));
  }

  private change(current: number, previous: number) {
    return {
      value: current,
      previous,
      // Growth since the start of the month; unknown when there was nothing to compare with.
      changePercent: previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
    };
  }

  /**
   * The cards, the status donut and the Categories panel in one call.
   * "Last month" is the state at the start of this month, so the change shown
   * is what happened since then.
   */
  async getSummary(tenantId: string) {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [current, previous, categories] = await Promise.all([
      Asset.sequelize!.query(
        `SELECT status, COUNT(*)::int AS "count" FROM assets WHERE "tenantId" = :tenantId GROUP BY status`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ) as Promise<{ status: string; count: number }[]>,
      this.statusCountsAt(tenantId, monthStart),
      this.getCategories(tenantId),
    ]);

    const nowCounts = new Map(current.map((row) => [row.status, Number(row.count)]));
    const count = (status: AssetStatus) => nowCounts.get(status) ?? 0;
    const before = (status: AssetStatus) => previous.get(status) ?? 0;
    const total = [...nowCounts.values()].reduce((sum, value) => sum + value, 0);
    const totalBefore = [...previous.values()].reduce((sum, value) => sum + value, 0);

    return {
      stats: {
        total: this.change(total, totalBefore),
        inUse: this.change(count(AssetStatus.IN_USE), before(AssetStatus.IN_USE)),
        available: this.change(count(AssetStatus.AVAILABLE), before(AssetStatus.AVAILABLE)),
        maintenance: this.change(count(AssetStatus.MAINTENANCE), before(AssetStatus.MAINTENANCE)),
        damaged: this.change(count(AssetStatus.DAMAGED), before(AssetStatus.DAMAGED)),
        lost: this.change(count(AssetStatus.LOST), before(AssetStatus.LOST)),
        disposed: this.change(count(AssetStatus.DISPOSED), before(AssetStatus.DISPOSED)),
      },
      // The donut: every status with its share.
      statusBreakdown: [
        AssetStatus.IN_USE,
        AssetStatus.AVAILABLE,
        AssetStatus.MAINTENANCE,
        AssetStatus.DAMAGED,
        AssetStatus.LOST,
        AssetStatus.DISPOSED,
      ].map((status) => ({
        status,
        count: count(status),
        percent: total > 0 ? Math.round((count(status) / total) * 1000) / 10 : 0,
      })),
      total,
      categories: categories.data,
      comparedWith: monthStart.toISOString(),
    };
  }

  // ==========================================
  // Writing: helpers
  // ==========================================

  private async nextAssetCode(tenantId: string, transaction: Transaction): Promise<string> {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const [row] = (await Asset.sequelize!.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING("assetCode" FROM ${CODE_PREFIX.length + 1}) AS INTEGER)), 0) + 1 AS "next"
         FROM assets WHERE "tenantId" = :tenantId AND "assetCode" ~ '^${CODE_PREFIX}[0-9]+$'`,
      { replacements: { tenantId }, type: QueryTypes.SELECT, transaction },
    )) as { next: number }[];
    return `${CODE_PREFIX}${String(Number(row?.next ?? 1)).padStart(4, '0')}`;
  }

  private async assertSerialFree(tenantId: string, serialNumber: string | null | undefined, exceptId?: string) {
    if (!serialNumber) return;
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const clash = await Asset.findOne({
      where: { tenantId, serialNumber: { [Op.iLike]: ESCAPE(serialNumber) }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
      attributes: ['id', 'assetCode'],
    });
    if (clash) this.fail(HttpStatus.CONFLICT, `Serial number '${serialNumber}' is already used by ${(clash as any).assetCode}.`);
  }

  private async assertCategory(tenantId: string, categoryId: string) {
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    if (!(await Category.findOne({ where: { id: categoryId, tenantId }, attributes: ['id'] }))) {
      this.fail(HttpStatus.BAD_REQUEST, 'Pick a category from this organization\'s categories.');
    }
  }

  /** Someone who can be given an asset: an employee who still works here. */
  private async loadAssignee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({
      where: { id: employeeId, tenantId },
      attributes: ['id', 'firstName', 'lastName', 'status'],
    });
    if (!employee) this.fail(HttpStatus.BAD_REQUEST, 'That employee was not found in this organization.');
    if (!EMPLOYED.includes(employee.status)) {
      this.fail(HttpStatus.CONFLICT, `${fullName(employee)} no longer works here, so can't be given an asset.`);
    }
    return employee;
  }

  /** Specifications are a list of name / value pairs; the same name twice is a mistake, not two specs. */
  private cleanSpecifications(specifications: AssetSpecificationDto[] | undefined) {
    if (specifications === undefined) return undefined;
    const seen = new Set<string>();
    return specifications.map(({ key, value }) => {
      const name = key.trim();
      if (seen.has(name.toLowerCase())) this.fail(HttpStatus.BAD_REQUEST, `The specification '${name}' is listed twice.`);
      seen.add(name.toLowerCase());
      return { key: name, value: value.trim() };
    });
  }

  /**
   * The rules for handing an asset over: every item on the checklist ticked,
   * and a handover day that is not in the future. Returns the moment to record
   * as "assigned at" — now for today, otherwise the start of that day.
   */
  private assertHandover(checklist: HandoverChecklistItemDto[] | undefined, assignedOn: string | null | undefined) {
    if (!checklist?.length) {
      this.fail(HttpStatus.BAD_REQUEST, 'Complete the handover checklist before handing the asset over.');
    }
    const unticked = checklist.filter((item) => !item.checked).map((item) => item.item.trim());
    if (unticked.length) {
      this.fail(HttpStatus.BAD_REQUEST, `Tick every item on the handover checklist (still open: ${unticked.join('; ')}).`);
    }
    const day = assignedOn || todayUtc();
    if (day > todayUtc()) this.fail(HttpStatus.BAD_REQUEST, 'The handover date cannot be in the future.');
    return {
      assignedAt: day === todayUtc() ? new Date() : new Date(`${day}T00:00:00.000Z`),
      details: { assignedOn: day, checklist: checklist.map((item) => ({ item: item.item.trim(), checked: true })) },
    };
  }

  /**
   * History lines for one action. Their timestamps are spaced a millisecond
   * apart so "the latest event" is unambiguous when an action writes several.
   */
  private async record(tenantId: string, actor: AssetActorDto, assetId: string, events: EventInput[], transaction: Transaction) {
    const Event = await this.modelProvider.getAssetEventModel(tenantId);
    const base = Date.now();
    await Event.bulkCreate(
      events.map((event, index) => ({
        tenantId,
        assetId,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        employeeId: event.employeeId ?? null,
        employeeName: event.employeeName ?? null,
        note: event.note ? event.note.slice(0, NOTE_MAX) : null,
        details: event.details ?? null,
        actorUserId: actor.userId ?? null,
        actorEmail: actor.email ?? null,
        createdAt: new Date(base + index),
      })) as any[],
      { transaction },
    );
  }

  private async loadForAction(tenantId: string, assetId: string, transaction: Transaction) {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const asset: any = await Asset.findOne({ where: { id: assetId, tenantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!asset) this.notFound(assetId);
    return asset;
  }

  private async holderName(tenantId: string, employeeId: string | null) {
    if (!employeeId) return null;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId }, attributes: ['firstName', 'lastName'] });
    return employee ? fullName(employee) : null;
  }

  /** The job the asset is away for, if it is away. */
  private async openJob(tenantId: string, assetId: string, transaction: Transaction) {
    const Maintenance = await this.modelProvider.getAssetMaintenanceModel(tenantId);
    return (await Maintenance.findOne({ where: { tenantId, assetId, status: 'OPEN' }, transaction })) as any;
  }

  /** A job that ends because the asset was written off or lost, not because it was fixed. */
  private async cancelOpenJob(tenantId: string, assetId: string, actor: AssetActorDto, reason: string, transaction: Transaction) {
    const job = await this.openJob(tenantId, assetId, transaction);
    if (job) {
      await job.update({ status: 'CANCELLED', completedOn: todayUtc(), resolution: reason, completedBy: actor.email ?? null }, { transaction });
    }
  }

  private async serialize(tenantId: string, assetId: string) {
    return {
      ...this.toRow(await this.loadFull(tenantId, assetId)),
      maintenance: await this.maintenance(tenantId, assetId),
      history: await this.history(tenantId, assetId),
    };
  }

  // ==========================================
  // Writing: assets
  // ==========================================

  async createAsset(actor: AssetActorDto, dto: CreateAssetDto) {
    const { tenantId } = actor;
    await this.assertCategory(tenantId, dto.categoryId);
    await this.assertSerialFree(tenantId, dto.serialNumber);
    const specifications = this.cleanSpecifications(dto.specifications);
    const assignee = dto.assignedEmployeeId ? await this.loadAssignee(tenantId, dto.assignedEmployeeId) : null;
    // Giving it to someone from the start is still a handover: same checklist, same date rules.
    const handover = assignee ? this.assertHandover(dto.checklist, dto.assignedOn) : null;

    const Asset = await this.modelProvider.getAssetModel(tenantId);
    for (let attempt = 1; ; attempt++) {
      try {
        const id = await Asset.sequelize!.transaction(async (transaction) => {
          const status = assignee ? AssetStatus.IN_USE : AssetStatus.AVAILABLE;
          const created: any = await Asset.create(
            {
              tenantId,
              assetCode: await this.nextAssetCode(tenantId, transaction),
              name: dto.name.trim(),
              categoryId: dto.categoryId,
              brand: dto.brand ?? null,
              serialNumber: dto.serialNumber ?? null,
              specifications: specifications ?? null,
              status,
              assignedEmployeeId: assignee?.id ?? null,
              assignedAt: handover?.assignedAt ?? null,
              purchaseDate: dto.purchaseDate ?? null,
              purchaseCost: dto.purchaseCost ?? null,
              warrantyExpiry: dto.warrantyExpiry ?? null,
              vendor: dto.vendor ?? null,
              location: dto.location ?? null,
              notes: dto.notes ?? null,
              createdBy: actor.userId ?? null,
            } as any,
            { transaction },
          );
          await this.record(
            tenantId,
            actor,
            created.id,
            [
              { type: 'CREATED', fromStatus: null, toStatus: AssetStatus.AVAILABLE },
              ...(assignee
                ? [{
                    type: 'ASSIGNED',
                    fromStatus: AssetStatus.AVAILABLE,
                    toStatus: AssetStatus.IN_USE,
                    employeeId: assignee.id,
                    employeeName: fullName(assignee),
                    details: handover!.details,
                  }]
                : []),
            ],
            transaction,
          );
          return created.id as string;
        });
        return this.serialize(tenantId, id);
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          const fields = Object.keys((error as any).fields ?? {});
          if (fields.includes('serialNumber')) this.fail(HttpStatus.CONFLICT, `Serial number '${dto.serialNumber}' is already used by another asset.`);
          // Two people added an asset at once and drew the same code: take the next one.
          if (attempt < CODE_RETRIES) continue;
        }
        throw error;
      }
    }
  }

  async updateAsset(actor: AssetActorDto, assetId: string, dto: UpdateAssetDto) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const asset: any = await Asset.findOne({ where: { id: assetId, tenantId } });
    if (!asset) this.notFound(assetId);
    if (asset.status === AssetStatus.DISPOSED) this.fail(HttpStatus.CONFLICT, 'A disposed asset can no longer be edited.');

    if (dto.categoryId !== undefined) await this.assertCategory(tenantId, dto.categoryId);
    if (dto.serialNumber !== undefined) await this.assertSerialFree(tenantId, dto.serialNumber, assetId);

    const patch: Record<string, unknown> = {};
    for (const field of ['categoryId', 'brand', 'serialNumber', 'purchaseDate', 'purchaseCost', 'warrantyExpiry', 'vendor', 'location', 'notes'] as const) {
      if ((dto as any)[field] !== undefined) patch[field] = (dto as any)[field];
    }
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.specifications !== undefined) patch.specifications = this.cleanSpecifications(dto.specifications);

    try {
      await asset.update(patch);
    } catch (error) {
      if (error instanceof UniqueConstraintError) this.fail(HttpStatus.CONFLICT, `Serial number '${dto.serialNumber}' is already used by another asset.`);
      throw error;
    }
    return this.serialize(tenantId, assetId);
  }

  /** Gone for good. Not while someone has it: it would vanish from their hands without a trace. */
  async deleteAsset(actor: AssetActorDto, assetId: string) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const asset: any = await Asset.findOne({ where: { id: assetId, tenantId } });
    if (!asset) this.notFound(assetId);
    if (asset.assignedEmployeeId) {
      this.fail(HttpStatus.CONFLICT, 'Someone still has this asset. Return it before deleting it.');
    }
    await asset.destroy();
    return { deleted: true, id: assetId };
  }

  // ==========================================
  // Writing: actions that change where an asset is
  // ==========================================

  /** Gives the asset to an employee, on the checklist and day given. If someone else had it, it is taken from them first. */
  async assign(actor: AssetActorDto, assetId: string, dto: AssignAssetDto) {
    const { tenantId } = actor;
    const employee = await this.loadAssignee(tenantId, dto.employeeId);
    const handover = this.assertHandover(dto.checklist, dto.assignedOn);
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (!ASSIGNABLE.includes(asset.status)) {
        const reason: Record<string, string> = {
          [AssetStatus.DISPOSED]: 'A disposed asset cannot be assigned.',
          [AssetStatus.MAINTENANCE]: 'This asset is under maintenance. Finish the maintenance before assigning it.',
          [AssetStatus.DAMAGED]: 'This asset is damaged. Repair it before assigning it.',
          [AssetStatus.LOST]: 'This asset is lost, so it cannot be assigned.',
        };
        this.fail(HttpStatus.CONFLICT, reason[asset.status] ?? 'This asset cannot be assigned right now.');
      }
      if (asset.assignedEmployeeId === employee.id) this.fail(HttpStatus.CONFLICT, `${fullName(employee)} already has this asset.`);

      const events: EventInput[] = [];
      if (asset.assignedEmployeeId) {
        events.push({
          type: 'RETURNED',
          fromStatus: AssetStatus.IN_USE,
          toStatus: AssetStatus.AVAILABLE,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note: 'Reassigned to someone else',
        });
      }
      events.push({
        type: 'ASSIGNED',
        fromStatus: asset.assignedEmployeeId ? AssetStatus.AVAILABLE : asset.status,
        toStatus: AssetStatus.IN_USE,
        employeeId: employee.id,
        employeeName: fullName(employee),
        note: dto.note,
        details: handover.details,
      });

      await asset.update({ status: AssetStatus.IN_USE, assignedEmployeeId: employee.id, assignedAt: handover.assignedAt }, { transaction });
      await this.record(tenantId, actor, assetId, events, transaction);
    });
    return this.serialize(tenantId, assetId);
  }

  /**
   * The employee hands it back, and says what state it is in: good or fair, it
   * is in stock again; damaged, it is Damaged until it has been repaired. A lost
   * asset that turns up is returned the same way.
   */
  async returnAsset(actor: AssetActorDto, assetId: string, dto: ReturnAssetDto) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (!RETURNABLE.includes(asset.status) || !asset.assignedEmployeeId) {
        this.fail(HttpStatus.CONFLICT, 'Only an asset that someone has can be returned.');
      }
      const next = dto.condition === AssetCondition.DAMAGED ? AssetStatus.DAMAGED : AssetStatus.AVAILABLE;
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'RETURNED',
          fromStatus: asset.status,
          toStatus: next,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note: dto.note,
          details: { condition: dto.condition },
        }],
        transaction,
      );
      await asset.update({ status: next, assignedEmployeeId: null, assignedAt: null }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  /** Reported broken. Whoever has it keeps it on record until it is returned or repaired. */
  async markDamaged(actor: AssetActorDto, assetId: string, note?: string | null) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status === AssetStatus.DAMAGED) this.fail(HttpStatus.CONFLICT, 'This asset is already marked as damaged.');
      if (![AssetStatus.AVAILABLE, AssetStatus.IN_USE].includes(asset.status)) {
        this.fail(HttpStatus.CONFLICT, `An asset that is ${asset.status === AssetStatus.MAINTENANCE ? 'under maintenance' : asset.status.toLowerCase()} cannot be marked as damaged.`);
      }
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'DAMAGED',
          fromStatus: asset.status,
          toStatus: AssetStatus.DAMAGED,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note,
        }],
        transaction,
      );
      await asset.update({ status: AssetStatus.DAMAGED }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  /** Cannot be found. Whoever had it stays on record, so the loss can be followed up. */
  async markLost(actor: AssetActorDto, assetId: string, note?: string | null) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status === AssetStatus.LOST) this.fail(HttpStatus.CONFLICT, 'This asset is already marked as lost.');
      if (asset.status === AssetStatus.DISPOSED) this.fail(HttpStatus.CONFLICT, 'A disposed asset cannot be marked as lost.');
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'LOST',
          fromStatus: asset.status,
          toStatus: AssetStatus.LOST,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note,
        }],
        transaction,
      );
      if (asset.status === AssetStatus.MAINTENANCE) {
        await this.cancelOpenJob(tenantId, assetId, actor, 'Asset was reported lost', transaction);
      }
      await asset.update({ status: AssetStatus.LOST }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  // ==========================================
  // Writing: maintenance
  // ==========================================

  /** Sent for service or repair: opens a job with what is wrong, who is fixing it and what it should cost. The holder, if any, stays on record. */
  async startMaintenance(actor: AssetActorDto, assetId: string, dto: StartMaintenanceDto) {
    const { tenantId } = actor;
    const startedOn = dto.startedOn || todayUtc();
    if (startedOn > todayUtc()) this.fail(HttpStatus.BAD_REQUEST, 'The start date cannot be in the future.');
    if (dto.expectedOn && dto.expectedOn < startedOn) this.fail(HttpStatus.BAD_REQUEST, 'The expected return date cannot be before the start date.');
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Maintenance = await this.modelProvider.getAssetMaintenanceModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status === AssetStatus.MAINTENANCE) this.fail(HttpStatus.CONFLICT, 'This asset is already under maintenance.');
      if (!SERVICEABLE.includes(asset.status)) {
        this.fail(HttpStatus.CONFLICT, `${asset.status === AssetStatus.DISPOSED ? 'A disposed' : 'A lost'} asset cannot go for maintenance.`);
      }
      const job: any = await Maintenance.create(
        {
          tenantId,
          assetId,
          type: dto.type ?? AssetMaintenanceType.REPAIR,
          status: 'OPEN',
          issue: dto.issue ?? null,
          vendor: dto.vendor ?? null,
          estimatedCost: dto.estimatedCost ?? null,
          startedOn,
          expectedOn: dto.expectedOn ?? null,
          startedBy: actor.email ?? null,
        } as any,
        { transaction },
      );
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'MAINTENANCE_STARTED',
          fromStatus: asset.status,
          toStatus: AssetStatus.MAINTENANCE,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note: dto.issue,
          details: { maintenanceId: job.id, type: job.type, vendor: dto.vendor ?? null },
        }],
        transaction,
      );
      await asset.update({ status: AssetStatus.MAINTENANCE }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  /** Back from service: closes the job with what was done and what it cost. With its holder the asset is in use again, otherwise it goes back to stock. */
  async completeMaintenance(actor: AssetActorDto, assetId: string, dto: CompleteMaintenanceDto) {
    const { tenantId } = actor;
    const completedOn = dto.completedOn || todayUtc();
    if (completedOn > todayUtc()) this.fail(HttpStatus.BAD_REQUEST, 'The completion date cannot be in the future.');
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status !== AssetStatus.MAINTENANCE) this.fail(HttpStatus.CONFLICT, 'This asset is not under maintenance.');

      const job = await this.openJob(tenantId, assetId, transaction);
      if (job && completedOn < job.startedOn) this.fail(HttpStatus.BAD_REQUEST, 'The completion date cannot be before the maintenance started.');
      if (job) {
        await job.update(
          { status: 'COMPLETED', completedOn, cost: dto.cost ?? null, resolution: dto.resolution ?? null, completedBy: actor.email ?? null },
          { transaction },
        );
      }

      const next = asset.assignedEmployeeId ? AssetStatus.IN_USE : AssetStatus.AVAILABLE;
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'MAINTENANCE_COMPLETED',
          fromStatus: AssetStatus.MAINTENANCE,
          toStatus: next,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note: dto.resolution,
          details: { maintenanceId: job?.id ?? null, cost: dto.cost ?? null },
        }],
        transaction,
      );
      await asset.update({ status: next }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  /** Written off. Nobody has it any more and it cannot be changed again. */
  async dispose(actor: AssetActorDto, assetId: string, dto: DisposeAssetDto) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status === AssetStatus.DISPOSED) this.fail(HttpStatus.CONFLICT, 'This asset is already disposed.');
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'DISPOSED',
          fromStatus: asset.status,
          toStatus: AssetStatus.DISPOSED,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note: dto.reason,
        }],
        transaction,
      );
      if (asset.status === AssetStatus.MAINTENANCE) {
        await this.cancelOpenJob(tenantId, assetId, actor, 'Asset was disposed of', transaction);
      }
      await asset.update(
        {
          status: AssetStatus.DISPOSED,
          assignedEmployeeId: null,
          assignedAt: null,
          disposedAt: new Date(),
          disposalReason: dto.reason ?? null,
        },
        { transaction },
      );
    });
    return this.serialize(tenantId, assetId);
  }
}
