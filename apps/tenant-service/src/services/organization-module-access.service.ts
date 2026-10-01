import { Injectable, Logger } from '@nestjs/common';
import { ConfigureModuleAccessDto, HRMSModuleKey, ModuleAction } from '@app/common';
import { OrganizationModuleAccess } from '../models/organization-module-access.model';
import { TenantModelProviderService } from './tenant-model-provider.service';

const DEFAULT_MODULES: ConfigureModuleAccessDto[] = [
  { moduleKey: HRMSModuleKey.DASHBOARD, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.EMPLOYEE, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.DEPARTMENTS, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.ATTENDANCE, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.PAYROLL, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.REPORTS, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.SETTINGS, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.USER_MANAGEMENT, enabled: true, allowedActions: [ModuleAction.ALL] },
  { moduleKey: HRMSModuleKey.PERFORMANCE, enabled: true, allowedActions: [ModuleAction.ALL] },
];

/**
 * OrganizationModuleAccess lives in each tenant's own physical database
 * (see TenantModelProviderService). `isModuleEnabled` is called on the
 * gateway's authorization hot path (OrganizationModuleGuard) for nearly
 * every authenticated request — safe because the tenant's database is
 * guaranteed to already exist by the time any authenticated request can
 * reach here (TenantProvisioningService creates it during onboarding,
 * before the tenant ever reaches PENDING_ADMIN_ACTIVATION), and
 * TenantConnectionManager caches the connection after the first use.
 */
@Injectable()
export class OrganizationModuleAccessService {
  private readonly logger = new Logger(OrganizationModuleAccessService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  /**
   * Set or update organization module access configuration
   */
  async setOrganizationModules(
    tenantId: string,
    modules: ConfigureModuleAccessDto[],
  ): Promise<OrganizationModuleAccess[]> {
    let modulesToSave: ConfigureModuleAccessDto[];
    if (modules && modules.length > 0) {
      const explicitKeys = new Set(modules.map((m) => m.moduleKey.toLowerCase()));
      modulesToSave = [...modules];

      // Ensure any system module not explicitly provided is recorded as disabled
      for (const key of Object.values(HRMSModuleKey)) {
        const lowerKey = key.toLowerCase();
        if (!explicitKeys.has(lowerKey)) {
          modulesToSave.push({
            moduleKey: lowerKey,
            enabled: false,
            allowedActions: [ModuleAction.ALL],
          });
        }
      }
    } else {
      modulesToSave = DEFAULT_MODULES;
    }

    const moduleAccessModel = await this.modelProvider.getOrganizationModuleAccessModel(tenantId);

    const recordsToUpsert = modulesToSave.map((mod) => ({
      tenantId,
      moduleKey: mod.moduleKey.toLowerCase(),
      enabled: mod.enabled,
      allowedActions: mod.allowedActions || [ModuleAction.ALL],
    }));

    const results = await moduleAccessModel.bulkCreate(recordsToUpsert, {
      updateOnDuplicate: ['enabled', 'allowedActions', 'updatedAt'],
    });

    this.logger.log(`Saved ${results.length} module access rules for tenant ${tenantId}`);
    return results;
  }

  /**
   * Retrieve configured module access list for a tenant
   */
  async getOrganizationModules(tenantId: string): Promise<OrganizationModuleAccess[]> {
    const moduleAccessModel = await this.modelProvider.getOrganizationModuleAccessModel(tenantId);
    const existing = await moduleAccessModel.findAll({
      where: { tenantId },
      order: [['moduleKey', 'ASC']],
    });

    if (existing && existing.length > 0) {
      return existing;
    }

    // If no explicit config exists yet, initialize with default active modules
    return this.setOrganizationModules(tenantId, DEFAULT_MODULES);
  }

  /**
   * Check if a specific module is enabled for a tenant, and optionally check action permission
   */
  async isModuleEnabled(
    tenantId: string,
    moduleKey: string,
    action?: string,
  ): Promise<{ enabled: boolean; allowed: boolean; reason?: string }> {
    const key = moduleKey.toLowerCase();
    const moduleAccessModel = await this.modelProvider.getOrganizationModuleAccessModel(tenantId);
    const record = await moduleAccessModel.findOne({
      where: { tenantId, moduleKey: key },
    });

    if (!record) {
      // Check default fallback: if module is in default list, enable by default
      const defaultMod = DEFAULT_MODULES.find((m) => m.moduleKey === key);
      if (defaultMod) {
        return { enabled: defaultMod.enabled, allowed: true };
      }
      return {
        enabled: false,
        allowed: false,
        reason: `Module '${moduleKey}' is not configured or enabled for this organization.`,
      };
    }

    if (!record.enabled) {
      return {
        enabled: false,
        allowed: false,
        reason: `Module '${moduleKey}' is disabled for this organization.`,
      };
    }

    if (action) {
      const actions = record.allowedActions || [];
      const hasAction =
        actions.includes(ModuleAction.ALL) ||
        actions.includes(action.toLowerCase()) ||
        actions.includes(action);

      if (!hasAction) {
        return {
          enabled: true,
          allowed: false,
          reason: `Action '${action}' is not allowed for module '${moduleKey}' in this organization.`,
        };
      }
    }

    return { enabled: true, allowed: true };
  }
}
