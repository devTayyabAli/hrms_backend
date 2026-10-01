import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { SERVICES, MESSAGE_PATTERNS, ClientRoleFilter, ClientStatusFilter, ClientSortableField } from '@app/common';
import { TenantContextService } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';

export interface TenantSummary {
  id: string;
  name: string;
  organizationName?: string;
  status?: string;
  createdAt?: Date;
}

export type ClientRoleCategory = 'ADMIN' | 'HR' | 'EMPLOYEE' | 'OTHER';

export interface PlatformClientRow {
  userId: string;
  tenantId: string;
  organizationId: string;
  organizationName: string;
  name: string;
  email: string;
  phone: string | null;
  department: string | null;
  role: string;
  roleCategory: ClientRoleCategory;
  isActive: boolean;
  clientCode: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Last successful login. Only ever populated for a tenant's Admin — the
   * only role with a login path implemented anywhere in this codebase today
   * (auth-service's AuthCredential table). HR/Employee rows are always
   * `null`, not because tracking failed, but because there is nothing to
   * track yet.
   */
  lastActiveAt: Date | null;
}

export interface GetPlatformClientsQuery {
  page?: number;
  limit?: number;
  search?: string;
  role?: ClientRoleFilter;
  organizationId?: string;
  department?: string;
  status?: ClientStatusFilter;
  sortBy?: ClientSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

const TENANT_ITERATION_CONCURRENCY = 8;

@Injectable()
export class PlatformClientsService {
  private readonly logger = new Logger(PlatformClientsService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly tenantContextService: TenantContextService,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  /**
   * Classify a tenant-defined role name into a coarse platform-level category.
   * Tenants can freely name roles, so this is a best-effort heuristic (mirrors
   * the PROTECTED_SYSTEM_ROLES convention used in RoleService).
   */
  private categorizeRole(roleName?: string): ClientRoleCategory {
    const name = (roleName || '').toUpperCase();
    if (name.includes('ADMIN')) return 'ADMIN';
    if (name.includes('HR')) return 'HR';
    if (name.includes('EMPLOYEE')) return 'EMPLOYEE';
    return 'OTHER';
  }

  /**
   * Deterministic, human-friendly display code for a user (e.g. ADM-1001).
   * This is a generated label, not a real subscription/billing identifier.
   */
  private buildClientCode(roleCategory: ClientRoleCategory, userId: string): string {
    const prefixMap: Record<ClientRoleCategory, string> = {
      ADMIN: 'ADM',
      HR: 'HR',
      EMPLOYEE: 'EMP',
      OTHER: 'USR',
    };
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash * 31 + userId.charCodeAt(i)) % 9000;
    }
    return `${prefixMap[roleCategory]}-${1000 + Math.abs(hash)}`;
  }

  /**
   * Whether to serve the Clients directory from the central read model.
   *
   * Defaults to the projection. The fan-out below is kept, behind
   * `USE_DIRECTORY_PROJECTION=false`, as the rollback for an environment
   * whose projection has not been backfilled yet — see
   * `npm run db:rebuild-directory`.
   */
  private useProjection(): boolean {
    return process.env.USE_DIRECTORY_PROJECTION !== 'false';
  }

  /**
   * One indexed query against the platform database, instead of opening
   * every tenant database and paging in memory.
   */
  private async getClientsFromProjection(
    query: GetPlatformClientsQuery,
    page: number,
    limit: number,
  ): Promise<{
    data: PlatformClientRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const roleFilter =
      query.role && query.role !== ClientRoleFilter.ALL ? query.role : undefined;

    const result: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.PROJECTION.QUERY_DIRECTORY, {
        page,
        limit,
        search: query.search,
        roleCategory: roleFilter,
        excludeEmployees: !roleFilter,
        tenantId: query.organizationId,
        department: query.department,
        isActive:
          query.status && query.status !== ClientStatusFilter.ALL
            ? query.status === ClientStatusFilter.ACTIVE
            : undefined,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      }),
    );

    const data: PlatformClientRow[] = (result?.rows ?? []).map((row: any) => ({
      userId: row.sourceId,
      tenantId: row.tenantId,
      organizationId: row.tenantId,
      organizationName: row.organizationName ?? '',
      name: row.name,
      email: row.email,
      phone: row.phone ?? null,
      department: row.department ?? null,
      role: row.role || 'UNASSIGNED',
      roleCategory: row.roleCategory as ClientRoleCategory,
      isActive: row.isActive,
      clientCode: this.buildClientCode(row.roleCategory as ClientRoleCategory, row.sourceId),
      createdAt: row.sourceCreatedAt,
      updatedAt: row.sourceUpdatedAt,
      lastActiveAt: null,
    }));

    // Still fetched per page only — at most `limit` rows, so this stays cheap
    // and does not need projecting until it becomes hot.
    const tenantIds = [...new Set(data.map((row) => row.tenantId))];
    this.applyLastActive(data, await this.fetchLastLogins(tenantIds));

    const total = result?.total ?? 0;
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  private async fetchTenants(search?: string): Promise<TenantSummary[]> {
    const result: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.TENANT.GET_ALL_TENANTS, search ? { search } : {}),
    );
    const tenants = Array.isArray(result) ? result : result?.data || [];
    return tenants;
  }

  private async fetchTenantById(tenantId: string): Promise<TenantSummary> {
    return firstValueFrom(this.tenantClient.send(MESSAGE_PATTERNS.TENANT.GET_TENANT, { tenantId }));
  }

  private async chunkedForEach<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      await Promise.all(batch.map((item) => fn(item)));
    }
  }

  /**
   * Fan out across every tenant's isolated database and collect a flat list
   * of person rows (users + their primary role). Failures for an individual
   * tenant are logged and skipped so one broken tenant DB doesn't fail the page.
   */
  private async collectAllClientRows(tenants: TenantSummary[]): Promise<PlatformClientRow[]> {
    const rows: PlatformClientRow[] = [];

    await this.chunkedForEach(tenants, TENANT_ITERATION_CONCURRENCY, async (tenant) => {
      try {
        await this.tenantContextService.run({ tenantId: tenant.id }, async () => {
          const UserModel = await this.modelProvider.getUserModel();
          const RoleModel = await this.modelProvider.getRoleModel();
          const users = await UserModel.findAll({
            include: [{ model: RoleModel, through: { attributes: [] } }],
          });

          for (const user of users as any[]) {
            const primaryRole = user.roles?.[0];
            const roleCategory = this.categorizeRole(primaryRole?.name);
            rows.push({
              userId: user.id,
              tenantId: tenant.id,
              organizationId: tenant.id,
              organizationName: tenant.organizationName || tenant.name,
              name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
              email: user.email,
              phone: user.phone ?? null,
              department: user.department ?? null,
              role: primaryRole?.name || 'UNASSIGNED',
              roleCategory,
              isActive: user.isActive,
              clientCode: this.buildClientCode(roleCategory, user.id),
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
              lastActiveAt: null,
            });
          }
        });
      } catch (err: any) {
        this.logger.warn(`Skipping tenant ${tenant.id} while collecting platform clients: ${err.message}`);
      }
    });

    return rows;
  }

  async getClients(query: GetPlatformClientsQuery): Promise<{
    data: PlatformClientRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    if (this.useProjection()) {
      return this.getClientsFromProjection(query, page, limit);
    }

    const tenants = query.organizationId
      ? [await this.fetchTenantById(query.organizationId)]
      : await this.fetchTenants();

    let rows = await this.collectAllClientRows(tenants);

    // Table only surfaces client-facing contacts (Admins/HRs) by default.
    const roleFilter = query.role && query.role !== ClientRoleFilter.ALL ? query.role : undefined;
    rows = rows.filter((row) => (roleFilter ? row.roleCategory === roleFilter : row.roleCategory !== 'EMPLOYEE'));

    if (query.department) {
      const dept = query.department.toLowerCase();
      rows = rows.filter((row) => row.department?.toLowerCase() === dept);
    }

    if (query.status && query.status !== ClientStatusFilter.ALL) {
      const wantActive = query.status === ClientStatusFilter.ACTIVE;
      rows = rows.filter((row) => row.isActive === wantActive);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.name.toLowerCase().includes(term) ||
          row.email.toLowerCase().includes(term) ||
          row.organizationName.toLowerCase().includes(term),
      );
    }

    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder || 'DESC';
    rows.sort((a: any, b: any) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return sortOrder === 'ASC' ? cmp : -cmp;
    });

    const total = rows.length;
    const start = (page - 1) * limit;
    const data = rows.slice(start, start + limit);

    const tenantIds = [...new Set(data.map((row) => row.tenantId))];
    this.applyLastActive(data, await this.fetchLastLogins(tenantIds));

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  private async fetchLastLogins(
    tenantIds: string[],
  ): Promise<Record<string, { email: string; lastLoginAt: Date | null }[]>> {
    if (tenantIds.length === 0) return {};
    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.GET_LAST_LOGINS, { tenantIds }),
    );
  }

  /** Matches by tenantId + email (case-insensitive) since AuthCredential has no user-service User.id reference. */
  private applyLastActive(
    rows: PlatformClientRow[],
    lastLoginsByTenant: Record<string, { email: string; lastLoginAt: Date | null }[]>,
  ): void {
    for (const row of rows) {
      const candidates = lastLoginsByTenant[row.tenantId];
      const match = candidates?.find((c) => c.email.toLowerCase() === row.email.toLowerCase());
      if (match) row.lastActiveAt = match.lastLoginAt;
    }
  }

  async getOne(tenantId: string, userId: string): Promise<PlatformClientRow> {
    const tenant = await this.fetchTenantById(tenantId);
    const row = await this.tenantContextService.run({ tenantId }, async () => {
      const UserModel = await this.modelProvider.getUserModel();
      const RoleModel = await this.modelProvider.getRoleModel();
      const user: any = await UserModel.findByPk(userId, {
        include: [{ model: RoleModel, through: { attributes: [] } }],
      });
      if (!user) return null;
      const primaryRole = user.roles?.[0];
      const roleCategory = this.categorizeRole(primaryRole?.name);
      return {
        userId: user.id,
        tenantId,
        organizationId: tenantId,
        organizationName: tenant.organizationName || tenant.name,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
        email: user.email,
        phone: user.phone ?? null,
        department: user.department ?? null,
        role: primaryRole?.name || 'UNASSIGNED',
        roleCategory,
        isActive: user.isActive,
        clientCode: this.buildClientCode(roleCategory, user.id),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastActiveAt: null,
      } as PlatformClientRow;
    });

    if (!row) {
      throw new NotFoundException(`Client ${userId} not found in organization ${tenantId}`);
    }
    this.applyLastActive([row], await this.fetchLastLogins([tenantId]));
    return row;
  }

  async updateStatus(tenantId: string, userId: string, isActive: boolean): Promise<PlatformClientRow> {
    await this.tenantContextService.run({ tenantId }, async () => {
      const UserModel = await this.modelProvider.getUserModel();
      const user = await UserModel.findByPk(userId);
      if (!user) {
        throw new NotFoundException(`Client ${userId} not found in organization ${tenantId}`);
      }
      await user.update({ isActive });
    });
    return this.getOne(tenantId, userId);
  }

  async remove(tenantId: string, userId: string): Promise<void> {
    await this.tenantContextService.run({ tenantId }, async () => {
      const UserModel = await this.modelProvider.getUserModel();
      const UserRoleModel = await this.modelProvider.getUserRoleModel();
      const user = await UserModel.findByPk(userId);
      if (!user) {
        throw new NotFoundException(`Client ${userId} not found in organization ${tenantId}`);
      }
      await UserRoleModel.destroy({ where: { userId } });
      await user.destroy();
    });
  }

  /**
   * Lightweight per-tenant headcount used by the platform Organizations list
   * (avoids loading full user rows across every tenant DB).
   */
  async getUserCountsByTenant(
    tenantIds: string[],
  ): Promise<Record<string, { total: number; admins: number; hrs: number; employees: number }>> {
    const result: Record<string, { total: number; admins: number; hrs: number; employees: number }> = {};

    await this.chunkedForEach(tenantIds, TENANT_ITERATION_CONCURRENCY, async (tenantId) => {
      try {
        await this.tenantContextService.run({ tenantId }, async () => {
          const UserModel = await this.modelProvider.getUserModel();
          const RoleModel = await this.modelProvider.getRoleModel();
          const users = await UserModel.findAll({
            attributes: ['id'],
            include: [{ model: RoleModel, attributes: ['name'], through: { attributes: [] } }],
          });

          const counts = { total: users.length, admins: 0, hrs: 0, employees: 0 };
          for (const user of users as any[]) {
            const category = this.categorizeRole(user.roles?.[0]?.name);
            if (category === 'ADMIN') counts.admins++;
            else if (category === 'HR') counts.hrs++;
            else if (category === 'EMPLOYEE') counts.employees++;
          }
          result[tenantId] = counts;
        });
      } catch (err: any) {
        this.logger.warn(`Skipping tenant ${tenantId} while counting users: ${err.message}`);
        result[tenantId] = { total: 0, admins: 0, hrs: 0, employees: 0 };
      }
    });

    return result;
  }

  async getStats(): Promise<{
    totalClients: number;
    admins: number;
    hrs: number;
    employees: number;
    growth: { totalClients: number; admins: number; hrs: number; employees: number };
  }> {
    if (this.useProjection()) {
      const stats: any = await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.PROJECTION.DIRECTORY_STATS, {}),
      );
      // Same formula as the fan-out below, so the cards do not change value
      // when the projection is switched on.
      const pct = (key: string) => {
        const thisMonth = stats?.thisMonth?.[key] ?? 0;
        const lastMonth = stats?.lastMonth?.[key] ?? 0;
        if (lastMonth === 0) return thisMonth > 0 ? 100 : 0;
        return Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10;
      };

      return {
        totalClients: stats?.totals?.TOTAL ?? 0,
        admins: stats?.totals?.ADMIN ?? 0,
        hrs: stats?.totals?.HR ?? 0,
        employees: stats?.totals?.EMPLOYEE ?? 0,
        growth: {
          totalClients: pct('TOTAL'),
          admins: pct('ADMIN'),
          hrs: pct('HR'),
          employees: pct('EMPLOYEE'),
        },
      };
    }

    const tenants = await this.fetchTenants();
    const rows = await this.collectAllClientRows(tenants);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const growthFor = (subset: PlatformClientRow[]) => {
      const thisMonth = subset.filter((r) => r.createdAt >= monthStart).length;
      const lastMonth = subset.filter((r) => r.createdAt >= prevMonthStart && r.createdAt < monthStart).length;
      if (lastMonth === 0) return thisMonth > 0 ? 100 : 0;
      return Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10;
    };

    const admins = rows.filter((r) => r.roleCategory === 'ADMIN');
    const hrs = rows.filter((r) => r.roleCategory === 'HR');
    const employees = rows.filter((r) => r.roleCategory === 'EMPLOYEE');

    return {
      totalClients: rows.length,
      admins: admins.length,
      hrs: hrs.length,
      employees: employees.length,
      growth: {
        totalClients: growthFor(rows),
        admins: growthFor(admins),
        hrs: growthFor(hrs),
        employees: growthFor(employees),
      },
    };
  }

  async getByRole(): Promise<{ role: ClientRoleCategory; count: number; percentage: number }[]> {
    if (this.useProjection()) {
      const stats: any = await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.PROJECTION.DIRECTORY_STATS, {}),
      );
      const totals: Record<string, number> = stats?.totals ?? {};
      const total = totals.TOTAL || 1;
      return (['EMPLOYEE', 'ADMIN', 'HR', 'OTHER'] as ClientRoleCategory[])
        .map((role) => ({
          role,
          count: totals[role] ?? 0,
          percentage: Math.round(((totals[role] ?? 0) / total) * 1000) / 10,
        }))
        .filter((entry) => entry.count > 0);
    }

    const tenants = await this.fetchTenants();
    const rows = await this.collectAllClientRows(tenants);
    const total = rows.length || 1;

    const categories: ClientRoleCategory[] = ['EMPLOYEE', 'ADMIN', 'HR', 'OTHER'];
    return categories
      .map((role) => {
        const count = rows.filter((r) => r.roleCategory === role).length;
        return { role, count, percentage: Math.round((count / total) * 1000) / 10 };
      })
      .filter((entry) => entry.count > 0);
  }

  async getRecent(limit = 5): Promise<(PlatformClientRow & { timeAgo: string })[]> {
    if (this.useProjection()) {
      // Newest first is the projection's default order, so "recent" is just
      // the first page — no sort over the whole platform.
      const { data } = await this.getClientsFromProjection(
        { sortBy: 'createdAt', sortOrder: 'DESC' } as GetPlatformClientsQuery,
        1,
        limit,
      );
      return data.map((row) => ({ ...row, timeAgo: this.formatTimeAgo(row.createdAt) }));
    }

    const tenants = await this.fetchTenants();
    const rows = await this.collectAllClientRows(tenants);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.slice(0, limit).map((row) => ({ ...row, timeAgo: this.formatTimeAgo(row.createdAt) }));
  }

  private formatTimeAgo(date: Date): string {
    const diffMs = Date.now() - new Date(date).getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
