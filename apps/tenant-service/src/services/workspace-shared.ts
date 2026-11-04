import { HttpStatus, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { grantsPermission, TenantErrorCode, TenantException } from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { EmployeeNotificationKind } from '../models';
import type { TenantModelProviderService } from './tenant-model-provider.service';

/** Shared by the Tasks, Projects and Calendar services. */

export const workspaceError = (message: string, status: HttpStatus): never => {
  throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
};

/**
 * Full access, or the Confidential grant (which Manage also covers).
 * No signed caller means a job or a test, which is not a person browsing.
 */
export const seesConfidentialProjects = (): boolean => {
  const actor = currentRpcActor();
  if (!actor) return true;
  if (actor.isFullAccess || actor.isSuperAdmin) return true;
  return grantsPermission(actor.permissions ?? [], 'projects.confidential');
};

/** Projects this one employee owns, belongs to, or has a task on. */
export const involvedProjectIds = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  employeeId: string,
): Promise<string[]> => {
  const Project = await modelProvider.getWorkspaceProjectModel(tenantId);
  const Member = await modelProvider.getWorkspaceProjectMemberModel(tenantId);
  const Task = await modelProvider.getWorkspaceTaskModel(tenantId);
  const Assignee = await modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
  const [led, memberships, primary, extras] = await Promise.all([
    Project.findAll({ where: { tenantId, leadEmployeeId: employeeId }, attributes: ['id'], raw: true }) as Promise<{ id: string }[]>,
    Member.findAll({ where: { tenantId, employeeId }, attributes: ['projectId'], raw: true }) as Promise<{ projectId: string }[]>,
    Task.findAll({
      where: { tenantId, assigneeEmployeeId: employeeId, projectId: { [Op.ne]: null } },
      attributes: ['projectId'],
      raw: true,
    }) as Promise<{ projectId: string }[]>,
    Assignee.findAll({ where: { tenantId, employeeId }, attributes: ['taskId'], raw: true }) as Promise<{ taskId: string }[]>,
  ]);
  const extraIds = [...new Set(extras.map((row) => row.taskId))];
  const extraProjects = extraIds.length
    ? ((await Task.findAll({
        where: { tenantId, id: { [Op.in]: extraIds }, projectId: { [Op.ne]: null } },
        attributes: ['projectId'],
        raw: true,
      })) as { projectId: string }[])
    : [];
  return [...new Set([...led.map((row) => row.id), ...memberships.map((row) => row.projectId), ...primary.map((row) => row.projectId), ...extraProjects.map((row) => row.projectId)])];
};

/** Projects this one employee owns. */
export const ledProjectIds = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  employeeId: string,
): Promise<string[]> => {
  const Project = await modelProvider.getWorkspaceProjectModel(tenantId);
  const rows = (await Project.findAll({
    where: { tenantId, leadEmployeeId: employeeId },
    attributes: ['id'],
    raw: true,
  })) as unknown as { id: string }[];
  return rows.map((row) => row.id);
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
/** Null or a missing settings row means the reminder is on. */
export const workspaceNoticePrefs = async (modelProvider: TenantModelProviderService, tenantId: string) => {
  const Setting = await modelProvider.getWorkspaceSettingModel(tenantId);
  const row = await Setting.findOne({ where: { tenantId } });
  const on = (value: boolean | null | undefined) => value !== false;
  return {
    deadlineReminders: on(row?.deadlineRemindersEnabled),
    overdueReminders: on(row?.overdueRemindersEnabled),
    reviewReminders: on(row?.reviewRemindersEnabled),
    projectStatusChanges: on(row?.projectStatusNotificationsEnabled),
    assignmentNotices: on(row?.assignmentNotificationsEnabled),
  };
};

/** Calendar arithmetic on a YYYY-MM-DD string, without a timezone shift. */
/** A Date or ISO string as YYYY-MM-DD in UTC. Null when it cannot be read. */
export const calendarDay = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

export const addDays = (iso: string, days: number): string => {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

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
/**
 * Whether a task due date sits outside the project's start and expected end.
 * A missing project, or a project with neither date, has no window.
 * Dates are YYYY-MM-DD, so string order is calendar order.
 */
export const taskDueOutsideProject = (
  dueDate: string,
  project: { startDate?: string | null; dueDate?: string | null } | null,
): { outside: boolean; message: string | null } => {
  if (!project) return { outside: false, message: null };
  const start = project.startDate || null;
  const end = project.dueDate || null;
  if (!start && !end) return { outside: false, message: null };
  const beforeStart = Boolean(start && dueDate < start);
  const afterEnd = Boolean(end && dueDate > end);
  if (!beforeStart && !afterEnd) return { outside: false, message: null };
  const window = start && end ? `${start} to ${end}` : start ? `on or after ${start}` : `on or before ${end}`;
  return {
    outside: true,
    message: `This due date is outside the project dates (${window}). Record an authorized exception to keep it.`,
  };
};

export const diffFields = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[key] ?? null;
    if ((from ?? null) !== (to ?? null)) changes[key] = { from, to };
  }
  return changes;
};
