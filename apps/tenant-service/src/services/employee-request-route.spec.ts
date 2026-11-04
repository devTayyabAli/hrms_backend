import { HttpStatus } from '@nestjs/common';
import { EmployeeRequestStatus, EmployeeRequestType } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { EmployeePortalService } from './employee-portal.service';
import { table } from './testing/fake-table';

/**
 * Employee requests on an organization's own approval route: the manager
 * decides the first stage from "my approvals", HR applies the last, a changed
 * reporting line or a departed approver moves the request, and an organization
 * with no saved route is untouched.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const HR_ACTOR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['employee.edit'] };
const PLAIN = { roles: [], isSuperAdmin: false, userId: 'u-x', email: 'x@x.com', permissions: [] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, departmentId: null, designationId: null, ...over });

describe('Employee requests with a saved route', () => {
  let models: Record<string, any>;
  let service: EmployeePortalService;
  let ayesha: any;
  let sara: any;
  let omar: any;
  let hr: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Lead', userId: 'u-omar', email: 'omar@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Hina', lastName: 'HR', userId: 'u-hr', email: 'hr@x.com' }),
      ]),
      Request: table(),
      Notification: table(),
      ApprovalPolicy: table(),
      Department: table(),
      Designation: table(),
    };
    [ayesha, sara, omar, hr] = models.Employee.rows;
    ayesha.reportingManagerId = sara.id;
    models.ApprovalPolicy.create({ tenantId: TENANT, requestType: 'EMPLOYEE_REQUEST', stages: [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'HR' }] });

    const provider: any = {
      getEmployeeModel: async () => models.Employee,
      getEmployeeRequestModel: async () => models.Request,
      getEmployeeNotificationModel: async () => models.Notification,
      getApprovalPolicyModel: async () => models.ApprovalPolicy,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getApprovalSettingModel: async () => ({ findOne: async () => null }),
      getAttendanceRecordModel: async () => table(),
    };
    service = new EmployeePortalService(provider, {} as any, {} as any);
  });

  const submit = () => service.createRequest(TENANT, 'u-ayesha', { type: EmployeeRequestType.GENERAL, description: 'Need a letter' } as any) as Promise<any>;
  const notes = () => models.Notification.rows.map((n: any) => [n.employeeId, n.title]);

  it('goes to the first stage on the route and tells that person', async () => {
    const request = await submit();

    expect(request.approval).toMatchObject({ currentApproverId: sara.id, finalStep: false });
    expect(request).toMatchObject({ status: 'PENDING', stage: 'MANAGER_PENDING', managerName: 'Sara Manager' });
    expect(notes()).toEqual([[ayesha.id, 'General HR Request'], [sara.id, 'General HR Request']]);
  });

  it('keeps the older behaviour when the organization has saved no route', async () => {
    models.ApprovalPolicy.rows.length = 0;
    const request = await submit();
    expect(request.approval).toBeNull();
    expect(models.Request.rows[0].approval).toBeNull();
  });

  it('shows the manager what waits for them', async () => {
    await submit();
    // The query matches the route inside the stored JSON; the fake table cannot, so it is applied here.
    models.Request.findAll.mockImplementationOnce(async () => models.Request.rows.filter((r: any) => r.approval?.currentApproverId === sara.id));

    const mine = await service.myRequestApprovals(TENANT, 'u-sara');

    expect(mine.total).toBe(1);
    expect(mine.data[0]).toMatchObject({ employee: { name: 'Ayesha Khan' }, canDecide: true });
  });

  it('moves on to HR when the manager approves, without applying it, and tells the employee and HR', async () => {
    const request = await submit();
    models.Notification.rows.length = 0;

    const moved: any = await as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-sara', undefined, request.id, { status: EmployeeRequestStatus.APPROVED } as any));

    expect(moved).toMatchObject({ status: 'PENDING', stage: 'HR_PENDING', approval: { finalStep: true } });
    expect(models.Request.rows[0].status).toBe('PENDING');
    expect(notes()).toEqual([[ayesha.id, 'General HR Request']]);
  });

  it('is applied only when HR approves the last stage', async () => {
    const request = await submit();
    await as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-sara', undefined, request.id, { status: EmployeeRequestStatus.APPROVED } as any));

    const done: any = await as(HR_ACTOR, () => service.decideRequest(TENANT, request.id, { status: EmployeeRequestStatus.APPROVED } as any, 'u-hr', 'hr@x.com'));

    expect(done).toMatchObject({ status: 'APPROVED', stage: 'APPROVED' });
    expect(done.approval.statusText).toContain('Approved by');
    expect(models.Request.rows[0].decidedByUserId).toBe('u-hr');
  });

  it('does not let HR decide before the manager has, or anyone else decide the manager stage', async () => {
    const request = await submit();

    await expect(as(HR_ACTOR, () => service.decideRequest(TENANT, request.id, { status: EmployeeRequestStatus.APPROVED } as any, 'u-hr', 'hr@x.com'))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    await expect(as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-omar', undefined, request.id, { status: EmployeeRequestStatus.APPROVED } as any))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    await expect(as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-ayesha', undefined, request.id, { status: EmployeeRequestStatus.APPROVED } as any))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    expect(models.Request.rows[0].status).toBe('PENDING');
  });

  it('lets the manager reject, which ends it and tells the employee', async () => {
    const request = await submit();
    models.Notification.rows.length = 0;

    const done: any = await as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-sara', undefined, request.id, { status: EmployeeRequestStatus.REJECTED, note: 'Not now' } as any));

    expect(done).toMatchObject({ status: 'REJECTED', stage: 'REJECTED', decisionNote: 'Not now' });
    expect(models.Notification.rows[0].body).toContain('Not now');
  });

  it('treats a request without a route as not found on the manager side', async () => {
    models.ApprovalPolicy.rows.length = 0;
    const request = await submit();
    await expect(as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-sara', undefined, request.id, { status: EmployeeRequestStatus.APPROVED } as any))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  describe('when the reporting line changes or the approver leaves', () => {
    it('moves a request nobody has approved to the new manager, and tells both', async () => {
      await submit();
      ayesha.reportingManagerId = omar.id;
      models.Notification.rows.length = 0;

      expect(await service.rerouteRequestsAfterReportingChange(TENANT, ayesha.id)).toBe(1);

      expect(models.Request.rows[0].approval.currentApproverId).toBe(omar.id);
      expect(models.Request.rows[0].resolution).toMatchObject({ managerId: omar.id, managerName: 'Omar Lead' });
      expect(notes()).toEqual([[ayesha.id, 'General HR Request'], [omar.id, 'General HR Request']]);
    });

    it('leaves a request alone when the route is the same, or once HR has it', async () => {
      const request = await submit();
      expect(await service.rerouteRequestsAfterReportingChange(TENANT, ayesha.id)).toBe(0);

      await as(PLAIN, () => service.decideMyRequestApproval(TENANT, 'u-sara', undefined, request.id, { status: EmployeeRequestStatus.APPROVED } as any));
      ayesha.reportingManagerId = omar.id;
      expect(await service.rerouteRequestsAfterReportingChange(TENANT, ayesha.id)).toBe(0);
    });

    it('hands a request on to HR when the manager it waits on leaves', async () => {
      await submit();
      models.Request.findAll.mockImplementationOnce(async () => models.Request.rows.filter((r: any) => r.approval?.currentApproverId === sara.id));

      expect(await service.releaseRequestsWaitingOn(TENANT, sara.id)).toBe(1);

      expect(models.Request.rows[0].approval).toMatchObject({ finalStep: true, currentApproverId: null });
      expect(models.Request.rows[0].approval.statusText).toContain('no longer with the organization');
      expect(models.Request.rows[0].resolution.stage).toBe('HR_PENDING');
    });

    it('does nothing for requests with no route', async () => {
      models.ApprovalPolicy.rows.length = 0;
      await submit();
      ayesha.reportingManagerId = omar.id;
      expect(await service.rerouteRequestsAfterReportingChange(TENANT, ayesha.id)).toBe(0);
    });
  });
});
