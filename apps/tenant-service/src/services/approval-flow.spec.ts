import { decisionKind } from './approval-flow';

const base = {
  flow: 'MANAGER_THEN_HR' as const,
  stage: 'MANAGER_PENDING' as const,
  hasManager: true,
  inManagerChain: false,
  departmentScope: false,
  orgWide: false,
};

describe('decisionKind', () => {
  it('lets any in-scope approver finish a request when the flow is a single step', () => {
    expect(decisionKind({ ...base, flow: 'SINGLE', orgWide: false })).toBe('final');
  });

  it('sends the first step to the reporting line or a department-scoped approver', () => {
    expect(decisionKind({ ...base, inManagerChain: true })).toBe('manager');
    expect(decisionKind({ ...base, departmentScope: true })).toBe('manager');
    expect(decisionKind(base)).toBe('wait');
  });

  it('lets an organization-wide approver skip the manager, and only they finish the HR step', () => {
    expect(decisionKind({ ...base, orgWide: true })).toBe('override');
    expect(decisionKind({ ...base, stage: 'HR_PENDING', orgWide: true })).toBe('final');
    expect(decisionKind({ ...base, stage: 'HR_PENDING', inManagerChain: true })).toBe('wait');
  });

  it('goes straight to HR when nobody is assigned as manager', () => {
    expect(decisionKind({ ...base, hasManager: false, orgWide: true })).toBe('final');
    expect(decisionKind({ ...base, hasManager: false, inManagerChain: true })).toBe('wait');
  });
});
