import { Op } from 'sequelize';
import { OnboardingTaskCategory, OnboardingTaskStatus } from '@app/common';
import type { TenantModelProviderService } from './tenant-model-provider.service';
import { shiftDateOnly } from './onboarding-checklist';

/**
 * What departments add to onboarding and offboarding, worked out for one
 * person. Kept as plain functions over the model provider (like the approval
 * route lookup) so both entry points into onboarding (an admin adding a hire,
 * and a candidate reaching HIRED) and offboarding can use it without depending
 * on each other. A table that cannot be read adds nothing: the standard
 * checklist and clearance are never held up by it.
 */

/** The stage key of the nth department step on an offboarding case: DEPT-1, DEPT-2, ... */
export const DEPARTMENT_STAGE_PREFIX = 'DEPT-';
export const isDepartmentStage = (stage: string): boolean => /^DEPT-\d{1,3}$/.test(stage);

const MAX_DEPTH = 12;

/** The department and every department above it, nearest first. */
export const departmentChain = async (modelProvider: TenantModelProviderService, tenantId: string, departmentId: string | null | undefined): Promise<any[]> => {
  if (!departmentId) return [];
  const Department = await modelProvider.getDepartmentModel(tenantId);
  const chain: any[] = [];
  const seen = new Set<string>();
  let current: string | null = departmentId;
  for (let depth = 0; current && depth < MAX_DEPTH && !seen.has(current); depth++) {
    seen.add(current);
    const row: any = await Department.findOne({ where: { id: current, tenantId }, attributes: ['id', 'name', 'managerId', 'parentDepartmentId'], raw: true });
    if (!row) break;
    chain.push(row);
    current = row.parentDepartmentId ?? null;
  }
  return chain;
};

/** The active items of a kind that apply to this department: its own, its parents', and the organization-wide ones. */
export const checklistItemsFor = async (modelProvider: TenantModelProviderService, tenantId: string, kind: 'ONBOARDING' | 'OFFBOARDING', chain: any[]): Promise<any[]> => {
  const Item = await modelProvider.getDepartmentChecklistItemModel(tenantId);
  const ids = chain.map((row) => row.id);
  const rows = (await Item.findAll({
    where: { tenantId, kind, isActive: true, [Op.or]: [{ departmentId: null }, ...(ids.length ? [{ departmentId: { [Op.in]: ids } }] : [])] } as any,
  })) as any[];
  // The order each department set them in; where two departments tie, the one set first comes first.
  return rows.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
};

/** The head of the nearest department that has one. */
const headOf = (chain: any[]): string | null => chain.find((row) => row.managerId)?.managerId ?? null;

/** Onboarding tasks a hire's department adds, ready to insert after the standard checklist. */
export const onboardingTasksFor = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  newHireId: string,
  hire: { departmentId?: string | null; joiningDate: string; reportingManagerEmployeeId?: string | null },
): Promise<Record<string, unknown>[]> => {
  try {
    const chain = await departmentChain(modelProvider, tenantId, hire.departmentId);
    const items = await checklistItemsFor(modelProvider, tenantId, 'ONBOARDING', chain);
    const valid = new Set<string>(Object.values(OnboardingTaskCategory));
    return items.map((item, index) => ({
      tenantId,
      newHireId,
      title: item.title,
      description: item.description ?? null,
      category: valid.has(item.category) ? item.category : OnboardingTaskCategory.OTHER,
      status: OnboardingTaskStatus.PENDING,
      dueDate: shiftDateOnly(hire.joiningDate, Number(item.dueInDays) || 0),
      assignedToEmployeeId:
        item.ownerKind === 'DEPARTMENT_HEAD' ? headOf(chain) : item.ownerKind === 'REPORTING_MANAGER' ? (hire.reportingManagerEmployeeId ?? null) : item.ownerKind === 'EMPLOYEE' ? (item.ownerEmployeeId ?? null) : null,
      // After the standard items, in the order the department set them.
      sortOrder: 100 + index,
    }));
  } catch {
    return [];
  }
};

/**
 * Tells each person who now owns an onboarding task, once per person however
 * many tasks they were given. Best effort: the tasks are already saved.
 */
export const notifyTaskOwners = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  newHireId: string,
  tasks: { assignedToEmployeeId?: string | null; title: string }[],
): Promise<void> => {
  try {
    const owned = new Map<string, string[]>();
    for (const task of tasks) {
      if (!task.assignedToEmployeeId) continue;
      owned.set(task.assignedToEmployeeId, [...(owned.get(task.assignedToEmployeeId) ?? []), task.title]);
    }
    if (!owned.size) return;
    const NewHire = await modelProvider.getNewHireModel(tenantId);
    const hire: any = await NewHire.findOne({ where: { id: newHireId, tenantId }, attributes: ['firstName', 'lastName'] });
    const who = [hire?.firstName, hire?.lastName].filter(Boolean).join(' ') || 'a new hire';
    const Notification = await modelProvider.getEmployeeNotificationModel(tenantId);
    for (const [employeeId, titles] of owned) {
      const listed = titles.slice(0, 3).join('; ') + (titles.length > 3 ? ` and ${titles.length - 3} more` : '');
      await Notification.create({
        tenantId,
        employeeId,
        kind: 'GENERAL',
        title: titles.length === 1 ? `Onboarding task for ${who}` : `${titles.length} onboarding tasks for ${who}`,
        body: `${titles.length === 1 ? 'A task is' : 'Tasks are'} yours in ${who}'s onboarding: ${listed}.`,
        readAt: null,
      } as any);
    }
  } catch {
    /* the tasks are saved; a missed notification is not worth failing for */
  }
};

export interface DepartmentClearanceStep {
  row: Record<string, unknown>;
  /** The person told it is theirs, when it is a named person. */
  ownerEmployeeId: string | null;
  ownerPermission: string | null;
  title: string;
}

/** Clearance steps a leaver's department adds, ready to insert beside the standard ones. */
export const offboardingStepsFor = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  caseId: string,
  employee: { id: string; departmentId?: string | null; reportingManagerId?: string | null },
): Promise<DepartmentClearanceStep[]> => {
  try {
    const chain = await departmentChain(modelProvider, tenantId, employee.departmentId);
    const items = await checklistItemsFor(modelProvider, tenantId, 'OFFBOARDING', chain);
    return items.map((item, index) => {
      const resolved =
        item.ownerKind === 'DEPARTMENT_HEAD' ? headOf(chain) : item.ownerKind === 'REPORTING_MANAGER' ? (employee.reportingManagerId ?? null) : item.ownerKind === 'EMPLOYEE' ? (item.ownerEmployeeId ?? null) : null;
      // Nobody clears their own offboarding: a step that would fall to the leaver is left to HR.
      const ownerEmployeeId = resolved && resolved !== employee.id ? resolved : null;
      const ownerPermission = item.ownerKind === 'PERMISSION' ? (item.ownerPermission ?? null) : null;
      return {
        title: item.title as string,
        ownerEmployeeId,
        ownerPermission,
        row: {
          tenantId,
          caseId,
          stage: `${DEPARTMENT_STAGE_PREFIX}${index + 1}`,
          status: 'PENDING',
          label: item.title,
          description: item.description ?? null,
          ownerKind: item.ownerKind,
          ownerEmployeeId,
          ownerPermission,
          itemId: item.id,
        },
      };
    });
  } catch {
    return [];
  }
};
