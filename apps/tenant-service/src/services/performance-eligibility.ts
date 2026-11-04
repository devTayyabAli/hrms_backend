/**
 * Who a performance review cycle is for. Pure: it reads an employee as
 * Employee Management has them and the cycle's rules, and says whether they
 * are in and, if not, why, so HR can see the reason and correct it.
 */

export type ProbationRule = 'INCLUDE' | 'EXCLUDE';

export interface EligibilityRules {
  /** Whole days employed, measured on the day of the check and no later than the cycle's last day. */
  minTenureDays: number;
  /** EXCLUDE leaves out people still in probation. */
  probation: ProbationRule;
  /** Empty means every employment type. */
  employmentTypes: string[];
  /** Empty means every department. A department includes the ones under it. */
  departmentIds: string[];
  /** Empty means every designation. */
  designationIds: string[];
  /** In whatever the other rules say (but not for someone who has left). */
  includeEmployeeIds: string[];
  /** Out whatever the other rules say. */
  excludeEmployeeIds: string[];
}

export const DEFAULT_ELIGIBILITY: EligibilityRules = {
  minTenureDays: 90,
  probation: 'EXCLUDE',
  employmentTypes: [],
  departmentIds: [],
  designationIds: [],
  includeEmployeeIds: [],
  excludeEmployeeIds: [],
};

export const normalizeEligibility = (raw: Partial<EligibilityRules> | null | undefined): EligibilityRules => {
  const list = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []);
  const tenure = Number(raw?.minTenureDays);
  return {
    minTenureDays: Number.isFinite(tenure) && tenure >= 0 ? Math.floor(tenure) : DEFAULT_ELIGIBILITY.minTenureDays,
    probation: raw?.probation === 'INCLUDE' ? 'INCLUDE' : 'EXCLUDE',
    employmentTypes: list(raw?.employmentTypes),
    departmentIds: list(raw?.departmentIds),
    designationIds: list(raw?.designationIds),
    includeEmployeeIds: list(raw?.includeEmployeeIds),
    excludeEmployeeIds: list(raw?.excludeEmployeeIds),
  };
};

export interface EligibilityEmployee {
  id: string;
  status: string;
  joiningDate?: string | null;
  exitDate?: string | null;
  employmentType?: string | null;
  probationEndDate?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
}

export interface EligibilityCycle {
  startDate: string;
  endDate: string;
}

export type EligibilityReason =
  | 'EXCLUDED_BY_HR'
  | 'NOT_EMPLOYED'
  | 'LEFT_BEFORE_CYCLE'
  | 'JOINED_AFTER_CYCLE'
  | 'TENURE'
  | 'PROBATION'
  | 'EMPLOYMENT_TYPE'
  | 'DEPARTMENT'
  | 'DESIGNATION';

export interface EligibilityDecision {
  eligible: boolean;
  /** Why not, in a sentence. Null when they are in. */
  reason: string | null;
  code: EligibilityReason | 'ELIGIBLE' | 'INCLUDED_BY_HR';
}

const EMPLOYED = ['ACTIVE', 'ON_LEAVE'];
const day = (value: unknown) => String(value ?? '').slice(0, 10);
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * `departmentIds` is the set the rules name with the departments under them
 * already added (the caller knows the tree). `today` is passed in so the same
 * answer can be reproduced.
 */
export const evaluateEligibility = (
  employee: EligibilityEmployee,
  cycle: EligibilityCycle,
  rules: EligibilityRules,
  departmentIds: ReadonlySet<string>,
  today: string,
): EligibilityDecision => {
  const out = (code: EligibilityDecision['code'], reason: string | null): EligibilityDecision => ({ eligible: code === 'ELIGIBLE' || code === 'INCLUDED_BY_HR', reason, code });

  if (rules.excludeEmployeeIds.includes(employee.id)) return out('EXCLUDED_BY_HR', 'Left out by HR for this cycle.');
  // Someone who has left is not given a new assessment however the rules read: that takes an explicit authorization.
  if (!EMPLOYED.includes(employee.status)) return out('NOT_EMPLOYED', 'No longer works here.');
  if (rules.includeEmployeeIds.includes(employee.id)) return out('INCLUDED_BY_HR', null);

  const joined = day(employee.joiningDate);
  if (employee.exitDate && day(employee.exitDate) < day(cycle.startDate)) return out('LEFT_BEFORE_CYCLE', 'Left before the cycle began.');
  if (joined && joined > day(cycle.endDate)) return out('JOINED_AFTER_CYCLE', 'Joined after the cycle ended.');

  const asOf = today < day(cycle.endDate) ? today : day(cycle.endDate);
  if (rules.minTenureDays > 0 && joined) {
    const served = daysBetween(joined, asOf);
    if (served < rules.minTenureDays) return out('TENURE', `Has worked ${Math.max(served, 0)} of the ${rules.minTenureDays} days required.`);
  }

  const inProbation = employee.employmentType === 'PROBATION' || Boolean(employee.probationEndDate && day(employee.probationEndDate) > asOf);
  if (rules.probation === 'EXCLUDE' && inProbation) {
    return out('PROBATION', employee.probationEndDate && day(employee.probationEndDate) > asOf ? `On probation until ${day(employee.probationEndDate)}.` : 'On probation.');
  }

  if (rules.employmentTypes.length && !rules.employmentTypes.includes(String(employee.employmentType ?? ''))) {
    return out('EMPLOYMENT_TYPE', `Employment type ${employee.employmentType ?? 'not set'} is not part of this cycle.`);
  }
  if (rules.departmentIds.length && !(employee.departmentId && departmentIds.has(employee.departmentId))) return out('DEPARTMENT', 'Their department is not part of this cycle.');
  if (rules.designationIds.length && !(employee.designationId && rules.designationIds.includes(employee.designationId))) return out('DESIGNATION', 'Their designation is not part of this cycle.');
  return out('ELIGIBLE', null);
};
