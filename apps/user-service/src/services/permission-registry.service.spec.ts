import {
  PermissionRegistryService,
  SYSTEM_PERMISSIONS,
  splitPermissionKey,
} from './permission-registry.service';

/**
 * Permission keys are 'resource.action', and a resource may itself be dotted
 * (payroll.tax, payroll.compliance) — the action is after the last separator.
 */
describe('splitPermissionKey', () => {
  it.each([
    ['payroll.view', { resource: 'payroll', action: 'view' }],
    ['payroll:approve', { resource: 'payroll', action: 'approve' }],
    ['payroll.tax.manage', { resource: 'payroll.tax', action: 'manage' }],
    [
      'payroll.compliance:view',
      { resource: 'payroll.compliance', action: 'view' },
    ],
  ])('%s', (input, expected) => {
    expect(splitPermissionKey(input)).toEqual(expected);
  });

  it.each(['payroll', '.view', 'payroll.', ''])('rejects %j', (input) => {
    expect(splitPermissionKey(input)).toBeNull();
  });
});

describe('PermissionRegistryService.resolvePermissionIds', () => {
  const catalogue = () =>
    SYSTEM_PERMISSIONS.map((def, i) => ({
      id: `perm-${i}`,
      resource: def.resource,
      action: def.action,
      description: def.description,
    }));

  const service = () => {
    const rows = catalogue();
    const Permission = {
      findAll: jest.fn(async (options: any = {}) => {
        const or: any[] | undefined =
          options.where?.[Object.getOwnPropertySymbols(options.where ?? {})[0]];
        if (!or) return rows;
        return rows.filter((row) =>
          or.some(
            (part) =>
              part.resource === row.resource && part.action === row.action,
          ),
        );
      }),
      bulkCreate: jest.fn(),
    };
    return new PermissionRegistryService({
      getPermissionModel: async () => Permission,
    } as any);
  };

  it('resolves the compliance and tax permissions by key', async () => {
    const ids = await service().resolvePermissionIds('t1', [
      'payroll.tax.manage',
      'payroll.compliance.view',
      'payroll.view',
    ]);
    const byId = new Map(
      catalogue().map((row) => [row.id, `${row.resource}.${row.action}`]),
    );
    expect(ids.map((id) => byId.get(id))).toEqual([
      'payroll.tax.manage',
      'payroll.compliance.view',
      'payroll.view',
    ]);
  });

  it('still refuses an unknown key', async () => {
    await expect(
      service().resolvePermissionIds('t1', ['payroll.tax.delete']),
    ).rejects.toThrow(/unknown permission/);
  });
});
