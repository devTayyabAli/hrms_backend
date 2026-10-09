import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
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
  TenantProvisioningStatus,
  TenantSetupStatus,
  OrganizationAdminInvitation,
  InvitationStatus,
  Subscription,
  Plan,
  Payment,
  Invoice,
  BillingEvent,
} from '../models';
import { PlatformTenantCounters } from '@app/database';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { setupStateOf } from './tenant-setup-state';
import { PlatformNotifierService } from './platform-notifier.service';

export interface GetPlatformOrganizationsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: OrganizationStatusFilter;
  planType?: string;
  sortBy?: OrganizationSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

type TenantUserCounts = {
  total: number;
  admins: number;
  hrs: number;
  employees: number;
};

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
    @InjectModel(Subscription)
    private readonly subscriptionModel: typeof Subscription,
    @InjectModel(Payment) private readonly paymentModel: typeof Payment,
    @InjectModel(Invoice) private readonly invoiceModel: typeof Invoice,
    @InjectModel(BillingEvent)
    private readonly billingEventModel: typeof BillingEvent,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    private readonly tenantProvisioningService: TenantProvisioningService,
    @Optional() private readonly platformNotifier?: PlatformNotifierService,
    @Optional()
    @InjectModel(PlatformTenantCounters)
    private readonly countersModel?: typeof PlatformTenantCounters,
  ) {}

  /**
   * Collapses the platform-level tenant flag and the billing subscription
   * lifecycle into the four buckets the Organizations view groups by. A
   * SUSPENDED tenant (superadmin override) always wins over billing state —
   * an org an admin has manually disabled shouldn't read as "Active" just
   * because its subscription happens to still be paid up.
   */
  deriveStatus(
    tenant: Tenant,
    subscription: Subscription | undefined,
  ): OrganizationStatusFilter {
    if (tenant.status === TenantStatus.SUSPENDED)
      return OrganizationStatusFilter.DEACTIVATED;
    if (tenant.status === TenantStatus.EXPIRED)
      return OrganizationStatusFilter.DEACTIVATED;

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
    if (tenant.status === TenantStatus.SUSPENDED)
      return 'Deactivated by platform administrator';
    if (!subscription) return null;

    if (DEACTIVATING_SUBSCRIPTION_STATUSES.includes(subscription.status))
      return 'Payment overdue';

    if (category === OrganizationStatusFilter.TRIAL) {
      if (!subscription.nextBillingDate) return 'Trial in progress';
      const daysLeft = Math.max(
        0,
        Math.ceil(
          (new Date(subscription.nextBillingDate).getTime() - Date.now()) /
            86400000,
        ),
      );
      return `Trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    }

    if (
      category === OrganizationStatusFilter.ACTIVE &&
      subscription.nextBillingDate
    ) {
      const expiresAt = new Date(subscription.nextBillingDate);
      return `Expires on ${expiresAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    }

    if (subscription.status === SubscriptionStatus.PENDING_PAYMENT)
      return 'Awaiting first payment';
    return null;
  }

  private async fetchUserCounts(
    tenants: Tenant[],
  ): Promise<Record<string, TenantUserCounts>> {
    if (tenants.length === 0) return {};
    return firstValueFrom(
      this.userClient.send<Record<string, TenantUserCounts>>(
        MESSAGE_PATTERNS.USER.GET_TENANT_USER_COUNTS,
        {
          tenantIds: tenants.map((t) => t.id),
        },
      ),
    );
  }

  private async fetchPrimaryAdmins(
    tenants: Tenant[],
  ): Promise<Record<string, OrganizationAdminInvitation>> {
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
  private async fetchLatestSubscriptions(
    tenants: Tenant[],
  ): Promise<Record<string, Subscription>> {
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

  /** PENDING past its expiry reads as EXPIRED; the row is only updated when the link is opened. */
  private invitationState(
    invitation: OrganizationAdminInvitation,
  ): InvitationStatus {
    return invitation.status === InvitationStatus.PENDING &&
      new Date(invitation.expiresAt).getTime() < Date.now()
      ? InvitationStatus.EXPIRED
      : invitation.status;
  }

  private toRow(
    tenant: Tenant,
    subscription: Subscription | undefined,
    invitation: OrganizationAdminInvitation | undefined,
    counts: TenantUserCounts | undefined,
  ) {
    const derivedStatus = this.deriveStatus(tenant, subscription);
    const setup = setupStateOf(
      tenant,
      this.tenantProvisioningService.isSetupRunning(tenant.id),
    );
    return {
      id: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      domain: tenant.domain,
      logoUrl: tenant.logoUrl,
      planType: subscription?.plan?.name || tenant.planType || null,
      status: derivedStatus,
      isActive: tenant.isActive,
      /** Database, modules, invitation: `failed` offers "Retry setup". */
      setup,
      primaryAdmin: {
        name: invitation?.adminName || tenant.setupRequest?.adminName || null,
        email: invitation?.adminEmail || tenant.adminEmail || null,
        phone: invitation?.phone || tenant.phone || null,
        // Organizations provisioned before `adminDesignation` was recorded
        // have none stored, and every primary admin holds the same role — so
        // the role stands in rather than leaving the column blank.
        designation: tenant.adminDesignation || 'Organization Admin',
        avatarUrl: tenant.adminAvatarUrl || null,
      },
      /**
       * The admin invitation as the Organizations screen needs it. `canResend`
       * is true only while the organization is switched on and its admin has
       * never activated — the one situation a new invitation is for.
       */
      adminInvitation: {
        status: invitation ? this.invitationState(invitation) : null,
        expiresAt: invitation?.expiresAt ?? null,
        canResend:
          tenant.isActive &&
          tenant.status === TenantStatus.PENDING_ADMIN_ACTIVATION &&
          setup.state === 'ready',
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

    const candidates = await this.filteredCandidates(query);
    const total = candidates.length;
    const start = (page - 1) * limit;
    const pageSlice = candidates.slice(start, start + limit);

    const pageTenants = pageSlice.map((c) => c.tenant);
    const [countsMap, adminsMap] = await Promise.all([
      this.fetchUserCounts(pageTenants),
      this.fetchPrimaryAdmins(pageTenants),
    ]);

    const data = pageSlice.map((c) =>
      this.toRow(
        c.tenant,
        c.subscription,
        adminsMap[c.tenant.id],
        countsMap[c.tenant.id],
      ),
    );

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Every organization matching the filters, as CSV. Headcounts come from the
   * directory rollup, so no organization database is opened for the export.
   */
  async exportOrganizations(query: GetPlatformOrganizationsQuery) {
    const candidates = await this.filteredCandidates(query);
    const tenants = candidates.map((c) => c.tenant);
    const [adminsMap, counters] = await Promise.all([
      this.fetchPrimaryAdmins(tenants),
      this.countersModel && tenants.length
        ? this.countersModel.findAll({
            where: { tenantId: { [Op.in]: tenants.map((t) => t.id) } },
            raw: true,
          })
        : Promise.resolve([]),
    ]);
    const counts = new Map<string, any>(
      (counters as any[]).map((c) => [c.tenantId, c]),
    );

    const STATUS: Record<string, string> = {
      ACTIVE: 'Active',
      TRIAL: 'Trial',
      PENDING: 'Pending',
      DEACTIVATED: 'Deactivated',
    };
    const INVITE: Record<string, string> = {
      PENDING: 'Sent',
      ACCEPTED: 'Accepted',
      EXPIRED: 'Expired',
      CANCELLED: 'Withdrawn',
    };
    const date = (d: Date | null | undefined) =>
      d ? new Date(d).toISOString().slice(0, 10) : '';
    // A leading = + - @ would be run as a formula by Excel/Sheets.
    const cell = (value: unknown) => {
      if (value === null || value === undefined) return '';
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const header = [
      'Organization',
      'Legal name',
      'Domain',
      'Status',
      'Setup',
      'Plan',
      'Subscription',
      'Primary admin',
      'Admin email',
      'Admin phone',
      'Invitation',
      'People',
      'Active people',
      'Industry',
      'Company size',
      'Country',
      'Official email',
      'Website',
      'Joined',
    ];
    const lines = candidates.map(({ tenant, subscription }) => {
      const row = this.toRow(
        tenant,
        subscription,
        adminsMap[tenant.id],
        undefined,
      );
      const c = counts.get(tenant.id);
      return [
        row.organizationName,
        tenant.legalName,
        tenant.domain,
        tenant.isActive ? (STATUS[row.status] ?? row.status) : 'Deactivated',
        row.setup.state === 'failed'
          ? `Failed — ${row.setup.error}`
          : row.setup.state === 'running'
            ? 'In progress'
            : 'Complete',
        row.planType,
        row.subscription.summary,
        row.primaryAdmin.name,
        row.primaryAdmin.email,
        row.primaryAdmin.phone,
        row.adminInvitation.status
          ? (INVITE[row.adminInvitation.status] ?? row.adminInvitation.status)
          : 'Not sent',
        c?.totalUsers ?? 0,
        c?.activeUsers ?? 0,
        tenant.industry,
        tenant.companySize,
        tenant.country,
        tenant.officialEmail,
        tenant.website,
        date(tenant.createdAt),
      ]
        .map(cell)
        .join(',');
    });

    return {
      filename: `organizations-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      csv: `﻿${[header.join(','), ...lines].join('\r\n')}`,
      total: candidates.length,
    };
  }

  /** Every tenant matching the filters, with its latest subscription, in the requested order. */
  private async filteredCandidates(query: GetPlatformOrganizationsQuery) {
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
    const allTenants = await this.tenantModel.findAll({
      where,
      order: [[sortBy, sortOrder]],
    });
    const subscriptionsMap = await this.fetchLatestSubscriptions(allTenants);

    let candidates = allTenants.map((tenant) => ({
      tenant,
      subscription: subscriptionsMap[tenant.id],
    }));

    if (query.status && query.status !== OrganizationStatusFilter.ALL) {
      candidates = candidates.filter(
        (c) => this.deriveStatus(c.tenant, c.subscription) === query.status,
      );
    }
    if (query.planType) {
      const planFilter = query.planType.toLowerCase();
      candidates = candidates.filter(
        (c) =>
          (
            c.subscription?.plan?.name ||
            c.tenant.planType ||
            ''
          ).toLowerCase() === planFilter,
      );
    }

    return candidates;
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
      ...this.toRow(
        tenant,
        subscriptionsMap[tenant.id],
        adminsMap[tenant.id],
        countsMap[tenant.id],
      ),
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
      const clash = await this.tenantModel.findOne({
        where: { domain: dto.domain },
      });
      if (clash && clash.id !== tenantId) {
        throw new TenantException(
          TenantErrorCode.INVALID_TENANT_CONTEXT,
          `Domain '${dto.domain}' is already used by another organization.`,
        );
      }
    }

    // Only keys actually present are applied, so an omitted field keeps its
    // stored value instead of being nulled by an undefined.
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(patch).length > 0) {
      await tenant.update(patch);
    }

    return this.getOrganizationById(tenantId);
  }

  /**
   * Platform-level switch, independent of the billing subscription lifecycle
   * (see /superadmin/billing/subscriptions/:id/suspend for that).
   *
   * Deactivating withdraws any invitation still waiting on the admin, so a
   * link already in their inbox can't bring a switched-off organization to
   * life. Reactivating returns the organization to wherever its onboarding
   * had got to — not straight to ACTIVE, which skipped admin activation and
   * setup for an organization whose admin had never signed in.
   */
  async updateOrganizationStatus(
    tenantId: string,
    status: OrganizationActionStatus,
  ) {
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Organization ${tenantId} not found`);
    }

    if (status === OrganizationActionStatus.ACTIVE) {
      if (tenant.status === TenantStatus.SUSPENDED || !tenant.isActive) {
        await tenant.update({
          status: await this.statusOnReactivation(tenant),
          isActive: true,
        });
        this.platformNotifier?.account(
          `Organization reactivated: ${tenant.organizationName || tenant.name}`,
          tenant.status === TenantStatus.PENDING_ADMIN_ACTIVATION
            ? 'It is back on and waiting for its admin to activate — send them a new invitation.'
            : 'Its users can sign in again.',
        );
      }
    } else if (tenant.status !== TenantStatus.SUSPENDED || tenant.isActive) {
      await this.tenantModel.sequelize!.transaction(async (transaction) => {
        await tenant.update(
          { status: TenantStatus.SUSPENDED, isActive: false },
          { transaction },
        );
        await this.invitationModel.update(
          { status: InvitationStatus.CANCELLED, cancelledAt: new Date() },
          {
            where: { tenantId, status: InvitationStatus.PENDING },
            transaction,
          },
        );
      });
      this.platformNotifier?.account(
        `Organization deactivated: ${tenant.organizationName || tenant.name}`,
        'Its users are signed out and blocked until it is activated again.',
      );
    }
    return this.getOrganizationById(tenantId);
  }

  /**
   * Where a reactivated organization's lifecycle resumes, read from what has
   * actually happened rather than stored at suspension time:
   * - setup finished                     → ACTIVE
   * - admin accepted, setup not finished → SETUP_IN_PROGRESS
   * - invited, admin never accepted      → PENDING_ADMIN_ACTIVATION
   * - no invitation on record (created before invitations existed) → ACTIVE
   */
  private async statusOnReactivation(tenant: Tenant): Promise<TenantStatus> {
    if (tenant.setupStatus === TenantSetupStatus.COMPLETED)
      return TenantStatus.ACTIVE;
    const invitations = await this.invitationModel.findAll({
      where: { tenantId: tenant.id },
      attributes: ['status'],
    });
    if (invitations.some((inv) => inv.status === InvitationStatus.ACCEPTED))
      return TenantStatus.SETUP_IN_PROGRESS;
    if (invitations.length > 0) return TenantStatus.PENDING_ADMIN_ACTIVATION;
    return TenantStatus.ACTIVE;
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
  async deleteOrganization(
    tenantId: string,
    confirmName: string,
  ): Promise<{ tenantId: string; organizationName: string }> {
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
      await this.billingEventModel.destroy({
        where: { tenantId },
        transaction: t,
      });
      await this.paymentModel.destroy({ where: { tenantId }, transaction: t });
      await this.invoiceModel.destroy({ where: { tenantId }, transaction: t });
      await this.subscriptionModel.destroy({
        where: { tenantId },
        transaction: t,
      });
      await this.invitationModel.destroy({
        where: { tenantId },
        transaction: t,
      });
    });

    // Point of no return: drops the tenant's isolated database and its
    // remaining platform rows (tenant_database_configs, tenants).
    await this.tenantProvisioningService.deprovisionTenant(tenantId);
    this.platformNotifier?.account(
      `Organization deleted: ${organizationName}`,
      'Its database, users and billing history were permanently removed.',
    );

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
      const lastMonth = subset.filter(
        (t) => t.createdAt >= prevMonthStart && t.createdAt < monthStart,
      ).length;
      if (lastMonth === 0) return thisMonth > 0 ? 100 : 0;
      return Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10;
    };

    const byCategory = (category: OrganizationStatusFilter) =>
      tenants.filter(
        (t) => this.deriveStatus(t, subscriptionsMap[t.id]) === category,
      );

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

  /**
   * Organizations registered in each of the last `months` calendar months
   * (current month included), split by the status each one holds today.
   * Status history isn't stored, so this deliberately doesn't claim what an
   * organization's status *was* in a past month.
   */
  async getOverview(months = 6) {
    const span = Math.min(Math.max(Math.trunc(months) || 6, 1), 24);
    const now = new Date();
    const windowStart = new Date(
      now.getFullYear(),
      now.getMonth() - (span - 1),
      1,
    );

    const tenants = await this.tenantModel.findAll({
      where: { createdAt: { [Op.gte]: windowStart } },
    });
    const subscriptionsMap = await this.fetchLatestSubscriptions(tenants);

    const buckets = Array.from({ length: span }, (_, i) => {
      const date = new Date(
        windowStart.getFullYear(),
        windowStart.getMonth() + i,
        1,
      );
      return {
        key: `${date.getFullYear()}-${date.getMonth()}`,
        label: date.toLocaleString('en-US', { month: 'short' }),
      };
    });
    const indexOf = new Map(buckets.map((b, i) => [b.key, i]));

    const categories = [
      {
        key: 'active',
        label: 'Active',
        status: OrganizationStatusFilter.ACTIVE,
      },
      { key: 'trial', label: 'Trial', status: OrganizationStatusFilter.TRIAL },
      {
        key: 'pending',
        label: 'Pending',
        status: OrganizationStatusFilter.PENDING,
      },
      {
        key: 'deactivated',
        label: 'Deactivated',
        status: OrganizationStatusFilter.DEACTIVATED,
      },
    ];
    const series = categories.map((c) => ({
      key: c.key,
      label: c.label,
      values: new Array<number>(span).fill(0),
    }));

    for (const tenant of tenants) {
      const created = new Date(tenant.createdAt);
      const index = indexOf.get(
        `${created.getFullYear()}-${created.getMonth()}`,
      );
      if (index === undefined) continue;
      const status = this.deriveStatus(tenant, subscriptionsMap[tenant.id]);
      const target = categories.findIndex((c) => c.status === status);
      if (target >= 0) series[target].values[index] += 1;
    }

    return { months: buckets.map((b) => b.label), series };
  }

  /** Every organization grouped by its current plan (latest subscription, else `planType`). */
  async getPlanBreakdown() {
    const tenants = await this.tenantModel.findAll();
    const subscriptionsMap = await this.fetchLatestSubscriptions(tenants);

    const counts = new Map<string, number>();
    for (const tenant of tenants) {
      const plan =
        subscriptionsMap[tenant.id]?.plan?.name || tenant.planType || 'No Plan';
      counts.set(plan, (counts.get(plan) ?? 0) + 1);
    }

    return {
      total: tenants.length,
      plans: [...counts.entries()]
        .map(([plan, count]) => ({ plan, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Organization- and billing-side conditions a platform admin should act on.
   * Only conditions that currently hold are returned; `at` is the most recent
   * timestamp behind each one, for a "time ago" label.
   */
  async getAlerts() {
    const tenants = await this.tenantModel.findAll();
    const subscriptionsMap = await this.fetchLatestSubscriptions(tenants);
    const now = Date.now();
    const weekAhead = now + 7 * 86400000;
    const plural = (n: number, one: string, many: string) =>
      `${n} ${n === 1 ? one : many}`;
    const latest = (dates: (Date | string | null | undefined)[]) => {
      const times = dates
        .filter(Boolean)
        .map((d) => new Date(d as Date).getTime());
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    };

    const rows = tenants.map((tenant) => ({
      tenant,
      subscription: subscriptionsMap[tenant.id],
    }));
    const alerts: {
      id: string;
      kind: 'warning' | 'document' | 'calendar';
      title: string;
      description: string;
      at: string | null;
    }[] = [];

    const failed = rows.filter(
      (r) => r.tenant.provisioningStatus === TenantProvisioningStatus.FAILED,
    );
    if (failed.length) {
      alerts.push({
        id: 'provisioning-failed',
        kind: 'warning',
        title: `${plural(failed.length, 'organization', 'organizations')} failed database provisioning`,
        description: 'Retry provisioning or remove the failed draft.',
        at: latest(failed.map((r) => r.tenant.updatedAt)),
      });
    }

    const overdue = rows.filter(
      (r) =>
        r.subscription &&
        DEACTIVATING_SUBSCRIPTION_STATUSES.includes(r.subscription.status),
    );
    if (overdue.length) {
      alerts.push({
        id: 'billing-overdue',
        kind: 'warning',
        title: `${plural(overdue.length, 'organization has', 'organizations have')} overdue or suspended subscriptions`,
        description: 'Please review and take action.',
        at: latest(
          overdue.map(
            (r) => r.subscription!.pastDueAt || r.subscription!.updatedAt,
          ),
        ),
      });
    }

    const pending = rows.filter(
      (r) =>
        this.deriveStatus(r.tenant, r.subscription) ===
        OrganizationStatusFilter.PENDING,
    );
    if (pending.length) {
      alerts.push({
        id: 'organizations-pending',
        kind: 'document',
        title: `${plural(pending.length, 'organization is', 'organizations are')} pending activation`,
        description: 'Awaiting admin activation, setup or first payment.',
        at: latest(pending.map((r) => r.tenant.createdAt)),
      });
    }

    const dueSoon = (status: SubscriptionStatus) =>
      rows.filter((r) => {
        if (
          r.subscription?.status !== status ||
          !r.subscription.nextBillingDate
        )
          return false;
        const due = new Date(r.subscription.nextBillingDate).getTime();
        return due >= now && due <= weekAhead;
      });

    const trialsEnding = dueSoon(SubscriptionStatus.TRIAL);
    if (trialsEnding.length) {
      alerts.push({
        id: 'trials-ending',
        kind: 'calendar',
        title: `${plural(trialsEnding.length, 'trial ends', 'trials end')} within 7 days`,
        description: 'Follow up before these organizations lose access.',
        at: latest(trialsEnding.map((r) => r.subscription!.updatedAt)),
      });
    }

    const renewals = dueSoon(SubscriptionStatus.ACTIVE);
    if (renewals.length) {
      alerts.push({
        id: 'renewals-due',
        kind: 'calendar',
        title: `${plural(renewals.length, 'subscription renews', 'subscriptions renew')} within 7 days`,
        description: 'Upcoming renewals for active organizations.',
        at: latest(renewals.map((r) => r.subscription!.updatedAt)),
      });
    }

    return alerts;
  }
}
