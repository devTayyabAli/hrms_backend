import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, fn, col, literal } from 'sequelize';
import {
  DirectoryPayload,
  DirectoryRoleCategory,
  DirectorySourceType,
  PlatformDirectoryPerson,
  PlatformProjectionSignal,
  PlatformTenantCounters,
  ProjectionEventType,
} from '@app/database';

export interface ProjectionEvent {
  tenantId: string;
  aggregateType: DirectorySourceType;
  aggregateId: string;
  eventType: ProjectionEventType;
  version: string | number;
  payload?: DirectoryPayload | null;
  organizationName?: string | null;
}

export interface DirectoryQuery {
  page?: number;
  limit?: number;
  search?: string;
  roleCategory?: DirectoryRoleCategory;
  /** Default Clients behaviour: contacts only, plain employees hidden. */
  excludeEmployees?: boolean;
  tenantId?: string;
  department?: string;
  isActive?: boolean;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

/** How long a deleted row is kept as a tombstone before being purged. */
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The only writer of the SuperAdmin read model.
 *
 * Everything here must be safe to run twice. The outbox guarantees
 * at-least-once delivery, not exactly-once, so a relay retry after a
 * half-finished apply will replay events that already landed — an upsert
 * keyed on (tenantId, sourceType, sourceId) plus the version guard is what
 * makes that a no-op instead of a duplicate row.
 */
@Injectable()
export class DirectoryProjectionService {
  private readonly logger = new Logger(DirectoryProjectionService.name);

  constructor(
    @InjectModel(PlatformDirectoryPerson)
    private readonly directory: typeof PlatformDirectoryPerson,
    @InjectModel(PlatformTenantCounters)
    private readonly counters: typeof PlatformTenantCounters,
    @InjectModel(PlatformProjectionSignal)
    private readonly signal: typeof PlatformProjectionSignal,
  ) {}

  /**
   * Applies a batch in order, then refreshes the counters for the tenants
   * touched. Counters are recomputed once per tenant rather than incremented
   * per event: an aggregate over one tenant's rows is a single indexed query,
   * and it cannot drift the way running totals do.
   */
  async apply(events: ProjectionEvent[]): Promise<{ applied: number; skipped: number }> {
    let applied = 0;
    let skipped = 0;
    const tenants = new Set<string>();

    for (const event of events) {
      const changed =
        event.eventType === ProjectionEventType.DELETED
          ? await this.applyDelete(event)
          : await this.applyUpsert(event);

      if (changed) applied++;
      else skipped++;
      tenants.add(event.tenantId);
    }

    for (const tenantId of tenants) {
      await this.refreshCounters(tenantId);
    }

    return { applied, skipped };
  }

  private async applyUpsert(event: ProjectionEvent): Promise<boolean> {
    const payload = event.payload ?? {};
    const version = String(event.version ?? 0);

    const existing = await this.directory.findOne({
      where: {
        tenantId: event.tenantId,
        sourceType: event.aggregateType,
        sourceId: event.aggregateId,
      },
    });

    if (existing) {
      // A replayed or out-of-order event carries a version we have already
      // passed; applying it would roll the row back to stale values.
      if (BigInt(existing.version ?? 0) >= BigInt(version)) return false;

      // A tombstoned person must not be resurrected by a late update. Only a
      // CREATED event — a genuine re-add of the same id — clears it.
      if (existing.deletedAt && event.eventType !== ProjectionEventType.CREATED) {
        return false;
      }

      await existing.update({
        ...this.columnsFrom(payload, event.organizationName),
        version,
        deletedAt: null,
        syncedAt: new Date(),
      });
      return true;
    }

    await this.directory.create({
      tenantId: event.tenantId,
      sourceType: event.aggregateType,
      sourceId: event.aggregateId,
      ...this.columnsFrom(payload, event.organizationName),
      version,
      deletedAt: null,
      syncedAt: new Date(),
    });
    return true;
  }

  private async applyDelete(event: ProjectionEvent): Promise<boolean> {
    const [updated] = await this.directory.update(
      { deletedAt: new Date(), syncedAt: new Date(), version: String(event.version ?? 0) },
      {
        where: {
          tenantId: event.tenantId,
          sourceType: event.aggregateType,
          sourceId: event.aggregateId,
          deletedAt: null,
        },
      },
    );
    return updated > 0;
  }

  /** Only the fields a payload actually carried — a partial update stays partial. */
  private columnsFrom(payload: DirectoryPayload, organizationName?: string | null) {
    const columns: Record<string, unknown> = {};
    if (payload.name !== undefined) columns.name = payload.name;
    if (payload.email !== undefined) columns.email = payload.email;
    if (payload.phone !== undefined) columns.phone = payload.phone;
    if (payload.department !== undefined) columns.department = payload.department;
    if (payload.role !== undefined) columns.role = payload.role;
    if (payload.roleCategory !== undefined) {
      columns.roleCategory = payload.roleCategory as DirectoryRoleCategory;
    }
    if (payload.employeeCode !== undefined) columns.employeeCode = payload.employeeCode;
    if (payload.isActive !== undefined) columns.isActive = payload.isActive;
    if (payload.sourceCreatedAt !== undefined) columns.sourceCreatedAt = payload.sourceCreatedAt;
    if (payload.sourceUpdatedAt !== undefined) columns.sourceUpdatedAt = payload.sourceUpdatedAt;
    if (organizationName !== undefined && organizationName !== null) {
      columns.organizationName = organizationName;
    }
    return columns;
  }

  /** One grouped aggregate over a single tenant, not a scan of the directory. */
  async refreshCounters(tenantId: string): Promise<void> {
    const rows = (await this.directory.findAll({
      where: { tenantId, deletedAt: null },
      attributes: [
        'roleCategory',
        [fn('COUNT', col('id')), 'total'],
        [fn('SUM', literal(`CASE WHEN "isActive" THEN 1 ELSE 0 END`)), 'active'],
      ],
      group: ['roleCategory'],
      raw: true,
    })) as unknown as { roleCategory: string; total: string; active: string }[];

    const tally = {
      totalUsers: 0,
      activeUsers: 0,
      admins: 0,
      hrs: 0,
      managers: 0,
      employees: 0,
    };

    for (const row of rows) {
      const total = Number(row.total ?? 0);
      tally.totalUsers += total;
      tally.activeUsers += Number(row.active ?? 0);
      if (row.roleCategory === DirectoryRoleCategory.ADMIN) tally.admins = total;
      else if (row.roleCategory === DirectoryRoleCategory.HR) tally.hrs = total;
      else if (row.roleCategory === DirectoryRoleCategory.EMPLOYEE) tally.employees = total;
    }

    const existing = await this.counters.findByPk(tenantId);
    if (existing) await existing.update(tally);
    else await this.counters.create({ tenantId, ...tally });
  }

  /**
   * The Clients listing, as one indexed query.
   *
   * This replaces `collectAllClientRows`, which opened every tenant database,
   * loaded every user, and then filtered, sorted and paged in JavaScript.
   * Filtering and ordering happen in Postgres against the indexes declared on
   * the model, so cost is proportional to the page, not to the platform.
   */
  async queryDirectory(query: DirectoryQuery): Promise<{
    rows: PlatformDirectoryPerson[];
    total: number;
  }> {
    const where = this.buildWhere(query);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 200);
    const page = Math.max(query.page ?? 1, 1);

    const { rows, count } = await this.directory.findAndCountAll({
      where,
      order: this.buildOrder(query),
      offset: (page - 1) * limit,
      limit,
    });

    return { rows, total: count };
  }

  /**
   * Role tallies for the KPI cards plus the month-over-month windows behind
   * their growth figures — three grouped queries rather than a scan of every
   * tenant database.
   */
  async directoryStats(): Promise<{
    totals: Record<string, number>;
    thisMonth: Record<string, number>;
    lastMonth: Record<string, number>;
  }> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const tally = async (extra?: Record<string, unknown>) => {
      const rows = (await this.directory.findAll({
        where: { deletedAt: null, ...(extra ?? {}) },
        attributes: ['roleCategory', [fn('COUNT', col('id')), 'total']],
        group: ['roleCategory'],
        raw: true,
      })) as unknown as { roleCategory: string; total: string }[];

      const result: Record<string, number> = {
        ADMIN: 0,
        HR: 0,
        EMPLOYEE: 0,
        OTHER: 0,
        TOTAL: 0,
      };
      for (const row of rows) {
        const total = Number(row.total ?? 0);
        result[row.roleCategory] = total;
        result.TOTAL += total;
      }
      return result;
    };

    const [totals, thisMonth, lastMonth] = await Promise.all([
      tally(),
      tally({ sourceCreatedAt: { [Op.gte]: monthStart } }),
      tally({ sourceCreatedAt: { [Op.gte]: prevMonthStart, [Op.lt]: monthStart } }),
    ]);

    return { totals, thisMonth, lastMonth };
  }

  private buildWhere(query: DirectoryQuery): Record<string, unknown> {
    const where: Record<string, unknown> = { deletedAt: null };

    if (query.roleCategory) {
      where.roleCategory = query.roleCategory;
    } else if (query.excludeEmployees) {
      // The Clients table is a directory of client-facing contacts; plain
      // employees are excluded unless explicitly asked for.
      where.roleCategory = { [Op.ne]: DirectoryRoleCategory.EMPLOYEE };
    }

    if (query.tenantId) where.tenantId = query.tenantId;
    if (query.department) where.department = { [Op.iLike]: query.department };
    if (query.isActive !== undefined) where.isActive = query.isActive;

    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or as unknown as string] = [
        { name: { [Op.iLike]: term } },
        { email: { [Op.iLike]: term } },
        { organizationName: { [Op.iLike]: term } },
      ];
    }

    return where;
  }

  private buildOrder(query: DirectoryQuery): [string, string][] {
    // Whitelisted: sortBy arrives from a query string and would otherwise be
    // interpolated into ORDER BY.
    const columns: Record<string, string> = {
      createdAt: 'sourceCreatedAt',
      updatedAt: 'sourceUpdatedAt',
      name: 'name',
      email: 'email',
      role: 'role',
      organizationName: 'organizationName',
      isActive: 'isActive',
    };
    const column = columns[query.sortBy ?? 'createdAt'] ?? 'sourceCreatedAt';
    const direction = query.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    // id breaks ties so paging cannot repeat or skip a row.
    return [
      [column, direction],
      ['id', direction],
    ];
  }

  /** Counters for every tenant in one query — replaces the user-count fan-out. */
  async getCounters(tenantIds?: string[]) {
    const where = tenantIds?.length ? { tenantId: { [Op.in]: tenantIds } } : undefined;
    return this.counters.findAll({ where, raw: true });
  }

  // ==========================================
  // Signal — which tenants still owe us events
  // ==========================================

  async markPending(tenantId: string, error?: string): Promise<void> {
    const existing = await this.signal.findByPk(tenantId);
    if (existing) {
      await existing.update({
        pendingSince: existing.pendingSince ?? new Date(),
        consecutiveFailures: (existing.consecutiveFailures ?? 0) + 1,
        lastError: error ?? existing.lastError,
      });
      return;
    }
    await this.signal.create({
      tenantId,
      pendingSince: new Date(),
      consecutiveFailures: 1,
      lastError: error ?? null,
    });
  }

  async markDrained(tenantId: string): Promise<void> {
    const existing = await this.signal.findByPk(tenantId);
    if (!existing) return;
    await existing.update({
      pendingSince: null,
      lastDrainedAt: new Date(),
      consecutiveFailures: 0,
      lastError: null,
    });
  }

  /**
   * Projection health for the SuperAdmin system screen.
   *
   * The three numbers worth alerting on: how many tenants are behind, how
   * long the oldest has been behind, and whether any tenant has failed
   * repeatedly. Drift is invisible otherwise — a stalled relay looks exactly
   * like a quiet platform until someone notices the Clients list is wrong.
   */
  async health(): Promise<{
    healthy: boolean;
    directoryRows: number;
    tombstones: number;
    tenantsTracked: number;
    pendingTenants: number;
    oldestPendingSeconds: number | null;
    failingTenants: { tenantId: string; consecutiveFailures: number; lastError: string | null }[];
  }> {
    const [directoryRows, tombstones, tenantsTracked, pending] = await Promise.all([
      this.directory.count({ where: { deletedAt: null } }),
      this.directory.count({ where: { deletedAt: { [Op.ne]: null } } }),
      this.counters.count(),
      this.signal.findAll({
        where: { pendingSince: { [Op.ne]: null } },
        order: [['pendingSince', 'ASC']],
        raw: true,
      }),
    ]);

    const rows = pending as any[];
    const oldest = rows[0]?.pendingSince ? new Date(rows[0].pendingSince) : null;

    return {
      healthy: rows.length === 0,
      directoryRows,
      tombstones,
      tenantsTracked,
      pendingTenants: rows.length,
      oldestPendingSeconds: oldest
        ? Math.round((Date.now() - oldest.getTime()) / 1000)
        : null,
      failingTenants: rows
        .filter((row) => (row.consecutiveFailures ?? 0) > 0)
        .map((row) => ({
          tenantId: row.tenantId,
          consecutiveFailures: row.consecutiveFailures ?? 0,
          lastError: row.lastError ?? null,
        })),
    };
  }

  async pendingTenantIds(): Promise<string[]> {
    const rows = await this.signal.findAll({
      where: { pendingSince: { [Op.ne]: null } },
      attributes: ['tenantId'],
      raw: true,
    });
    return (rows as any[]).map((row) => row.tenantId);
  }

  // ==========================================
  // Housekeeping
  // ==========================================

  /** Removes tombstones past the retention window. */
  async purgeTombstones(): Promise<number> {
    return this.directory.destroy({
      where: { deletedAt: { [Op.lt]: new Date(Date.now() - TOMBSTONE_RETENTION_MS) } },
    });
  }

  /** Everything belonging to a tenant that no longer exists. */
  async dropTenant(tenantId: string): Promise<void> {
    await this.directory.destroy({ where: { tenantId } });
    await this.counters.destroy({ where: { tenantId } });
    await this.signal.destroy({ where: { tenantId } });
    this.logger.log(`Dropped directory projection for tenant ${tenantId}.`);
  }

  /** Live rows for one tenant — used by the rebuild to find orphans. */
  async sourceIdsFor(tenantId: string, sourceType: DirectorySourceType): Promise<string[]> {
    const rows = await this.directory.findAll({
      where: { tenantId, sourceType, deletedAt: null },
      attributes: ['sourceId'],
      raw: true,
    });
    return (rows as any[]).map((row) => row.sourceId);
  }

  /** Hard-deletes rows the tenant database no longer has. */
  async removeOrphans(
    tenantId: string,
    sourceType: DirectorySourceType,
    liveSourceIds: string[],
  ): Promise<number> {
    return this.directory.destroy({
      where: {
        tenantId,
        sourceType,
        ...(liveSourceIds.length ? { sourceId: { [Op.notIn]: liveSourceIds } } : {}),
      },
    });
  }

  async countFor(tenantId: string, sourceType: DirectorySourceType): Promise<number> {
    return this.directory.count({ where: { tenantId, sourceType, deletedAt: null } });
  }
}
