import { OnboardingTaskCategory, OnboardingTaskStatus } from '@app/common';

/**
 * The default onboarding checklist seeded for a new hire.
 *
 * Lives in its own module, not on either service, because both entry points
 * into onboarding need it: OnboardingService when an admin adds a hire
 * manually, and CandidateService when a candidate reaches HIRED. Importing it
 * from one service into the other would make recruitment depend on onboarding
 * (or the reverse), and the two already reference each other's models — Nest
 * would be resolving a circular provider graph for what is really just a list
 * of strings.
 *
 * `dueInDays` is relative to the joining date, so the checklist lands on
 * sensible dates for whatever start date the hire actually has. Negative
 * values are pre-boarding items that must be done before day one.
 */
export interface DefaultChecklistItem {
  title: string;
  category: OnboardingTaskCategory;
  dueInDays: number;
  sortOrder: number;
}

export const DEFAULT_CHECKLIST: readonly DefaultChecklistItem[] = [
  {
    title: 'Collect signed offer letter and ID documents',
    category: OnboardingTaskCategory.DOCUMENTATION,
    dueInDays: -3,
    sortOrder: 10,
  },
  {
    title: 'Complete company policies',
    category: OnboardingTaskCategory.COMPLIANCE,
    dueInDays: -1,
    sortOrder: 20,
  },
  {
    title: 'Setup laptop & software',
    category: OnboardingTaskCategory.IT_SETUP,
    dueInDays: 0,
    sortOrder: 30,
  },
  {
    title: 'Create email and system accounts',
    category: OnboardingTaskCategory.IT_SETUP,
    dueInDays: 0,
    sortOrder: 40,
  },
  {
    title: 'Schedule team introduction',
    category: OnboardingTaskCategory.ORIENTATION,
    dueInDays: 1,
    sortOrder: 50,
  },
  {
    title: 'Assign onboarding buddy',
    category: OnboardingTaskCategory.ORIENTATION,
    dueInDays: 2,
    sortOrder: 60,
  },
  {
    title: 'Complete role-specific training',
    category: OnboardingTaskCategory.TRAINING,
    dueInDays: 14,
    sortOrder: 70,
  },
  {
    title: 'Review probation period goals',
    category: OnboardingTaskCategory.ORIENTATION,
    dueInDays: 30,
    sortOrder: 80,
  },
] as const;

/**
 * Shift a 'YYYY-MM-DD' date by whole days.
 *
 * Parsed as UTC midnight so the arithmetic cannot be thrown off by a
 * daylight-saving shift falling inside the offset — the same reason
 * LeaveRequestService pins its date maths to UTC.
 */
export function shiftDateOnly(dateOnly: string, days: number): string {
  const base = Date.parse(`${dateOnly.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return dateOnly.slice(0, 10);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Materialize the default checklist as insertable OnboardingTask rows. */
export function buildDefaultChecklist(
  tenantId: string,
  newHireId: string,
  joiningDate: string,
) {
  return DEFAULT_CHECKLIST.map((item) => ({
    tenantId,
    newHireId,
    title: item.title,
    category: item.category,
    status: OnboardingTaskStatus.PENDING,
    dueDate: shiftDateOnly(joiningDate, item.dueInDays),
    sortOrder: item.sortOrder,
  }));
}
