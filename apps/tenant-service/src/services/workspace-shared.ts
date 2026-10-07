import { HttpStatus, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { TenantErrorCode, TenantException } from '@app/common';
import { EmployeeNotificationKind } from '../models';
import type { TenantModelProviderService } from './tenant-model-provider.service';

/** Shared by the Tasks, Projects and Calendar services. */

export const workspaceError = (message: string, status: HttpStatus): never => {
  throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
};

/** Today as a calendar day (YYYY-MM-DD) in the server's timezone. */
export const todayIso = (): string => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const dayLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "20 Oct 2026" for a YYYY-MM-DD day. */
export const formatDay = (day: string | null | undefined): string =>
  day ? dayLabel.format(new Date(`${day}T00:00:00Z`)) : '';

export const fullName = (e: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim();

/** The employee fields every workspace row shows for a person. */
export const EMPLOYEE_SUMMARY_ATTRIBUTES = ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId'];

export const employeeSummary = (e: any) =>
  e
    ? {
        id: e.id,
        name: fullName(e),
        employeeCode: e.employeeCode ?? null,
        avatarUrl: e.avatarUrl ?? null,
        department: e.department ? { id: e.department.id, name: e.department.name } : null,
      }
    : null;

/** An employee plus their department, for `include`. */
export const employeeInclude = async (modelProvider: TenantModelProviderService, tenantId: string, as: string) => {
  const Employee = await modelProvider.getEmployeeModel(tenantId);
  const Department = await modelProvider.getDepartmentModel(tenantId);
  return {
    model: Employee,
    as,
    attributes: EMPLOYEE_SUMMARY_ATTRIBUTES,
    required: false,
    include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
  };
};

/** The employee row behind this login: user id first, then the same email. */
export const findSelfEmployee = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  userId: string,
  email?: string,
) => {
  const Employee = await modelProvider.getEmployeeModel(tenantId);
  let employee = await Employee.findOne({ where: { tenantId, userId } });
  if (!employee && email?.trim()) {
    employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } });
  }
  if (!employee) workspaceError('No employee profile is linked to this login.', HttpStatus.NOT_FOUND);
  return employee!;
};

/**
 * Inbox row for the assignee. Best effort: the task is already saved, so a
 * notification that can't be written must not turn that into an error.
 */
export const notifyEmployee = async (
  modelProvider: TenantModelProviderService,
  logger: Logger,
  tenantId: string,
  employeeId: string,
  title: string,
  body: string,
) => {
  try {
    const Notification = await modelProvider.getEmployeeNotificationModel(tenantId);
    await Notification.create({
      tenantId,
      employeeId,
      kind: EmployeeNotificationKind.GENERAL,
      title,
      body,
      readAt: null,
    });
  } catch (error: any) {
    logger.warn(`Task saved but the notification was not: ${error?.message ?? error}`);
  }
};

/** `{ field: { from, to } }` for the fields that actually changed — the audit log's `changes`. */
export const diffFields = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[key] ?? null;
    if ((from ?? null) !== (to ?? null)) changes[key] = { from, to };
  }
  return changes;
};
