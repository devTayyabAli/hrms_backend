import { EmployeePortalRole, SYSTEM_TENANT_ROLES, grantsPermission } from './role-permissions';

const permissionsOf = (name: string): string[] => {
  const role = SYSTEM_TENANT_ROLES.find((def) => def.name === name);
  if (!role) throw new Error(`No system role named ${name}`);
  return role.defaultPermissions;
};

/** What a role would need to change a project or a task, rather than only read them. */
const CHANGING = [
  'projects.create',
  'projects.edit',
  'projects.delete',
  'projects.export',
  'tasks.create',
  'tasks.edit',
  'tasks.delete',
  'tasks.export',
];

describe('Projects & Tasks defaults for system roles', () => {
  it('lets HR see projects, tasks and workload but not change them', () => {
    const hr = permissionsOf(EmployeePortalRole.HR);
    expect(grantsPermission(hr, 'projects.view')).toBe(true);
    expect(grantsPermission(hr, 'tasks.view')).toBe(true);
    for (const grant of CHANGING) expect(grantsPermission(hr, grant)).toBe(false);
  });

  it('keeps HR off the broad manage grants that would imply every change', () => {
    const hr = permissionsOf(EmployeePortalRole.HR);
    expect(hr).not.toContain('projects.manage');
    expect(hr).not.toContain('tasks.manage');
    expect(hr).not.toContain('*');
  });

  it('does not let HR reopen a completed project or see confidential ones through another grant', () => {
    const hr = permissionsOf(EmployeePortalRole.HR);
    expect(hr.filter((grant) => /^(projects|tasks)\./.test(grant))).toEqual(['tasks.view', 'projects.view']);
  });

  it('lets a Department Head run department projects and tasks, but not delete them', () => {
    const head = permissionsOf('Department Head');
    for (const grant of ['projects.create', 'projects.edit', 'tasks.create', 'tasks.edit']) expect(grantsPermission(head, grant)).toBe(true);
    expect(grantsPermission(head, 'projects.delete')).toBe(false);
    expect(grantsPermission(head, 'tasks.delete')).toBe(false);
  });

  it('lets a Team Lead manage tasks but leaves project changes to the project owner', () => {
    const lead = permissionsOf('Team Lead');
    expect(grantsPermission(lead, 'tasks.edit')).toBe(true);
    expect(grantsPermission(lead, 'projects.edit')).toBe(false);
    expect(grantsPermission(lead, 'projects.create')).toBe(false);
  });

  it('leaves the Administration role view-only for projects and tasks', () => {
    const admin = permissionsOf('Administration');
    expect(grantsPermission(admin, 'projects.view')).toBe(true);
    for (const grant of CHANGING) expect(grantsPermission(admin, grant)).toBe(false);
  });
});
