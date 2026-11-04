import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { EmployeeAssignmentService } from './employee-assignment.service';
import { table } from './testing/fake-table';

/**
 * Additional roles beside the primary position: what may be added, what it
 * records, and who sees it. The primary position stays on the employee.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['employee.edit'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', departmentId: null, designationId: null, reportingManagerId: null, ...over });

describe('EmployeeAssignmentService', () => {
  let models: Record<string, any>;
  let dataScope: { assertCanSee: jest.Mock };
  let service: EmployeeAssignmentService;
  let ayesha: any;
  let sara: any;
  let omar: any;
  let design: any;
  let marketing: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Gone', userId: 'u-omar', email: 'omar@x.com', status: 'RESIGNED' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Design' }, { tenantId: TENANT, name: 'Marketing' }]),
      Designation: table([{ tenantId: TENANT, title: 'Lead' }]),
      Assignment: table(),
      Change: table(),
      Notification: table(),
    };
    [ayesha, sara, omar] = models.Employee.rows;
    [design, marketing] = models.Department.rows;
    ayesha.departmentId = design.id;
    ayesha.reportingManagerId = sara.id;
    models.Department.rows[1].managerId = sara.id;
    dataScope = { assertCanSee: jest.fn().mockResolvedValue(undefined) };
    const provider: any = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getEmployeeAssignmentModel: async () => models.Assignment,
      getHierarchyChangeModel: async () => models.Change,
      getEmployeeNotificationModel: async () => models.Notification,
    };
    service = new EmployeeAssignmentService(provider, dataScope as any);
  });

  const add = (dto: Record<string, unknown>, employee = ayesha) => as(HR, () => service.add(TENANT, employee.id, dto as any));

  describe('adding', () => {
    it('gives someone a second department and a dotted-line manager, records it, and tells both', async () => {
      const view: any = await add({ departmentId: marketing.id, reportingManagerId: sara.id, title: 'Brand liaison', startDate: '2026-11-01' });

      expect(view).toMatchObject({ department: { name: 'Marketing' }, reportingManager: { name: 'Sara Manager' }, title: 'Brand liaison', startDate: '2026-11-01', endDate: null, active: true, createdBy: 'hr@x.com' });
      expect(models.Change.rows[0]).toMatchObject({ subjectType: 'EMPLOYEE', subjectId: ayesha.id, changeType: 'ASSIGNMENT_ADDED', nextId: view.id, effectiveFrom: '2026-11-01', changedByEmail: 'hr@x.com' });
      expect(models.Change.rows[0].nextLabel).toContain('Marketing');
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[ayesha.id, 'New additional role'], [sara.id, 'Added to your team']]);
    });

    it('leaves the primary position alone', async () => {
      await add({ departmentId: marketing.id });
      expect(ayesha).toMatchObject({ departmentId: design.id, reportingManagerId: sara.id });
    });

    it('needs a department, a manager or a title, and each must be real', async () => {
      await expect(add({ designationId: models.Designation.rows[0].id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(add({ departmentId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(add({ title: 'Liaison', designationId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(add({ reportingManagerId: omar.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(models.Assignment.rows).toHaveLength(0);
    });

    it('is not for someone who has left, and a person cannot be their own manager', async () => {
      await expect(add({ title: 'x' }, omar)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(add({ reportingManagerId: ayesha.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('refuses the same assignment twice, and more than five at a time', async () => {
      await add({ departmentId: marketing.id });
      await expect(add({ departmentId: marketing.id })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      for (const title of ['A', 'B', 'C', 'D']) await add({ title });
      await expect(add({ title: 'F' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('is only for someone the caller can reach', async () => {
      dataScope.assertCanSee.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
      await expect(add({ title: 'x' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('changing and ending', () => {
    it('changes a running assignment and keeps what was not touched', async () => {
      const added: any = await add({ departmentId: marketing.id, title: 'Liaison' });

      const changed: any = await as(HR, () => service.update(TENANT, ayesha.id, added.id, { title: 'Senior liaison', reportingManagerId: sara.id } as any));

      expect(changed).toMatchObject({ title: 'Senior liaison', department: { name: 'Marketing' }, reportingManager: { name: 'Sara Manager' } });
    });

    it('does not let an update empty the assignment', async () => {
      const added: any = await add({ title: 'Liaison' });
      await expect(as(HR, () => service.update(TENANT, ayesha.id, added.id, { title: null } as any))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('ends it from a date, keeps it on record, and cannot end or change it again', async () => {
      const added: any = await add({ departmentId: marketing.id, startDate: '2026-01-01' });

      const ended: any = await as(HR, () => service.end(TENANT, ayesha.id, added.id, { endDate: '2026-02-01' } as any));

      expect(ended).toMatchObject({ endDate: '2026-02-01', active: false });
      expect(models.Change.rows.at(-1)).toMatchObject({ changeType: 'ASSIGNMENT_ENDED', previousId: added.id, effectiveFrom: '2026-02-01' });
      await expect(as(HR, () => service.end(TENANT, ayesha.id, added.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(as(HR, () => service.update(TENANT, ayesha.id, added.id, { title: 'x' } as any))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('cannot end before it started', async () => {
      const added: any = await add({ title: 'Liaison', startDate: '2026-05-01' });
      await expect(as(HR, () => service.end(TENANT, ayesha.id, added.id, { endDate: '2026-04-01' } as any))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('does not find another person\'s assignment under this employee', async () => {
      const added: any = await add({ title: 'Liaison' });
      await expect(as(HR, () => service.end(TENANT, sara.id, added.id))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('reading', () => {
    it('shows the primary position and the assignments, running ones first', async () => {
      const first: any = await add({ title: 'Old role', startDate: '2026-01-01' });
      await as(HR, () => service.end(TENANT, ayesha.id, first.id, { endDate: '2026-02-01' } as any));
      await add({ departmentId: marketing.id });

      const result: any = await as(HR, () => service.list(TENANT, ayesha.id));

      expect(result.primary).toMatchObject({ department: { name: 'Design' }, reportingManager: { name: 'Sara Manager' } });
      expect(result.data.map((a: any) => [a.title ?? a.department?.name, a.active])).toEqual([['Marketing', true], ['Old role', false]]);
    });

    it('shows the employee their own roles, and who else works for them or the department they head', async () => {
      await add({ reportingManagerId: sara.id, title: 'Dotted line' });
      await add({ departmentId: marketing.id }, sara);
      await add({ title: 'Ended one', reportingManagerId: sara.id, startDate: '2026-01-01' }).then((a: any) => as(HR, () => service.end(TENANT, ayesha.id, a.id, { endDate: '2026-02-01' } as any)));

      const mine: any = await service.listMine(TENANT, 'u-sara');

      expect(mine.assignments.map((a: any) => a.department?.name)).toEqual(['Marketing']);
      expect(mine.alsoSupporting).toHaveLength(1);
      expect(mine.alsoSupporting[0]).toMatchObject({ title: 'Dotted line', employee: { name: 'Ayesha Khan' } });
    });

    it('needs an employee profile for my roles', async () => {
      await expect(service.listMine(TENANT, 'u-nobody')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });
});
