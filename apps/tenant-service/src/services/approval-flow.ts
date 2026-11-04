/**
 * Who may decide an employee request, given the organization's approval
 * setting. Leave requests do not use this.
 *
 * - SINGLE — anyone the request is already visible to (their data scope)
 *   decides it in one step. That is how it worked before this setting.
 * - MANAGER_THEN_HR — the reporting manager (or someone above them, or a
 *   department-scoped approver) decides first. Their approval only moves
 *   the request to HR; their rejection ends it. An organization-wide
 *   approver makes the final decision, and may skip the manager step.
 */

export const APPROVAL_FLOWS = ['SINGLE', 'MANAGER_THEN_HR'] as const;
export type ApprovalFlow = (typeof APPROVAL_FLOWS)[number];

export type RequestStage = 'MANAGER_PENDING' | 'HR_PENDING';

/** `manager` does not apply the change — it only advances the request to HR. */
export type DecisionKind = 'final' | 'manager' | 'override' | 'wait';

export const decisionKind = (input: {
  flow: ApprovalFlow;
  stage: RequestStage;
  hasManager: boolean;
  /** The actor is the reporting manager, or further up that chain. */
  inManagerChain: boolean;
  /** DEPARTMENT scope: a department head (or anyone scoped to the department). */
  departmentScope: boolean;
  /** ORGANIZATION scope, or no scope at all (the historical default). */
  orgWide: boolean;
}): DecisionKind => {
  if (input.flow !== 'MANAGER_THEN_HR') return 'final';

  const withHr = !input.hasManager || input.stage === 'HR_PENDING';
  if (withHr) return input.orgWide ? 'final' : 'wait';
  if (input.inManagerChain || input.departmentScope) return 'manager';
  if (input.orgWide) return 'override';
  return 'wait';
};
