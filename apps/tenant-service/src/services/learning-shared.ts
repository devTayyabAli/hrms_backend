import { QueryTypes } from 'sequelize';
import { TrainingAssignmentStatus, TrainingAssignmentViewStatus } from '@app/common';
import type { TenantModelProviderService } from './tenant-model-provider.service';

/** Shared by the admin and the employee sides of assigned learning. */

/** Not finished and not cancelled: the person still has it to do. */
export const OPEN_ASSIGNMENT_STATUSES: string[] = [TrainingAssignmentStatus.NOT_STARTED, TrainingAssignmentStatus.IN_PROGRESS];

/** Calendar arithmetic on a YYYY-MM-DD string, without a timezone shift. */
export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

const dayOf = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

/** The stored status, except an open assignment past its due date, which reads OVERDUE. */
export const viewStatusOf = (status: string, dueDate: string | null | undefined, today: string): TrainingAssignmentViewStatus => {
  if (OPEN_ASSIGNMENT_STATUSES.includes(status) && dueDate && dueDate < today) return TrainingAssignmentViewStatus.OVERDUE;
  return status as TrainingAssignmentViewStatus;
};

/** Finished after its due date. */
export const finishedLate = (assignment: { status: string; dueDate?: string | null; completedAt?: unknown }): boolean => {
  const finished = dayOf(assignment.completedAt);
  return assignment.status === TrainingAssignmentStatus.COMPLETED && Boolean(assignment.dueDate) && finished !== null && finished > assignment.dueDate!;
};

/** Whole days an open assignment is past its due date (0 when it is not). */
export const daysOverdue = (dueDate: string | null | undefined, today: string): number =>
  dueDate && dueDate < today ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000) : 0;

/** What every view of an assignment shows. */
export const assignmentCore = (assignment: any, today: string) => {
  const open = OPEN_ASSIGNMENT_STATUSES.includes(assignment.status);
  return {
    id: assignment.id as string,
    courseId: assignment.courseId as string,
    courseTitle: assignment.courseTitle as string,
    status: viewStatusOf(assignment.status, assignment.dueDate, today),
    progressStatus: assignment.status as TrainingAssignmentStatus,
    mandatory: assignment.mandatory === true,
    dueDate: (assignment.dueDate ?? null) as string | null,
    overdueDays: open ? daysOverdue(assignment.dueDate, today) : 0,
    assignedAt: assignment.createdAt as Date,
    startedAt: (assignment.startedAt ?? null) as Date | null,
    completedAt: (assignment.completedAt ?? null) as Date | null,
    completedLate: finishedLate(assignment),
    source: assignment.source as string,
  };
};

export interface AssignmentProgress {
  opened: number;
  total: number;
  percent: number;
}

/** How many of each course's materials each person has opened, for a page of assignments. */
export const progressFor = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  assignments: { id: string; courseId: string }[],
): Promise<Map<string, AssignmentProgress>> => {
  const result = new Map<string, AssignmentProgress>();
  if (!assignments.length) return result;
  const Progress = await modelProvider.getTrainingProgressModel(tenantId);
  const assignmentIds = assignments.map((assignment) => assignment.id);
  const courseIds = [...new Set(assignments.map((assignment) => assignment.courseId))];

  const [opened, totals] = await Promise.all([
    Progress.sequelize!.query(
      `SELECT "assignmentId", COUNT(*)::int AS "count" FROM training_progress WHERE "tenantId" = :tenantId AND "assignmentId" IN (:assignmentIds) GROUP BY "assignmentId"`,
      { replacements: { tenantId, assignmentIds }, type: QueryTypes.SELECT },
    ) as Promise<{ assignmentId: string; count: number }[]>,
    Progress.sequelize!.query(
      `SELECT "courseId", COUNT(*)::int AS "count" FROM training_materials WHERE "tenantId" = :tenantId AND "courseId" IN (:courseIds) GROUP BY "courseId"`,
      { replacements: { tenantId, courseIds }, type: QueryTypes.SELECT },
    ) as Promise<{ courseId: string; count: number }[]>,
  ]);
  const openedBy = new Map(opened.map((row) => [row.assignmentId, Number(row.count)]));
  const totalBy = new Map(totals.map((row) => [row.courseId, Number(row.count)]));
  for (const assignment of assignments) {
    const done = openedBy.get(assignment.id) ?? 0;
    const total = totalBy.get(assignment.courseId) ?? 0;
    result.set(assignment.id, { opened: done, total, percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0 });
  }
  return result;
};
