import { Injectable, BadRequestException } from '@nestjs/common';
import { Op } from 'sequelize';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { Permission } from '../models';

export interface SystemPermissionDef {
  resource: string;
  action: string;
  description: string;
  moduleKey: HRMSModuleKey;
}

// System permissions definition across modules
export const SYSTEM_PERMISSIONS: SystemPermissionDef[] = [
  // DASHBOARD
  { resource: 'dashboard', action: ModuleAction.VIEW, description: 'View organization dashboard and analytics', moduleKey: HRMSModuleKey.DASHBOARD },

  // EMPLOYEE
  { resource: 'employee', action: ModuleAction.VIEW, description: 'View employee directory and details', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'employee', action: ModuleAction.CREATE, description: 'Create new employee profiles', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'employee', action: ModuleAction.EDIT, description: 'Update employee profiles and information', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'employee', action: ModuleAction.DELETE, description: 'Deactivate or delete employee profiles', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'employee', action: ModuleAction.EXPORT, description: 'Export employee data', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'employee', action: ModuleAction.MANAGE, description: 'Full management of employee records', moduleKey: HRMSModuleKey.EMPLOYEE },

  // DEPARTMENTS
  { resource: 'departments', action: ModuleAction.VIEW, description: 'View department structure', moduleKey: HRMSModuleKey.DEPARTMENTS },
  { resource: 'departments', action: ModuleAction.CREATE, description: 'Create new departments', moduleKey: HRMSModuleKey.DEPARTMENTS },
  { resource: 'departments', action: ModuleAction.EDIT, description: 'Edit department details', moduleKey: HRMSModuleKey.DEPARTMENTS },
  { resource: 'departments', action: ModuleAction.DELETE, description: 'Delete departments', moduleKey: HRMSModuleKey.DEPARTMENTS },
  { resource: 'departments', action: ModuleAction.MANAGE, description: 'Manage departments and designations', moduleKey: HRMSModuleKey.DEPARTMENTS },

  // ATTENDANCE
  { resource: 'attendance', action: ModuleAction.VIEW, description: 'View employee attendance logs', moduleKey: HRMSModuleKey.ATTENDANCE },
  { resource: 'attendance', action: ModuleAction.CREATE, description: 'Mark or record attendance entries', moduleKey: HRMSModuleKey.ATTENDANCE },
  { resource: 'attendance', action: ModuleAction.EDIT, description: 'Edit or correct attendance entries', moduleKey: HRMSModuleKey.ATTENDANCE },
  { resource: 'attendance', action: ModuleAction.DELETE, description: 'Delete attendance entries', moduleKey: HRMSModuleKey.ATTENDANCE },
  { resource: 'attendance', action: ModuleAction.EXPORT, description: 'Export attendance logs and reports', moduleKey: HRMSModuleKey.ATTENDANCE },
  { resource: 'attendance', action: ModuleAction.MANAGE, description: 'Manage organization attendance policies', moduleKey: HRMSModuleKey.ATTENDANCE },

  // LEAVE MANAGEMENT
  { resource: 'leave_management', action: ModuleAction.VIEW, description: 'View leave requests and balances', moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT },
  { resource: 'leave_management', action: ModuleAction.CREATE, description: 'Apply for or submit leave requests', moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT },
  { resource: 'leave_management', action: ModuleAction.EDIT, description: 'Approve, reject, or edit leave requests', moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT },
  { resource: 'leave_management', action: ModuleAction.DELETE, description: 'Cancel or delete leave requests', moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT },
  { resource: 'leave_management', action: ModuleAction.EXPORT, description: 'Export leave requests and balances', moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT },
  { resource: 'leave_management', action: ModuleAction.MANAGE, description: 'Manage leave policies and types', moduleKey: HRMSModuleKey.LEAVE_MANAGEMENT },

  // PAYROLL
  { resource: 'payroll', action: ModuleAction.VIEW, description: 'View payroll records and payslips', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll', action: ModuleAction.CREATE, description: 'Generate payroll runs', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll', action: ModuleAction.EDIT, description: 'Set salaries and bank details; recalculate, adjust and submit payroll in Review', moduleKey: HRMSModuleKey.PAYROLL },
  // Separate from edit so whoever prepares a payroll needn't be able to sign
  // it off: approve, return to review, and mark as paid.
  { resource: 'payroll', action: 'approve', description: 'Approve payroll, return it to review, and mark it as paid', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll', action: ModuleAction.DELETE, description: 'Cancel payroll runs', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll', action: ModuleAction.EXPORT, description: 'Export payroll summary reports', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll', action: ModuleAction.MANAGE, description: 'Full payroll access, including approval', moduleKey: HRMSModuleKey.PAYROLL },
  // Compliance and tax: their own grants, so statutory setup and employees'
  // tax details can be kept to fewer people. payroll.manage covers both.
  { resource: 'payroll.compliance', action: ModuleAction.VIEW, description: 'View compliance rules and EOBI / provident fund reports', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.compliance', action: ModuleAction.MANAGE, description: 'Create, activate and retire tax, EOBI and provident fund rules', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.tax', action: ModuleAction.VIEW, description: 'View employee tax profiles, tax reports, annual summaries and certificates', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.tax', action: ModuleAction.MANAGE, description: 'Edit employee tax profiles and issue tax certificates', moduleKey: HRMSModuleKey.PAYROLL },
  // Compensation (Phase 4). payroll.manage covers all four areas; payroll.view
  // and payroll.edit keep what they already allowed (see the gateway).
  { resource: 'payroll.compensation', action: ModuleAction.VIEW, description: 'View salary structures, employee compensation and salary history', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.compensation', action: ModuleAction.MANAGE, description: 'Assign structures, revise compensation, recurring items and import', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.components', action: ModuleAction.VIEW, description: 'View the payroll component catalog', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.components', action: ModuleAction.MANAGE, description: 'Create and edit payroll components', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.loans', action: ModuleAction.VIEW, description: 'View employee loans and advances', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.loans', action: ModuleAction.MANAGE, description: 'Record and change loans and advances', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.adjustments', action: ModuleAction.VIEW, description: 'View bonuses, commissions, adjustments and reimbursements', moduleKey: HRMSModuleKey.PAYROLL },
  { resource: 'payroll.adjustments', action: ModuleAction.MANAGE, description: 'Add adjustments and approve reimbursements', moduleKey: HRMSModuleKey.PAYROLL },

  // REPORTS
  { resource: 'reports', action: ModuleAction.VIEW, description: 'View organizational reports', moduleKey: HRMSModuleKey.REPORTS },
  { resource: 'reports', action: ModuleAction.EXPORT, description: 'Export HR and financial reports', moduleKey: HRMSModuleKey.REPORTS },
  { resource: 'reports', action: ModuleAction.MANAGE, description: 'Create custom report definitions', moduleKey: HRMSModuleKey.REPORTS },

  // SETTINGS
  { resource: 'settings', action: ModuleAction.VIEW, description: 'View organization settings', moduleKey: HRMSModuleKey.SETTINGS },
  { resource: 'settings', action: ModuleAction.EDIT, description: 'Update organization profile and policies', moduleKey: HRMSModuleKey.SETTINGS },
  { resource: 'settings', action: ModuleAction.MANAGE, description: 'Manage all organization-level configurations', moduleKey: HRMSModuleKey.SETTINGS },

  // BILLING
  { resource: 'billing', action: ModuleAction.VIEW, description: 'View subscription, invoices, and payment history', moduleKey: HRMSModuleKey.SETTINGS },
  { resource: 'billing', action: ModuleAction.MANAGE, description: 'Manage subscription plan, payments, and billing operations', moduleKey: HRMSModuleKey.SETTINGS },

  // USER MANAGEMENT & ROLES
  { resource: 'user_management', action: ModuleAction.VIEW, description: 'View system users and assigned roles', moduleKey: HRMSModuleKey.USER_MANAGEMENT },
  { resource: 'user_management', action: ModuleAction.CREATE, description: 'Invite and create system users', moduleKey: HRMSModuleKey.USER_MANAGEMENT },
  { resource: 'user_management', action: ModuleAction.EDIT, description: 'Modify user accounts and status', moduleKey: HRMSModuleKey.USER_MANAGEMENT },
  { resource: 'user_management', action: ModuleAction.DELETE, description: 'Remove user accounts', moduleKey: HRMSModuleKey.USER_MANAGEMENT },
  { resource: 'user_management', action: ModuleAction.MANAGE, description: 'Manage roles, permissions, and access control', moduleKey: HRMSModuleKey.USER_MANAGEMENT },

  // PERFORMANCE
  { resource: 'performance', action: ModuleAction.VIEW, description: 'View performance appraisals and goals', moduleKey: HRMSModuleKey.PERFORMANCE },
  { resource: 'performance', action: ModuleAction.CREATE, description: 'Create performance reviews and goals', moduleKey: HRMSModuleKey.PERFORMANCE },
  { resource: 'performance', action: ModuleAction.EDIT, description: 'Update review cycles and goal status', moduleKey: HRMSModuleKey.PERFORMANCE },
  { resource: 'performance', action: ModuleAction.MANAGE, description: 'Manage performance review cycles', moduleKey: HRMSModuleKey.PERFORMANCE },

  // ONBOARDING — no module of its own; it rides with EMPLOYEE.
  { resource: 'onboarding', action: ModuleAction.VIEW, description: 'View new hires and onboarding checklists', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'onboarding', action: ModuleAction.CREATE, description: 'Add new hires and onboarding tasks', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'onboarding', action: ModuleAction.EDIT, description: 'Update onboarding tasks and progress', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'onboarding', action: ModuleAction.DELETE, description: 'Remove new hires and onboarding tasks', moduleKey: HRMSModuleKey.EMPLOYEE },
  { resource: 'onboarding', action: ModuleAction.MANAGE, description: 'Full management of onboarding', moduleKey: HRMSModuleKey.EMPLOYEE },

  // RECRUITMENT
  { resource: 'recruitment', action: ModuleAction.VIEW, description: 'View recruitment pipelines and candidates', moduleKey: HRMSModuleKey.RECRUITMENT },
  { resource: 'recruitment', action: ModuleAction.CREATE, description: 'Create job openings, candidates and interviews', moduleKey: HRMSModuleKey.RECRUITMENT },
  { resource: 'recruitment', action: ModuleAction.EDIT, description: 'Update job openings, candidates and interviews', moduleKey: HRMSModuleKey.RECRUITMENT },
  { resource: 'recruitment', action: ModuleAction.DELETE, description: 'Delete job openings, candidates and interviews', moduleKey: HRMSModuleKey.RECRUITMENT },
  { resource: 'recruitment', action: ModuleAction.MANAGE, description: 'Manage job postings and candidate hiring', moduleKey: HRMSModuleKey.RECRUITMENT },

  // EXTENSIBLE FUTURE MODULES

  { resource: 'projects', action: ModuleAction.VIEW, description: 'View organization projects', moduleKey: HRMSModuleKey.PROJECTS },
  { resource: 'projects', action: ModuleAction.MANAGE, description: 'Manage projects and assignments', moduleKey: HRMSModuleKey.PROJECTS },

  { resource: 'expenses', action: ModuleAction.VIEW, description: 'View expense claims', moduleKey: HRMSModuleKey.EXPENSES },
  { resource: 'expenses', action: ModuleAction.MANAGE, description: 'Approve and process expense claims', moduleKey: HRMSModuleKey.EXPENSES },

  { resource: 'assets', action: ModuleAction.VIEW, description: 'View company assets', moduleKey: HRMSModuleKey.ASSETS },
  { resource: 'assets', action: ModuleAction.MANAGE, description: 'Manage asset allocations', moduleKey: HRMSModuleKey.ASSETS },

  { resource: 'tickets', action: ModuleAction.VIEW, description: 'View support tickets', moduleKey: HRMSModuleKey.TICKETS },
  { resource: 'tickets', action: ModuleAction.MANAGE, description: 'Resolve and manage support tickets', moduleKey: HRMSModuleKey.TICKETS },
];

/**
 * 'resource.action' or 'resource:action' → its parts. The action is after the
 * last separator: a resource may itself be dotted ('payroll.tax.view').
 */
export const splitPermissionKey = (input: string): { resource: string; action: string } | null => {
  const separator = Math.max(input.lastIndexOf('.'), input.lastIndexOf(':'));
  if (separator <= 0 || separator === input.length - 1) return null;
  return { resource: input.slice(0, separator), action: input.slice(separator + 1) };
};

@Injectable()
export class PermissionRegistryService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  /**
   * Seed standard system permissions into the active tenant database if missing
   */
  async seedStandardPermissions(tenantId: string): Promise<void> {
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);

    // One read, then at most one write — instead of a findOne per catalogue
    // entry followed by a create per miss. This runs on every call to
    // resolvePermissionIds and getAvailablePermissions, so with ~60
    // definitions it was ~60 sequential round trips on every permissions
    // screen load and every role save, almost always to discover that
    // everything is already there.
    const existing = (await PermissionModel.findAll({
      attributes: ['resource', 'action'],
      raw: true,
    })) as unknown as Array<{ resource: string; action: string }>;

    const present = new Set(
      existing.map((row) => `${row.resource}::${row.action}`),
    );

    const missing = SYSTEM_PERMISSIONS.filter(
      (def) => !present.has(`${def.resource}::${def.action}`),
    );

    if (missing.length === 0) {
      return;
    }

    await PermissionModel.bulkCreate(
      missing.map((def) => ({
        resource: def.resource,
        action: def.action,
        description: def.description,
      })) as any[],
      {
        // Two concurrent callers can both observe the same row missing and
        // both try to insert it. The unique index on (resource, action) is
        // what makes that safe, and this is what turns the resulting conflict
        // into a no-op rather than a failed role save.
        ignoreDuplicates: true,
      },
    );
  }

  /**
   * Retrieve permissions grouped by module/resource, filtered by enabled organization modules
   */
  async getAvailablePermissions(tenantId: string, enabledModuleKeys?: string[]): Promise<Record<string, Array<{ id: string; key: string; resource: string; action: string; description: string }>>> {
    await this.seedStandardPermissions(tenantId);
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);
    const allPermissions = await PermissionModel.findAll();

    const result: Record<string, Array<{ id: string; key: string; resource: string; action: string; description: string }>> = {};

    for (const perm of allPermissions) {
      // Find matching definition to determine moduleKey
      const match = SYSTEM_PERMISSIONS.find(
        (def) => def.resource === perm.resource && def.action === perm.action,
      );

      const moduleKey = match ? match.moduleKey : (perm.resource as HRMSModuleKey);

      // If enabledModuleKeys list is provided, filter out permissions belonging to disabled modules
      if (enabledModuleKeys && enabledModuleKeys.length > 0) {
        if (!enabledModuleKeys.includes(moduleKey)) {
          continue;
        }
      }

      if (!result[perm.resource]) {
        result[perm.resource] = [];
      }

      result[perm.resource].push({
        id: perm.id,
        key: `${perm.resource}.${perm.action}`,
        resource: perm.resource,
        action: perm.action,
        description: perm.description,
      });
    }

    return result;
  }

  /**
   * Resolve and validate permission input array (accepting UUIDs or 'resource.action' keys)
   */
  async resolvePermissionIds(tenantId: string, permissionInputs: string[]): Promise<string[]> {
    if (!permissionInputs || permissionInputs.length === 0) {
      return [];
    }

    await this.seedStandardPermissions(tenantId);
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);

    // Everything the caller might have meant, fetched in one query.
    //
    // The previous version issued one or two queries per input — saving a
    // role with forty permissions meant up to eighty sequential round trips,
    // on a request a user is waiting on. Inputs come in two forms (a UUID, or
    // a 'resource.action' / 'resource:action' key), so both are matched in a
    // single OR and then resolved locally.
    const uuidInputs: string[] = [];
    const keyPairs: Array<{ resource: string; action: string }> = [];

    for (const input of permissionInputs) {
      if (input.includes('-') && input.length === 36) {
        uuidInputs.push(input);
      }
      const pair = splitPermissionKey(input);
      if (pair) {
        keyPairs.push(pair);
      }
    }

    const or: any[] = [];
    if (uuidInputs.length > 0) {
      or.push({ id: { [Op.in]: uuidInputs } });
    }
    for (const pair of keyPairs) {
      or.push({ resource: pair.resource, action: pair.action });
    }

    const found: Permission[] =
      or.length > 0
        ? await PermissionModel.findAll({ where: { [Op.or]: or } })
        : [];

    const byId = new Map(found.map((perm) => [perm.id, perm]));
    const byKey = new Map(
      found.map((perm) => [`${perm.resource}::${perm.action}`, perm]),
    );

    const resolvedIds: string[] = [];

    for (const input of permissionInputs) {
      let perm = byId.get(input);

      if (!perm) {
        const pair = splitPermissionKey(input);
        if (pair) {
          perm = byKey.get(`${pair.resource}::${pair.action}`);
        }
      }

      if (!perm) {
        throw new BadRequestException(`Invalid or unknown permission key/ID: '${input}'`);
      }

      // Check for platform-level permission attempt
      if (perm.resource.startsWith('platform.') || perm.resource.startsWith('superadmin.')) {
        throw new BadRequestException(`Organization Admins cannot assign platform-level permissions.`);
      }

      if (!resolvedIds.includes(perm.id)) {
        resolvedIds.push(perm.id);
      }
    }

    return resolvedIds;
  }
}
