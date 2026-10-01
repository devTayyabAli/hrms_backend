import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Tenant, TenantStatus, TenantSetupStatus, TenantProvisioningStatus } from '../models/tenant.model';

@Injectable()
export class TenantService {
  constructor(
    @InjectModel(Tenant)
    private tenantModel: typeof Tenant,
  ) {}

  /**
   * Create a new tenant record
   */
  async createTenant(data: {
    name: string;
    organizationName?: string;
    slug?: string;
    domain?: string;
    email?: string;
    adminEmail?: string;
    industry?: string;
    phone?: string;
    country?: string;
    legalName?: string;
    companySize?: string;
    officialEmail?: string;
    logoUrl?: string;
    adminDesignation?: string;
    adminAvatarUrl?: string;
    state?: string;
    city?: string;
    address?: string;
    timezone?: string;
    currency?: string;
    planType?: string;
    status?: TenantStatus;
    setupStatus?: TenantSetupStatus;
    provisioningStatus?: TenantProvisioningStatus;
    isActive?: boolean;
  }): Promise<Tenant> {
    return this.tenantModel.create({
      name: data.name,
      organizationName: data.organizationName || data.name,
      legalName: data.legalName || data.organizationName || data.name,
      companySize: data.companySize,
      officialEmail: data.officialEmail || data.email,
      logoUrl: data.logoUrl,
      slug: data.slug || data.domain,
      domain: data.domain || data.slug,
      email: data.email || data.adminEmail,
      adminEmail: data.adminEmail || data.email,
      adminDesignation: data.adminDesignation,
      adminAvatarUrl: data.adminAvatarUrl,
      industry: data.industry,
      phone: data.phone,
      country: data.country,
      state: data.state,
      city: data.city,
      address: data.address,
      timezone: data.timezone,
      currency: data.currency,
      planType: data.planType || 'standard',
      status: data.status || TenantStatus.DRAFT,
      setupStatus: data.setupStatus || TenantSetupStatus.NOT_STARTED,
      provisioningStatus: data.provisioningStatus || TenantProvisioningStatus.PENDING,
      isActive: data.isActive ?? true,
    });
  }

  /**
   * Get tenant by ID
   */
  async getTenantById(tenantId: string): Promise<Tenant> {
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }
    return tenant;
  }

  /**
   * Find tenant by domain or slug
   */
  async getTenantByDomainOrSlug(slugOrDomain: string): Promise<Tenant | null> {
    return this.tenantModel.findOne({
      where: {
        [Op.or]: [
          { slug: slugOrDomain },
          { domain: slugOrDomain },
        ],
      },
    });
  }

  /**
   * Get all tenants
   */
  async getAllTenants(): Promise<Tenant[]> {
    return this.tenantModel.findAll();
  }

  /**
   * Get tenants with optional search + pagination.
   * Omitting `limit` returns every matching tenant (used for cross-tenant aggregation).
   */
  async getAllTenantsPaginated(
    options: { page?: number; limit?: number; search?: string } = {},
  ): Promise<{ data: Tenant[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const hasLimit = !!options.limit && options.limit > 0;
    const limit = hasLimit ? options.limit : undefined;

    const where = options.search
      ? {
          [Op.or]: [
            { name: { [Op.iLike]: `%${options.search}%` } },
            { organizationName: { [Op.iLike]: `%${options.search}%` } },
            { domain: { [Op.iLike]: `%${options.search}%` } },
          ],
        }
      : undefined;

    const { rows, count } = await this.tenantModel.findAndCountAll({
      where,
      limit,
      offset: hasLimit ? (page - 1) * limit! : undefined,
      order: [['createdAt', 'DESC']],
    });

    return {
      data: rows,
      total: count,
      page,
      limit: limit ?? count,
      totalPages: hasLimit ? Math.ceil(count / limit!) || 1 : 1,
    };
  }

  /**
   * Update tenant
   */
  async updateTenant(
    tenantId: string,
    updates: Partial<Tenant>,
  ): Promise<Tenant> {
    const tenant = await this.getTenantById(tenantId);
    return tenant.update(updates);
  }

  /**
   * Delete tenant
   */
  async deleteTenant(tenantId: string): Promise<void> {
    const tenant = await this.getTenantById(tenantId);
    await tenant.destroy();
  }

  /**
   * Get tenants by plan type
   */
  async getTenantsByPlan(planType: string): Promise<Tenant[]> {
    return this.tenantModel.findAll({
      where: { planType },
    });
  }
}
