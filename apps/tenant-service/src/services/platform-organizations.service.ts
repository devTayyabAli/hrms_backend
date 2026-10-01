import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  SubscriptionStatus,
  OrganizationStatusFilter,
  OrganizationActionStatus,
  OrganizationSortableField,
  UpdateOrganizationDto,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import {
  Tenant,
  TenantStatus,
  OrganizationAdminInvitation,
  Subscription,
  Plan,
  Payment,
  Invoice,
  BillingEvent,
} from '../models';
import { TenantProvisioningService } from './tenant-provisioning.service';

export interface GetPlatformOrganizationsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: OrganizationStatusFilter;
  planType?: string;
  sortBy?: OrganizationSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

type TenantUserCounts = { total: number; admins: number; hrs: number; employees: number };

const DEACTIVATING_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.SUSPENDED,
  SubscriptionStatus.CANCELLED,
];

@Injectable()
export class PlatformOrganizationsService {
  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    @InjectModel(OrganizationAdminInvitation)
    private readonly invitationModel: typeof OrganizationAdminInvitation,
    @InjectModel(Subscription) private readonly subscriptionModel: typeof Subscription,
    @InjectModel(Payment) private readonly paymentModel: typeof Payment,
    @InjectModel(Invoice) private readonly invoiceModel: typeof Invoice,
    @InjectModel(BillingEvent) private readonly billingEventModel: typeof BillingEvent,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    private readonly tenantProvisioningService: TenantProvisioningService,
  ) {}

  /**
   * Collapses the platform-level tenant flag and the billing subscription
   * lifecycle into the four buckets the Organizations view groups by. A
   * SUSPENDED tenant (superadmin override) always wins over billing state —
   * an org an admin has manually disabled shouldn't read as "Active" just
   * because its subscription happens to still be paid up.
   */
  private deriveStatus(tenant: Tenant, subscription: Subscription | undefined): OrganizationStatusFilter {
    if (tenant.status === TenantStatus.SUSPENDED) return OrganizationStatusFilter.DEACTIVATED;
    if (tenant.status === TenantStatus.EXPIRED) return OrganizationStatusFilter.DEACTIVATED;

    if (subscription) {
      switch (subscription.status) {
        case SubscriptionStatus.ACTIVE:
          return OrganizationStatusFilter.ACTIVE;
        case SubscriptionStatus.TRIAL:
          return OrganizationStatusFilter.TRIAL;
        case SubscriptionStatus.PAST_DUE:
        case SubscriptionStatus.SUSPENDED:
        case SubscriptionStatus.CANCELLED:
          return OrganizationStatusFilter.DEACTIVATED;
        case SubscriptionStatus.PENDING_PAYMENT:
        default:
          return OrganizationStatusFilter.PENDING;
      }
    }

    // No subscription row at all, so billing says nothing — the tenant's own
    // lifecycle is the only signal left. An organization whose admin finished
    // onboarding (`completeSetup` sets status ACTIVE) is live and has to read
    // that way here; treating a missing subscription as PENDING made every
    // such org read "Pending" forever, since nothing else consults
    // `tenant.status`. Anything earlier in the lifecycle — DRAFT,
    // PENDING_SUBSCRIPTION, PENDING_ADMIN_ACTIVATION, SETUP_IN_PROGRESS — is
    // genuinely still pending.
    return tenant.status === TenantStatus.ACTIVE
      ? OrganizationStatusFilter.ACTIVE
      : OrganizationStatusFilter.PENDING;
  }

  private subscriptionSummary(
    tenant: Tenant,
    subscription: Subscription | undefined,
    category: OrganizationStatusFilter,
  ): string | null {
    if (tenant.status === TenantStatus.SUSPENDED) return 'Deactivated by platform administrator';
    if (!subscription) return null;

    if (DEACTIVATING_SUBSCRIPTION_STATUSES.includes(subscription.status)) return 'Payment overdue';

    if (category === OrganizationStatusFilter.TRIAL) {
      if (!subscription.nextBillingDate) return 'Trial in progress';
      const daysLeft = Math.max(
        0,
        Math.ceil((new Date(subscription.nextBillingDate).getTime() - Date.now()) / 86400000),
      );
      return `Trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    }

    if (category === OrganizationStatusFilter.ACTIVE && subscription.nextBillingDate) {
      const expiresAt = new Date(subscription.nextBillingDate);
      return `Expires on ${expiresAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    }

    if (subscription.status === SubscriptionStatus.PENDING_PAYMENT) return 'Awaiting first payment';
    return null;
  }

  private async fetchUserCounts(tenants: Tenant[]): Promise<Record<string, TenantUserCounts>> {
    if (tenants.length === 0) return {};
    return firstValueFrom(
      this.userClient.send<Record<string, TenantUserCounts>>(MESSAGE_PATTERNS.USER.GET_TENANT_USER_COUNTS, {
        tenantIds: tenants.map((t) => t.id),
      }),
    );
  }

  private async fetchPrimaryAdmins(tenants: Tenant[]): Promise<Record<string, OrganizationAdminInvitation>> {
    if (tenants.length === 0) return {};
    const invitations = await this.invitationModel.findAll({
      where: { tenantId: { [Op.in]: tenants.map((t) => t.id) } },
      order: [['createdAt', 'DESC']],
    });
    const map: Record<string, OrganizationAdminInvitation> = {};
    for (const invitation of invitations) {
      if (!map[invitation.tenantId]) {
        map[invitation.tenantId] = invitation;
      }
    }
    return map;
  }

  /**
   * Each tenant's most recent subscription (a tenant may have an old
   * CANCELLED one and a newer ACTIVE one — only the latest reflects reality).
   */
  private async fetchLatestSubscriptions(tenants: Tenant[]): Promise<Record<string, Subscription>> {
    if (tenants.length === 0) return {};
    const subscriptions = await this.subscriptionModel.findAll({
      where: { tenantId: { [Op.in]: tenants.map((t) => t.id) } },
      include: [{ model: Plan }],
      order: [['createdAt', 'DESC']],
    });
    const map: Record<string, Subscription> = {};
    for (const subscription of subscriptions) {
      if (!map[subscription.tenantId]) {
        map[subscription.tenantId] = subscription;
      }
    }
    return map;
  }

  private toRow(
    tenant: Tenant,
    subscription: Subscription | undefined,
    invitation: OrganizationAdminInvitation | undefined,
    counts: TenantUserCounts | undefined,
  ) {
    const derivedStatus = this.deriveStatus(tenant, subscription);
    return {
      id: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      domain: tenant.domain,
      logoUrl: tenant.logoUrl,
      planType: subscription?.plan?.name || tenant.planType || null,
      status: derivedStatus,
      isActive: tenant.isActive,
      primaryAdmin: {
        name: invitation?.adminName || null,
        email: invitation?.adminEmail || tenant.adminEmail || null,
        phone: invitation?.phone || tenant.phone || null,
        // Organizations provisioned before `adminDesignation` was recorded
        // have none stored, and every primary admin holds the same role — so
        // the role stands in rather than leaving the column blank.
        designation: tenant.adminDesignation || 'Organization Admin',
        avatarUrl: tenant.adminAvatarUrl || null,
      },
      usersCount: counts?.total ?? 0,
      joinedOn: tenant.createdAt,
      subscription: {
        id: subscription?.id || null,
        domain: tenant.domain,
        billingStatus: subscription?.status || null,
        expiresAt: subscription?.nextBillingDate || null,
        summary: this.subscriptionSummary(tenant, subscription, derivedStatus),
      },
    };
  }

  async getOrganizations(query: GetPlatformOrganizationsQuery) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const where: Record<symbol | string, any> = query.search
      ? {
          [Op.or]: [
            { name: { [Op.iLike]: `%${query.search}%` } },
            { organizationName: { [Op.iLike]: `%${query.search}%` } },
            { domain: { [Op.iLike]: `%${query.search}%` } },
          ],
        }
      : {};

    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder || 'DESC';

    // Status/plan are derived from the tenant's billing subscription, so
    // accurately filtering by them requires the join done in-memory below.
    // Organizations are a platform-scale list (not per-tenant user data), so
    // a full scan here is the same tradeoff PlatformClientsService already
    // makes, and keeps one predictable code path instead of two.
    const allTenants = await this.tenantModel.findAll({ where, order: [[sortBy, sortOrder]] });
    const subscriptionsMap = await this.fetchLatestSubscriptions(allTenants);

    let candidates = allTenants.map((tenant) => ({ tenant, subscription: subscriptionsMap[tenant.id] }));

    if (query.status && query.status !== OrganizationStatusFilter.ALL) {
      candidates = candidates.filter((c) => this.deriveStatus(c.tenant, c.subscription) === query.status);
    }
    if (query.planType) {
      const planFilter = query.planType.toLowerCase();
      candidates = candidates.filter(
        (c) => (c.subscription?.plan?.name || c.tenant.planType || '').toLowerCase() === planFilter,
      );
    }

    const total = candidates.length;
    const start = (page - 1) * limit;
    const pageSlice = candidates.slice(start, start + limit);

    const pageTenants = pageSlice.map((c) => c.tenant);
    const [countsMap, adminsMap] = await Promise.all([
      this.fetchUserCounts(pageTenants),
      this.fetchPrimaryAdmins(pageTenants),
    ]);

    const data = pageSlice.map((c) =>
      this.toRow(c.tenant, c.subscription, adminsMap[c.tenant.id], countsMap[c.tenant.id]),
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  async getOrganizationById(tenantId: string) {
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Organization ${tenantId} not found`);
    }
    const [countsMap, adminsMap, subscriptionsMap] = await Promise.all([
      this.fetchUserCounts([tenant]),
      this.fetchPrimaryAdmins([tenant]),
      this.fetchLatestSubscriptions([tenant]),
    ]);
    // The list row plus the editable profile columns. Kept off `toRow` so the
    // paginated list payload stays lean — only the detail view and the edit
    // form need these, and they fetch one organization at a time.
    return {
      ...this.toRow(tenant, subscriptionsMap[tenant.id], adminsMap[tenant.id], countsMap[tenant.id]),
      profile: {
        legalName: tenant.legalName ?? null,
        officialEmail: tenant.officialEmail ?? null,
        phone: tenant.phone ?? null,
        industry: tenant.industry ?? null,
        companySize: tenant.companySize ?? null,
        country: tenant.country ?? null,
        website: tenant.website ?? null,
      },
    };
  }

  /**
   * SuperAdmin correction of an organization's profile. Only the fields on
   * `UpdateOrganizationDto` are writable — lifecycle and billing columns are
   * owned by the onboarding flow and the status/subscription routes.
   */
  async updateOrganization(tenantId: string, dto: UpdateOrganizationDto) {
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Organization ${tenantId} not found`);
    }

    // `domain` is a unique column, so a collision would surface as a raw
    // Sequelize constraint error rather than something the UI can show.
    if (dto.domain && dto.domain !== tenant.domain) {
      const clash = await this.tenantModel.findOne({ where: { domain: dto.domain } });
      if (clash && clash.id !== tenantId) {
        throw new TenantException(
          TenantErrorCode.INVALID_TENANT_CONTEXT,
          `Domain '${dto.domain}' is already used by another organization.`,
        );
      }
    }

    // Only keys actually present are applied, so an omitted field keeps its
    // stored value instead of being nulled by an undefined.
    const patch = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
    if (Object.keys(patch).length > 0) {
      await tenant.update(patch);
    }

    return this.getOrganizationById(tenantId);
  }

  async updateOrganizationStatus(tenantId: string, status: OrganizationActionStatus) {
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Organization ${tenantId} not found`);
    }
    // Platform-level override only — independent of the billing subscription
    // lifecycle (see /superadmin/billing/subscriptions/:id/suspend for that).
    await tenant.update({
      status: status === OrganizationActionStatus.ACTIVE ? TenantStatus.ACTIVE : TenantStatus.SUSPENDED,
      isActive: status === OrganizationActionStatus.ACTIVE,
    });
    return this.getOrganizationById(tenantId);
  }

  /**
   * Permanently deletes an organization: every platform-DB row that
   * references it, then its isolated tenant database itself. There is no
   * undo — `Deactivate` (above) is the reversible alternative for taking an
   * org offline.
   *
   * `confirmName` must match the organization's current name exactly, mirroring
   * the "type the name to confirm" prompt the frontend shows — defense in
   * depth against a stray call hitting the wrong tenantId.
   *
   * Billing rows have real foreign keys to `tenants` with no cascade rule, so
   * they're deleted first, deepest-referencing table first, in one
   * transaction on the platform database. The physical tenant database can't
   * share that transaction — it's a separate database — so it's only dropped
   * (via `TenantProvisioningService.deprovisionTenant`, which also removes
   * the tenant's `tenant_database_configs` row and the `tenants` row itself)
   * once the platform-side transaction has committed cleanly.
   */
  async deleteOrganization(tenantId: string, confirmName: string): Promise<{ tenantId: string; organizationName: string }> {
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Organization ${tenantId} not found`);
    }

    if (confirmName.trim() !== tenant.organizationName.trim()) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Confirmation text does not match the organization's name.`,
      );
    }

    const organizationName = tenant.organizationName;
    const sequelize = this.tenantModel.sequelize;

    await sequelize.transaction(async (t) => {
      await this.billingEventModel.destroy({ where: { tenantId }, transaction: t });
      await this.paymentModel.destroy({ where: { tenantId }, transaction: t });
      await this.invoiceModel.destroy({ where: { tenantId }, transaction: t });
      await this.subscriptionModel.destroy({ where: { tenantId }, transaction: t });
      await this.invitationModel.destroy({ where: { tenantId }, transaction: t });
    });

    // Point of no return: drops the tenant's isolated database and its
    // remaining platform rows (tenant_database_configs, tenants).
    await this.tenantProvisioningService.deprovisionTenant(tenantId);

    return { tenantId, organizationName };
  }

  async getStats() {
    const tenants = await this.tenantModel.findAll();
    const subscriptionsMap = await this.fetchLatestSubscriptions(tenants);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const growthFor = (subset: Tenant[]) => {
      const thisMonth = subset.filter((t) => t.createdAt >= monthStart).length;
      const lastMonth = subset.filter((t) => t.createdAt >= prevMonthStart && t.createdAt < monthStart).length;
      if (lastMonth === 0) return thisMonth > 0 ? 100 : 0;
      return Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10;
    };

    const byCategory = (category: OrganizationStatusFilter) =>
      tenants.filter((t) => this.deriveStatus(t, subscriptionsMap[t.id]) === category);

    const active = byCategory(OrganizationStatusFilter.ACTIVE);
    const trial = byCategory(OrganizationStatusFilter.TRIAL);
    const pending = byCategory(OrganizationStatusFilter.PENDING);
    const deactivated = byCategory(OrganizationStatusFilter.DEACTIVATED);

    return {
      totalOrganizations: tenants.length,
      active: active.length,
      trial: trial.length,
      pending: pending.length,
      deactivated: deactivated.length,
      growth: {
        totalOrganizations: growthFor(tenants),
        active: growthFor(active),
        trial: growthFor(trial),
        pending: growthFor(pending),
        deactivated: growthFor(deactivated),
      },
    };
  }
}
