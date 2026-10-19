import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, QueryTypes, Transaction, UniqueConstraintError, literal } from 'sequelize';
import {
  AssetActorDto,
  AssetStatus,
  AssignAssetDto,
  CreateAssetCategoryDto,
  CreateAssetDto,
  DisposeAssetDto,
  EXPORT_MAX_ROWS,
  EmployeeStatus,
  ExportAssetsQueryDto,
  ExportResult,
  GetAssetsQueryDto,
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

/** The categories an organization starts with, the first time it opens Assets. */
export const DEFAULT_ASSET_CATEGORIES: { name: string; icon: string }[] = [
  { name: 'Laptop', icon: 'laptop' },
  { name: 'Monitor', icon: 'monitor' },
  { name: 'Mobile Phone', icon: 'smartphone' },
  { name: 'Furniture', icon: 'armchair' },
  { name: 'IT Equipment', icon: 'server' },
];

const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export interface AssetRow {
  id: string;
  assetCode: string;
  name: string;
  category: { id: string; name: string; icon: string | null } | null;
  brand: string | null;
  serialNumber: string | null;
  status: AssetStatus;
  assignedTo: { employeeId: string; name: string; employeeCode: string | null; avatarUrl: string | null } | null;
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
  by: string | null;
  at: Date;
}

interface EventInput {
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  employeeId?: string | null;
  employeeName?: string | null;
  note?: string | null;
}

const fullName = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');

/**
 * Assets: the company's equipment — what exists, who has it, what state it is in.
 *
 * An asset is AVAILABLE (in stock), IN_USE (an employee has it), in
 * MAINTENANCE (it keeps its holder, who will get it back) or DISPOSED
 * (finished: nobody has it and it cannot change any more). Moving between
 * those is done through explicit actions — assign, return, start / finish
 * maintenance, dispose — each of which writes a line in the asset's history,
 * which is also where the "since last month" figures on the page come from.
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
    return [
      { model: Category, as: 'category', attributes: ['id', 'name', 'icon'], required: false },
      { model: Employee, as: 'assignee', attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl'], required: false },
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
      status: asset.status,
      assignedTo: assignee
        ? { employeeId: assignee.id, name: fullName(assignee), employeeCode: assignee.employeeCode ?? null, avatarUrl: assignee.avatarUrl ?? null }
        : null,
      assignedAt: asset.assignedAt ?? null,
      purchaseDate: asset.purchaseDate ?? null,
      purchaseCost: asset.purchaseCost === null || asset.purchaseCost === undefined ? null : Number(asset.purchaseCost),
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
      by: event.actorEmail ?? null,
      at: event.createdAt,
    }));
  }

  /** One asset with everything on it and its history, newest first. */
  async getAsset(tenantId: string, assetId: string) {
    const asset = await this.loadFull(tenantId, assetId);
    return { ...this.toRow(asset), history: await this.history(tenantId, assetId) };
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
   * The four cards, the status donut and the Categories panel in one call.
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

    const now_ = new Map(current.map((row) => [row.status, Number(row.count)]));
    const count = (status: AssetStatus) => now_.get(status) ?? 0;
    const before = (status: AssetStatus) => previous.get(status) ?? 0;
    const total = [...now_.values()].reduce((sum, value) => sum + value, 0);
    const totalBefore = [...previous.values()].reduce((sum, value) => sum + value, 0);

    return {
      stats: {
        total: this.change(total, totalBefore),
        inUse: this.change(count(AssetStatus.IN_USE), before(AssetStatus.IN_USE)),
        maintenance: this.change(count(AssetStatus.MAINTENANCE), before(AssetStatus.MAINTENANCE)),
        disposed: this.change(count(AssetStatus.DISPOSED), before(AssetStatus.DISPOSED)),
        available: this.change(count(AssetStatus.AVAILABLE), before(AssetStatus.AVAILABLE)),
      },
      // The donut: every status with its share.
      statusBreakdown: [AssetStatus.IN_USE, AssetStatus.MAINTENANCE, AssetStatus.DISPOSED, AssetStatus.AVAILABLE].map((status) => ({
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

  private async serialize(tenantId: string, assetId: string) {
    return { ...this.toRow(await this.loadFull(tenantId, assetId)), history: await this.history(tenantId, assetId) };
  }

  // ==========================================
  // Writing: assets
  // ==========================================

  async createAsset(actor: AssetActorDto, dto: CreateAssetDto) {
    const { tenantId } = actor;
    await this.assertCategory(tenantId, dto.categoryId);
    await this.assertSerialFree(tenantId, dto.serialNumber);
    const assignee = dto.assignedEmployeeId ? await this.loadAssignee(tenantId, dto.assignedEmployeeId) : null;

    const Asset = await this.modelProvider.getAssetModel(tenantId);
    for (let attempt = 1; ; attempt++) {
      try {
        const id = await Asset.sequelize!.transaction(async (transaction) => {
          const now = new Date();
          const status = assignee ? AssetStatus.IN_USE : AssetStatus.AVAILABLE;
          const created: any = await Asset.create(
            {
              tenantId,
              assetCode: await this.nextAssetCode(tenantId, transaction),
              name: dto.name.trim(),
              categoryId: dto.categoryId,
              brand: dto.brand ?? null,
              serialNumber: dto.serialNumber ?? null,
              status,
              assignedEmployeeId: assignee?.id ?? null,
              assignedAt: assignee ? now : null,
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
                ? [{ type: 'ASSIGNED', fromStatus: AssetStatus.AVAILABLE, toStatus: AssetStatus.IN_USE, employeeId: assignee.id, employeeName: fullName(assignee) }]
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

  /** Gives the asset to an employee. If someone else had it, it is taken from them first. */
  async assign(actor: AssetActorDto, assetId: string, dto: AssignAssetDto) {
    const { tenantId } = actor;
    const employee = await this.loadAssignee(tenantId, dto.employeeId);
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status === AssetStatus.DISPOSED) this.fail(HttpStatus.CONFLICT, 'A disposed asset cannot be assigned.');
      if (asset.status === AssetStatus.MAINTENANCE) this.fail(HttpStatus.CONFLICT, 'This asset is under maintenance. Finish the maintenance before assigning it.');
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
      });

      await asset.update({ status: AssetStatus.IN_USE, assignedEmployeeId: employee.id, assignedAt: new Date() }, { transaction });
      await this.record(tenantId, actor, assetId, events, transaction);
    });
    return this.serialize(tenantId, assetId);
  }

  /** The employee hands it back: it is in stock again. */
  async returnAsset(actor: AssetActorDto, assetId: string, note?: string | null) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status !== AssetStatus.IN_USE || !asset.assignedEmployeeId) {
        this.fail(HttpStatus.CONFLICT, 'Only an asset that is in use can be returned.');
      }
      await this.record(
        tenantId,
        actor,
        assetId,
        [{
          type: 'RETURNED',
          fromStatus: AssetStatus.IN_USE,
          toStatus: AssetStatus.AVAILABLE,
          employeeId: asset.assignedEmployeeId,
          employeeName: await this.holderName(tenantId, asset.assignedEmployeeId),
          note,
        }],
        transaction,
      );
      await asset.update({ status: AssetStatus.AVAILABLE, assignedEmployeeId: null, assignedAt: null }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  /** Sent for repair. Whoever had it still has it on record — they get it back afterwards. */
  async startMaintenance(actor: AssetActorDto, assetId: string, note?: string | null) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status === AssetStatus.MAINTENANCE) this.fail(HttpStatus.CONFLICT, 'This asset is already under maintenance.');
      if (asset.status === AssetStatus.DISPOSED) this.fail(HttpStatus.CONFLICT, 'A disposed asset cannot go for maintenance.');
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
          note,
        }],
        transaction,
      );
      await asset.update({ status: AssetStatus.MAINTENANCE }, { transaction });
    });
    return this.serialize(tenantId, assetId);
  }

  /** Back from repair: with its holder it is in use again, otherwise it goes back to stock. */
  async completeMaintenance(actor: AssetActorDto, assetId: string, note?: string | null) {
    const { tenantId } = actor;
    const Asset = await this.modelProvider.getAssetModel(tenantId);

    await Asset.sequelize!.transaction(async (transaction) => {
      const asset = await this.loadForAction(tenantId, assetId, transaction);
      if (asset.status !== AssetStatus.MAINTENANCE) this.fail(HttpStatus.CONFLICT, 'This asset is not under maintenance.');
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
          note,
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
