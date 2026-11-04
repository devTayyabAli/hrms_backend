import { of, throwError } from 'rxjs';
import { PermissionHoldersService } from './permission-holders.service';
import { table } from './testing/fake-table';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('PermissionHoldersService', () => {
  let employees: any;
  let notifications: any;
  let userClient: { send: jest.Mock };
  let service: PermissionHoldersService;

  const permissionStage: any = { currentApproverId: null, currentPermission: 'payroll.approve' };

  beforeEach(() => {
    employees = table([
      { tenantId: TENANT, firstName: 'Fin', userId: 'u1', email: 'fin@x.com' },
      { tenantId: TENANT, firstName: 'Lead', userId: 'u3', email: 'lead@x.com' },
      { tenantId: TENANT, firstName: 'Other', userId: 'u9', email: 'other@x.com' },
    ]);
    notifications = table();
    userClient = { send: jest.fn(() => of([{ id: 'u1', email: 'fin@x.com' }, { id: 'u3', email: 'lead@x.com' }])) };
    const provider: any = { getEmployeeModel: async () => employees, getEmployeeNotificationModel: async () => notifications };
    service = new PermissionHoldersService(provider, userClient as any);
  });

  it('tells everyone who holds the permission the request waits on, and nobody else', async () => {
    await service.tell(TENANT, permissionStage, [], 'Reimbursement waiting', 'A claim is waiting.');

    expect(userClient.send).toHaveBeenCalledWith('role.permission_holders', { tenantId: TENANT, permission: 'payroll.approve' });
    expect(notifications.rows.map((n: any) => [n.employeeId, n.title])).toEqual([
      [employees.rows[0].id, 'Reimbursement waiting'],
      [employees.rows[1].id, 'Reimbursement waiting'],
    ]);
  });

  it('does not tell the person the request is about', async () => {
    await service.tell(TENANT, permissionStage, [employees.rows[0].id], 'Salary change waiting', 'Waiting.');
    expect(notifications.rows.map((n: any) => n.employeeId)).toEqual([employees.rows[1].id]);
  });

  it('does nothing when a named person or HR holds the stage', async () => {
    await service.tell(TENANT, { currentApproverId: 'someone', currentPermission: null } as any, [], 't', 'b');
    await service.tell(TENANT, { currentApproverId: null, currentPermission: null } as any, [], 't', 'b');
    await service.tell(TENANT, null, [], 't', 'b');
    expect(userClient.send).not.toHaveBeenCalled();
    expect(notifications.rows).toHaveLength(0);
  });

  it('never fails the action it reports when the user service cannot be reached', async () => {
    userClient.send.mockReturnValue(throwError(() => new Error('down')));
    await expect(service.tell(TENANT, permissionStage, [], 't', 'b')).resolves.toBeUndefined();
    expect(notifications.rows).toHaveLength(0);
  });
});
