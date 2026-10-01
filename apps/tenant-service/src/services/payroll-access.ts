import { HttpStatus, Logger } from '@nestjs/common';
import { TenantErrorCode, TenantException, grantsPermission } from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import type { TenantModelProviderService } from './tenant-model-provider.service';

/**
 * Who is acting on payroll, whether they may, and the audit entry for it —
 * shared by the payroll and payslip services so both apply one rule.
 */

export interface PayrollActor {
  /** False only for internal calls and tests, which carry no signed caller. */
  present: boolean;
  userId: string | null;
  email: string | null;
  isFullAccess: boolean;
  permissions: string[];
}

export const payrollActor = (): PayrollActor => {
  const actor = currentRpcActor();
  return {
    present: Boolean(actor),
    userId: actor?.userId ?? null,
    email: actor?.email?.toLowerCase() ?? null,
    isFullAccess: Boolean(actor?.isFullAccess),
    permissions: actor?.permissions ?? [],
  };
};

export const payrollError = (message: string, status: HttpStatus): never => {
  throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
};

/**
 * The gateway already requires the permission for the route; this is the
 * same rule again where the data lives, so a message that reaches the
 * service another way can't skip it.
 */
export const requirePayrollPermission = (permission: string, what: string) => {
  const actor = payrollActor();
  if (!actor.present || actor.isFullAccess) return;
  if (!grantsPermission(actor.permissions, permission)) {
    payrollError(`You don't have permission to ${what}.`, HttpStatus.FORBIDDEN);
  }
};

/** Allowed with any one of `permissions` (each honouring `.manage` and full access). */
export const requireAnyPayrollPermission = (permissions: string[], what: string) => {
  const actor = payrollActor();
  if (!actor.present || actor.isFullAccess) return;
  if (!permissions.some((permission) => grantsPermission(actor.permissions, permission))) {
    payrollError(`You don't have permission to ${what}.`, HttpStatus.FORBIDDEN);
  }
};

/**
 * One row in the organization's audit log (`entity_audit_logs`), with the
 * caller's email alongside their id. A failure to record is logged loudly
 * but never undoes the change it describes.
 */
export const writePayrollAudit = async (
  modelProvider: TenantModelProviderService,
  logger: Logger,
  tenantId: string,
  tableName: string,
  recordId: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  changes: Record<string, { from: unknown; to: unknown }>,
) => {
  try {
    const Log = await modelProvider.getEntityAuditLogModel(tenantId);
    const actor = payrollActor();
    await Log.create({
      tableName,
      recordId,
      action,
      userId: actor.userId,
      changes: { ...changes, ...(actor.email ? { actor: { from: null, to: actor.email } } : {}) },
    });
  } catch (error: any) {
    logger.error(`Could not write payroll audit log (${tableName} ${recordId}): ${error?.message ?? error}`);
  }
};
