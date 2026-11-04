/**
 * Who approves a request, stage by stage. Pure functions: nothing here reads a
 * database or sends anything, so every rule can be tested on its own.
 *
 * An organization's policy is an ordered list of stages. Each stage names
 * *who* decides, not a person: the reporting manager N levels up, the head of
 * the requester's department, a named person, anyone holding a permission, or
 * HR. {@link resolveStages} turns that list into real people for one request.
 * Whatever cannot be resolved (nobody above, a head that is not set, someone
 * who left) ends the route at HR, so a request never waits on nobody.
 *
 * The approval a request carries keeps the original two-step fields
 * (`currentApprover…`, `nextApprover…`, `finalStep`, `workflow`) so everything
 * that reads them keeps working, and adds the full `stages` list and which
 * one is current.
 */

import { MAX_MANAGER_LEVEL } from '@app/common';

export type StageKind = 'REPORTING_MANAGER' | 'DEPARTMENT_HEAD' | 'ADDITIONAL_MANAGER' | 'EMPLOYEE' | 'PERMISSION' | 'HR';

/** One line of an organization's policy. */
export interface PolicyStage {
  kind: StageKind;
  /** REPORTING_MANAGER: 1 is the direct manager, 2 is their manager, up to 3. */
  level?: number;
  /** EMPLOYEE: the named approver. */
  employeeId?: string;
  /** PERMISSION: anyone holding it decides, e.g. `payroll.approve`. */
  permission?: string;
}

/** Until an organization saves its own: the reporting manager, then their manager, else HR. */
export const DEFAULT_LEAVE_POLICY: PolicyStage[] = [
  { kind: 'REPORTING_MANAGER', level: 1 },
  { kind: 'REPORTING_MANAGER', level: 2 },
];

/** A stage worked out for one request. `approverId` null means HR or anyone holding `permission`. */
export interface ResolvedStage {
  kind: StageKind;
  approverId: string | null;
  name: string | null;
  title: string | null;
  permission: string | null;
}

export interface ApprovalStep {
  step: 'SUBMITTED' | 'FIRST_REVIEW' | 'SECOND_REVIEW' | 'THIRD_REVIEW';
  title: string;
  description: string;
  status: 'COMPLETED' | 'PENDING' | 'WAITING' | 'REJECTED' | 'SKIPPED';
  at?: string;
}

export interface Approval {
  stage: 'WITH_APPROVER' | 'WITH_HR';
  /** The sentence the employee sees: where the request is right now. */
  statusText: string;
  currentApproverId: string | null;
  currentApproverName: string | null;
  currentApproverTitle: string | null;
  /** True once this stop is the one that grants the request. */
  finalStep: boolean;
  /** Who it moves to after this stop. Null means HR, or that this is the last. */
  nextApproverId: string | null;
  nextApproverName: string | null;
  nextApproverTitle: string | null;
  workflow: ApprovalStep[];
  /** The whole route, and where the request is on it. Absent on requests made before stages were configurable. */
  stages?: ResolvedStage[];
  stageIndex?: number;
  /** The permission anyone must hold to decide the current stage, if it is a permission stage. */
  currentPermission?: string | null;
}

export interface RoutePerson {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  reportingManagerId?: string | null;
  designationId?: string | null;
  departmentId?: string | null;
  status?: string | null;
}

export interface RouteLookup {
  person(id: string): Promise<RoutePerson | null>;
  designationTitle(designationId: string): Promise<string | null>;
  /** The head of a department, as set on the Departments screen. */
  departmentHead(departmentId: string): Promise<string | null>;
  /** The additional (dotted-line) manager from someone's running additional assignments, if they have one. */
  additionalManager?(employeeId: string): Promise<string | null>;
}

const EMPLOYED = new Set(['ACTIVE', 'ON_LEAVE']);
const STEP_NAMES = ['FIRST_REVIEW', 'SECOND_REVIEW', 'THIRD_REVIEW'] as const;

const nameOf = (person?: { firstName?: string | null; lastName?: string | null } | null): string =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ') : '';

export const HR_STAGE: ResolvedStage = { kind: 'HR', approverId: null, name: null, title: 'HR', permission: null };

/** "Payroll Approve" for `payroll.approve`. */
export const permissionLabel = (permission: string): string =>
  permission
    .split(/[._]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const labelOf = (stage: ResolvedStage): string => {
  if (stage.name) return `${stage.name}${stage.title ? ` (${stage.title})` : ''}`;
  return stage.title ?? 'HR';
};

const isNamed = (stage: ResolvedStage): boolean => Boolean(stage.approverId);

// ==========================================
// Resolving a policy into people
// ==========================================

/** The manager `level` steps above the requester, or null when the line ends, loops back, or reaches someone who left. */
const managerAt = async (lookup: RouteLookup, requester: RoutePerson, level: number): Promise<RoutePerson | null> => {
  let current: RoutePerson = requester;
  const seen = new Set<string>([requester.id]);
  for (let step = 1; step <= level; step++) {
    const nextId = current.reportingManagerId;
    if (!nextId || seen.has(nextId)) return null;
    const next = await lookup.person(nextId);
    if (!next) return null;
    seen.add(next.id);
    current = next;
  }
  return current;
};

const stageFor = async (lookup: RouteLookup, person: RoutePerson, fallbackTitle: string, kind: StageKind): Promise<ResolvedStage> => {
  const title = person.designationId ? ((await lookup.designationTitle(person.designationId)) ?? null) : null;
  return { kind, approverId: person.id, name: nameOf(person), title: title ?? fallbackTitle, permission: null };
};

/**
 * The route for one request. A stage whose approver cannot be found ends the
 * route at HR. The same person is never asked twice in a row, and nobody
 * approves their own request.
 */
export const resolveStages = async (policy: PolicyStage[], requesterId: string, lookup: RouteLookup): Promise<ResolvedStage[]> => {
  const requester = await lookup.person(requesterId);
  const out: ResolvedStage[] = [];
  const seen = new Set<string>([requesterId]);

  for (const stage of policy) {
    if (stage.kind === 'HR') {
      out.push({ ...HR_STAGE });
      continue;
    }
    if (stage.kind === 'PERMISSION') {
      const permission = stage.permission ?? '';
      out.push({ kind: 'PERMISSION', approverId: null, name: null, title: permissionLabel(permission), permission });
      continue;
    }

    let approver: RoutePerson | null = null;
    let fallbackTitle = 'Approver';
    if (stage.kind === 'ADDITIONAL_MANAGER') {
      // Optional by nature: someone with no additional manager simply has no such stage.
      const extraId = lookup.additionalManager ? await lookup.additionalManager(requesterId) : null;
      const extra = extraId ? await lookup.person(extraId) : null;
      if (!extra || extra.id === requesterId || seen.has(extra.id) || (extra.status && !EMPLOYED.has(extra.status))) continue;
      seen.add(extra.id);
      out.push(await stageFor(lookup, extra, 'Additional manager', stage.kind));
      continue;
    }
    if (stage.kind === 'REPORTING_MANAGER' && requester) {
      const level = Math.min(Math.max(stage.level ?? 1, 1), MAX_MANAGER_LEVEL);
      approver = await managerAt(lookup, requester, level);
      fallbackTitle = level === 1 ? 'Reporting manager' : 'Manager';
    } else if (stage.kind === 'DEPARTMENT_HEAD' && requester?.departmentId) {
      const headId = await lookup.departmentHead(requester.departmentId);
      approver = headId ? await lookup.person(headId) : null;
      fallbackTitle = 'Department head';
    } else if (stage.kind === 'EMPLOYEE' && stage.employeeId) {
      approver = await lookup.person(stage.employeeId);
      fallbackTitle = 'Approver';
    }

    if (!approver || approver.id === requesterId || (approver.status && !EMPLOYED.has(approver.status))) {
      out.push({ ...HR_STAGE });
      break;
    }
    if (seen.has(approver.id)) continue;
    seen.add(approver.id);
    out.push(await stageFor(lookup, approver, fallbackTitle, stage.kind));
  }

  return out.length ? out : [{ ...HR_STAGE }];
};

// ==========================================
// The approval a request carries
// ==========================================

const waitingText = (stage: ResolvedStage): string => `With ${labelOf(stage)}. Not approved yet.`;

/** The two-step fields every reader of the approval expects, for the stage at `index`. */
const legacyFields = (stages: ResolvedStage[], index: number) => {
  const current = stages[index];
  const next = stages[index + 1];
  return {
    stage: isNamed(current) ? ('WITH_APPROVER' as const) : ('WITH_HR' as const),
    currentApproverId: current.approverId,
    currentApproverName: current.name,
    currentApproverTitle: current.title,
    finalStep: index === stages.length - 1,
    nextApproverId: next?.approverId ?? null,
    nextApproverName: next?.name ?? null,
    nextApproverTitle: next ? (next.title ?? null) : null,
    currentPermission: current.permission,
  };
};

const reviewSteps = (stages: ResolvedStage[]): ApprovalStep[] => {
  // A request that goes straight to HR still shows the reporting manager step, as skipped.
  const straightToHr = stages.length === 1 && stages[0].kind === 'HR';
  if (straightToHr) {
    return [
      { step: 'FIRST_REVIEW', title: 'Reporting manager', description: 'No reporting manager — sent straight to HR', status: 'SKIPPED' },
      { step: 'SECOND_REVIEW', title: 'HR', description: 'Waiting for HR', status: 'PENDING' },
    ];
  }
  return stages.map((stage, index) => ({
    step: STEP_NAMES[Math.min(index, STEP_NAMES.length - 1)],
    title: stage.title ?? 'Approver',
    description:
      index === 0
        ? `Waiting for ${labelOf(stage)}`
        : `After ${stages[index - 1].name ?? labelOf(stages[index - 1])} approves, it goes to ${stage.name ? labelOf(stage) : (stage.title ?? 'HR')}`,
    status: index === 0 ? ('PENDING' as const) : ('WAITING' as const),
  }));
};

/** A new request's approval, waiting at the first stage. */
export const buildApproval = (stages: ResolvedStage[], requesterName: string, nowIso: string = new Date().toISOString()): Approval => {
  const fields = legacyFields(stages, 0);
  return {
    ...fields,
    statusText: waitingText(stages[0]),
    workflow: [
      { step: 'SUBMITTED', title: 'Request submitted', description: `Submitted by ${requesterName || 'the employee'}`, status: 'COMPLETED', at: nowIso },
      ...reviewSteps(stages),
    ],
    stages,
    stageIndex: 0,
  };
};

/**
 * The route of an approval. Requests made before stages existed carry only
 * the current and the next stop, so the route is read back from those.
 */
export const stagesOf = (approval: Approval): { stages: ResolvedStage[]; index: number } => {
  if (approval.stages?.length) return { stages: approval.stages, index: approval.stageIndex ?? 0 };
  const current: ResolvedStage = approval.currentApproverId
    ? { kind: 'REPORTING_MANAGER', approverId: approval.currentApproverId, name: approval.currentApproverName, title: approval.currentApproverTitle, permission: null }
    : { ...HR_STAGE };
  const stages = [current];
  if (!approval.finalStep) {
    stages.push(
      approval.nextApproverId
        ? { kind: 'REPORTING_MANAGER', approverId: approval.nextApproverId, name: approval.nextApproverName, title: approval.nextApproverTitle, permission: null }
        : { ...HR_STAGE },
    );
  }
  return { stages, index: 0 };
};

export interface Actor {
  /** The employee record behind the login, if any. */
  employeeId: string | null;
  /** Organization-wide scope, or no scope at all. */
  orgWide: boolean;
  permissions: readonly string[];
  isFullAccess: boolean;
  /** Overrides the plain "has this exact permission" test, e.g. to let payroll.manage stand in for payroll.*. */
  holds?: (permission: string) => boolean;
}

/** Whether this person may decide the stage the request is at. */
export const canActOnStage = (stage: ResolvedStage, actor: Actor): boolean => {
  if (stage.approverId) return actor.employeeId === stage.approverId;
  if (stage.kind === 'PERMISSION' && stage.permission) {
    if (actor.isFullAccess || actor.permissions.includes('*')) return true;
    return actor.holds ? actor.holds(stage.permission) : actor.permissions.includes(stage.permission);
  }
  return actor.orgWide;
};

const closeOpenStep = (workflow: ApprovalStep[], status: ApprovalStep['status'], description: string, nowIso: string) => {
  const open = workflow.find((step) => step.status === 'PENDING');
  if (open) {
    open.status = status;
    open.at = nowIso;
    open.description = description;
  }
};

/** Words for where the request has moved to, as the employee reads them. */
const movedTo = (stage: ResolvedStage): string => labelOf(stage);

/**
 * The current stage approved and it is not the last: the request moves on.
 * `actorLabel` is how the approver is named in the trail.
 */
export const advanceApproval = (approval: Approval, actorLabel: string, nowIso: string = new Date().toISOString()): Approval => {
  const { stages, index } = stagesOf(approval);
  const workflow = approval.workflow.map((step) => ({ ...step }));
  closeOpenStep(workflow, 'COMPLETED', `Approved by ${actorLabel}`, nowIso);
  const waiting = workflow.find((step) => step.status === 'WAITING');
  if (waiting) waiting.status = 'PENDING';
  const nextIndex = index + 1;
  return {
    ...approval,
    ...legacyFields(stages, nextIndex),
    statusText: `${actorLabel} approved your leave. It is now with ${movedTo(stages[nextIndex])}.`,
    workflow,
    stages,
    stageIndex: nextIndex,
  };
};

/** The last stage approved: nothing is waiting any more. */
export const completeApproval = (approval: Approval, actorLabel: string, nowIso: string = new Date().toISOString()): Approval => {
  const workflow = approval.workflow.map((step) => ({ ...step }));
  closeOpenStep(workflow, 'COMPLETED', `Approved by ${actorLabel}`, nowIso);
  return { ...approval, statusText: `Approved by ${actorLabel}.`, workflow };
};

/** The current stage rejected: the request ends. */
export const rejectApproval = (approval: Approval, actorLabel: string, nowIso: string = new Date().toISOString()): Approval => {
  const workflow = approval.workflow.map((step) => ({ ...step }));
  closeOpenStep(workflow, 'REJECTED', `Rejected by ${actorLabel}`, nowIso);
  return { ...approval, statusText: `Rejected by ${actorLabel}.`, workflow };
};

/**
 * The current approver cannot act: the request goes to the next stage, or to
 * HR when there is none. What was already approved is kept in the trail.
 */
export const handOnApproval = (approval: Approval, why: string, nowIso: string = new Date().toISOString()): Approval => {
  const { stages, index } = stagesOf(approval);
  const workflow = approval.workflow.map((step) => ({ ...step }));
  closeOpenStep(workflow, 'SKIPPED', why, nowIso);
  const hasNext = index + 1 < stages.length;
  const route = hasNext ? stages : [...stages.slice(0, index + 1), { ...HR_STAGE }];
  const nextIndex = index + 1;
  const waiting = workflow.find((step) => step.status === 'WAITING');
  if (waiting) waiting.status = 'PENDING';
  else if (!hasNext) {
    workflow.push({ step: STEP_NAMES[Math.min(nextIndex, STEP_NAMES.length - 1)], title: 'HR', description: 'Waiting for HR', status: 'PENDING' });
  }
  return {
    ...approval,
    ...legacyFields(route, nextIndex),
    statusText: `${why} It is now with ${movedTo(route[nextIndex])}.`,
    workflow,
    stages: route,
    stageIndex: nextIndex,
  };
};

/** How many review stages have been approved so far. */
export const approvedStages = (approval: Approval): number =>
  approval.workflow.filter((step) => step.step !== 'SUBMITTED' && step.status === 'COMPLETED').length;

/**
 * A request's route changed (someone's manager moved). Where nobody has
 * approved yet it is rebuilt from the fresh route, keeping when it was
 * submitted. Where some stages are done it only moves if its current approver
 * is no longer on the route, and then goes to HR. Null when nothing changes.
 */
export const rerouteApproval = (approval: Approval, fresh: ResolvedStage[], nowIso: string = new Date().toISOString()): Approval | null => {
  const done = approvedStages(approval);
  const { stages: oldStages, index } = stagesOf(approval);
  if (done === 0) {
    const same =
      oldStages.length === fresh.length &&
      oldStages.every((stage, i) => stage.approverId === fresh[i].approverId && stage.kind === fresh[i].kind && stage.permission === fresh[i].permission);
    if (same) return null;
    const submitted = approval.workflow.find((step) => step.step === 'SUBMITTED');
    const built = buildApproval(fresh, '', nowIso);
    return { ...built, workflow: built.workflow.map((step) => (step.step === 'SUBMITTED' && submitted ? submitted : step)) };
  }
  const current = oldStages[index];
  const onRoute = !current.approverId || fresh.some((stage) => stage.approverId === current.approverId);
  if (onRoute) return null;
  return handOnApproval(approval, 'The reporting line changed.', nowIso);
};
