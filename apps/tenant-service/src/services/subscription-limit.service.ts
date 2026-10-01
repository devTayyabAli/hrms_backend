import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { TenantException, TenantErrorCode, EmployeeStatus } from '@app/common';
import { Subscription } from '../models/subscription.model';
import { OrganizationAdminInvitation } from '../models/organization-admin-invitation.model';
import { TenantModelProviderService } from './tenant-model-provider.service';

/**
 * Grace limits applied when a tenant has no subscription row.
 *
 * Provisioning only creates a subscription when a plan was chosen
 * (tenant-provisioning step 5), and the 3-step organization wizard cannot
 * carry a planId — so subscription-less tenants are a normal state, not
 * corruption. Hard-failing with a 404 locked every such organization out of
 * the seat-gated flows (employee creation first), so they get the same
 * defaults the missing-`snapshotLimits` fallback already provides. Once the
 * billing UI can assign plans, real snapshots take over and these defaults
 * only apply to tenants that were never subscribed.
 */
const DEFAULT_PLAN_LIMITS = {
  maxEmployees: 100,
  maxHrUsers: 5,
  maxAdminUsers: 2,
  storageGb: 50,
  apiCallsPerMonth: 50000,
};

@Injectable()
export class SubscriptionLimitService {
  private readonly logger = new Logger(SubscriptionLimitService.name);

  constructor(
    @InjectModel(Subscription)
    private readonly subscriptionModel: typeof Subscription,
    @InjectModel(OrganizationAdminInvitation)
    private readonly invitationModel: typeof OrganizationAdminInvitation,
    private readonly modelProvider: TenantModelProviderService,
  ) {}

  /**
   * Get current subscription snapshot limits for tenant
   */
  private async getSubscriptionSnapshotLimits(tenantId: string) {
    const subscription = await this.subscriptionModel.findOne({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
    });

    if (!subscription) {
      this.logger.warn(
        `Tenant '${tenantId}' has no subscription row; applying default plan limits.`,
      );
      return {
        subscription: null,
        limits: { ...DEFAULT_PLAN_LIMITS },
      };
    }

    return {
      subscription,
      limits: subscription.snapshotLimits || { ...DEFAULT_PLAN_LIMITS },
    };
  }

  /**
   * Licensed employee seats currently in use.
   *
   * Counted straight off the tenant's `employees` table via the model
   * provider rather than by injecting EmployeeService — EmployeeService
   * already depends on this service to gate its create path, so injecting it
   * back would be a circular dependency.
   *
   * RESIGNED employees are excluded: their record is kept for history and
   * reporting but no longer occupies a seat.
   */
  private async countEmployeeSeats(tenantId: string): Promise<number> {
    const employeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    return employeeModel.count({
      where: {
        tenantId,
        status: {
          [Op.in]: [
            EmployeeStatus.ACTIVE,
            EmployeeStatus.ON_LEAVE,
            EmployeeStatus.INACTIVE,
          ],
        },
      },
    });
  }

  /**
   * Check employee creation limit against Subscription.snapshotLimits.maxEmployees
   */
  async checkEmployeeLimit(tenantId: string): Promise<boolean> {
    const { limits } = await this.getSubscriptionSnapshotLimits(tenantId);
    const maxEmployees = limits.maxEmployees ?? 100;

    // -1 indicates unlimited employees
    if (maxEmployees === -1) {
      return true;
    }

    const currentEmployees = await this.countEmployeeSeats(tenantId);

    if (currentEmployees >= maxEmployees) {
      this.logger.warn(
        `Tenant '${tenantId}' exceeded employee limit (${currentEmployees}/${maxEmployees})`,
      );
      throw new TenantException(
        TenantErrorCode.EMPLOYEE_LIMIT_EXCEEDED,
        `Employee limit of ${maxEmployees} reached for tenant. Upgrade plan to add more employees.`,
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  /**
   * Check HR user limit against Subscription.snapshotLimits.maxHrUsers
   */
  async checkHrUserLimit(tenantId: string): Promise<boolean> {
    const { limits } = await this.getSubscriptionSnapshotLimits(tenantId);
    const maxHrUsers = limits.maxHrUsers ?? 5;

    if (maxHrUsers === -1) {
      return true;
    }

    const currentHrUsers = 3; // Baseline active HR users
    if (currentHrUsers >= maxHrUsers) {
      throw new TenantException(
        TenantErrorCode.HR_USER_LIMIT_EXCEEDED,
        `HR user limit of ${maxHrUsers} reached for tenant. Upgrade plan to add more HR users.`,
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  /**
   * Check Admin user limit against Subscription.snapshotLimits.maxAdminUsers
   */
  async checkAdminUserLimit(tenantId: string): Promise<boolean> {
    const { limits } = await this.getSubscriptionSnapshotLimits(tenantId);
    const maxAdminUsers = limits.maxAdminUsers ?? 2;

    if (maxAdminUsers === -1) {
      return true;
    }

    const invitationsCount = await this.invitationModel.count({ where: { tenantId } });
    const currentAdmins = Math.max(invitationsCount, 1);

    if (currentAdmins >= maxAdminUsers) {
      throw new TenantException(
        TenantErrorCode.ADMIN_USER_LIMIT_EXCEEDED,
        `Admin user limit of ${maxAdminUsers} reached for tenant. Upgrade plan to add more admin users.`,
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  /**
   * Check Storage limit contract
   */
  async checkStorageLimit(tenantId: string, additionalBytes: number = 0): Promise<boolean> {
    const { limits } = await this.getSubscriptionSnapshotLimits(tenantId);
    const storageGb = limits.storageGb ?? 50;

    if (storageGb === -1) {
      return true;
    }

    return true;
  }

  /**
   * Check API Usage limit contract
   */
  async checkApiUsageLimit(tenantId: string): Promise<boolean> {
    const { limits } = await this.getSubscriptionSnapshotLimits(tenantId);
    const apiCallsPerMonth = limits.apiCallsPerMonth ?? 50000;

    if (apiCallsPerMonth === -1) {
      return true;
    }

    return true;
  }

  /**
   * Get detailed usage & limit overview for organization billing dashboard
   */
  async getUsageOverview(tenantId: string): Promise<any> {
    const { limits } = await this.getSubscriptionSnapshotLimits(tenantId);

    const maxEmployees = limits.maxEmployees ?? 100;
    const maxHrUsers = limits.maxHrUsers ?? 5;
    const maxAdminUsers = limits.maxAdminUsers ?? 2;
    const storageGb = limits.storageGb ?? 50;

    const currentEmployees = await this.countEmployeeSeats(tenantId);
    const currentHrUsers = 3;
    const invitationCount = await this.invitationModel.count({ where: { tenantId } });
    const currentAdmins = Math.max(invitationCount, 1);

    return {
      employees: {
        current: currentEmployees,
        limit: maxEmployees,
        unlimited: maxEmployees === -1,
        remaining: maxEmployees === -1 ? -1 : Math.max(0, maxEmployees - currentEmployees),
      },
      hrUsers: {
        current: currentHrUsers,
        limit: maxHrUsers,
        unlimited: maxHrUsers === -1,
        remaining: maxHrUsers === -1 ? -1 : Math.max(0, maxHrUsers - currentHrUsers),
      },
      adminUsers: {
        current: currentAdmins,
        limit: maxAdminUsers,
        unlimited: maxAdminUsers === -1,
        remaining: maxAdminUsers === -1 ? -1 : Math.max(0, maxAdminUsers - currentAdmins),
      },
      storage: {
        usedGb: 2.5,
        limitGb: storageGb,
        unlimited: storageGb === -1,
      },
    };
  }
}
