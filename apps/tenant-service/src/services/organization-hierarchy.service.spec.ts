import { Op } from 'sequelize';
import { EmployeeStatus } from '@app/common';
import { OrganizationHierarchyService } from './organization-hierarchy.service';

/**
 * Structure used below:
 *
 *   Engineering (head: lead, Lahore HQ)
 *   └── QA (sub-department)
 *   Sales
 *
 *   ceo
 *   └── lead  (Engineering)
 *       ├── dev   (Engineering)
 *       │   └── intern (QA)
 *       └── dev2  (Engineering)
 *   sales (Sales, reports to nobody)
 */
describe('OrganizationHierarchyService', () => {
  const TENANT = 'tenant-1';

  let people: any[];
  let departments: any[];
  let history: any[];

  const inList = (filter: any, value: any) =>
    filter && typeof filter === 'object' && Op.in in filter
      ? filter[Op.in].includes(value)
      : filter === value;
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, filter]) => {
      if (key === 'tenantId') return true;
      if (filter && typeof filter === 'object' && Op.ne in (filter as any))
        return row[key] !== (filter as any)[Op.ne];
      return inList(filter, row[key]);
    });

  const asModel = (row: any) => ({
    ...row,
    update: jest.fn(async (patch: any) => Object.assign(row, patch)),
  });

  const employeeModel = {
    findOne: jest.fn(async ({ where }: any) => {
      const row = people.find((p) => matches(p, where));
      return row ? asModel(row) : null;
    }),
    findAll: jest.fn(async ({ where }: any) =>
      people.filter((p) => matches(p, where)).map(asModel),
    ),
    count: jest.fn(
      async ({ where }: any) => people.filter((p) => matches(p, where)).length,
    ),
  };
  const departmentModel = {
    findAll: jest.fn(async ({ where }: any) =>
      departments.filter((d) => matches(d, where)),
    ),
    count: jest.fn(
      async ({ where }: any) =>
        departments.filter((d) => matches(d, where)).length,
    ),
  };
  const designationModel = {
    findAll: jest.fn(async () => []),
    count: jest.fn(async () => 1),
  };
  const historyModel = {
    bulkCreate: jest.fn(async (rows: any[]) => {
      history.push(...rows);
      return rows;
    }),
    findAll: jest.fn(async ({ where }: any) =>
      history.filter((h) => matches(h, where)),
    ),
  };

  const provider = {
    getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
    getDepartmentModel: jest.fn().mockResolvedValue(departmentModel),
    getDesignationModel: jest.fn().mockResolvedValue(designationModel),
    getHierarchyChangeModel: jest.fn().mockResolvedValue(historyModel),
  } as any;

  /** Organization-wide unless a test narrows it. */
  let visible: string[] | null = null;
  const dataScope = {
    visibleEmployeeIds: jest.fn(async () => visible),
    canSee: jest.fn(
      async (_t: string, id: string) =>
        visible === null || visible.includes(id),
    ),
    employeeWhere: jest.fn(async (_t: string, field: string) =>
      visible === null ? {} : { [field]: { [Op.in]: visible } },
    ),
  } as any;

  const service = new OrganizationHierarchyService(provider, dataScope);

  beforeEach(() => {
    visible = null;
    history = [];
    const person = (
      id: string,
      reportingManagerId: string | null,
      departmentId: string | null,
    ) => ({
      id,
      employeeCode: id.toUpperCase(),
      firstName: id,
      lastName: 'X',
      status: EmployeeStatus.ACTIVE,
      reportingManagerId,
      departmentId,
      designationId: null,
      department: departmentId
        ? { id: departmentId, name: departmentId }
        : null,
      designation: null,
    });
    people = [
      person('ceo', null, null),
      person('lead', 'ceo', 'eng'),
      person('dev', 'lead', 'eng'),
      person('intern', 'dev', 'qa'),
      person('dev2', 'lead', 'eng'),
      person('sales', null, 'sales-dept'),
    ];
    departments = [
      {
        id: 'eng',
        name: 'Engineering',
        code: 'ENG',
        parentDepartmentId: null,
        managerId: 'lead',
        location: 'Lahore HQ',
        isActive: true,
      },
      {
        id: 'qa',
        name: 'QA',
        code: null,
        parentDepartmentId: 'eng',
        managerId: null,
        location: null,
        isActive: true,
      },
      {
        id: 'sales-dept',
        name: 'Sales',
        code: null,
        parentDepartmentId: null,
        managerId: null,
        location: null,
        isActive: true,
      },
    ];
  });

  describe('circular reporting', () => {
    it('refuses a manager who reports to the employee, at any depth', async () => {
      // intern reports to dev reports to lead: lead cannot report to intern.
      await expect(
        service.assertNoReportingCycle(TENANT, 'lead', 'intern'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('circular'),
      });
      await expect(
        service.assertNoReportingCycle(TENANT, 'lead', 'dev'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('circular'),
      });
    });

    it('refuses self and allows an unrelated manager', async () => {
      await expect(
        service.assertNoReportingCycle(TENANT, 'dev', 'dev'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('themselves'),
      });
      await expect(
        service.assertNoReportingCycle(TENANT, 'dev', 'sales'),
      ).resolves.toBeUndefined();
      await expect(
        service.assertNoReportingCycle(TENANT, 'dev', null),
      ).resolves.toBeUndefined();
    });
  });

  describe('reporting assignment', () => {
    it('moves the employee and writes one history row per changed field', async () => {
      const result = await service.updateEmployeeReporting(TENANT, 'dev2', {
        reportingManagerId: 'sales',
        departmentId: 'sales-dept',
        effectiveFrom: '2026-11-01',
        note: 'Moved to sales engineering',
      });

      expect(people.find((p) => p.id === 'dev2')).toMatchObject({
        reportingManagerId: 'sales',
        departmentId: 'sales-dept',
      });
      expect(result.reportingManager).toMatchObject({ id: 'sales' });
      expect(history).toHaveLength(2);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subjectType: 'EMPLOYEE',
            subjectId: 'dev2',
            changeType: 'REPORTING_MANAGER',
            previousId: 'lead',
            previousLabel: 'lead X',
            nextId: 'sales',
            nextLabel: 'sales X',
            effectiveFrom: '2026-11-01',
            note: 'Moved to sales engineering',
          }),
          expect.objectContaining({
            changeType: 'DEPARTMENT',
            previousId: 'eng',
            previousLabel: 'Engineering',
            nextId: 'sales-dept',
            nextLabel: 'Sales',
          }),
        ]),
      );
    });

    it('does not record a field that did not change, and refuses an empty change', async () => {
      await service.updateEmployeeReporting(TENANT, 'dev2', {
        reportingManagerId: 'lead',
      });
      expect(history).toHaveLength(0);
      await expect(
        service.updateEmployeeReporting(TENANT, 'dev2', {}),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Nothing to change'),
      });
    });

    it('refuses a resigned manager and a circular one', async () => {
      people.find((p) => p.id === 'sales').status = EmployeeStatus.RESIGNED;
      await expect(
        service.updateEmployeeReporting(TENANT, 'dev', {
          reportingManagerId: 'sales',
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('resigned'),
      });
      await expect(
        service.updateEmployeeReporting(TENANT, 'lead', {
          reportingManagerId: 'intern',
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('circular'),
      });
      expect(history).toHaveLength(0);
    });

    it("is hidden outside the caller's scope", async () => {
      visible = ['sales'];
      await expect(
        service.updateEmployeeReporting(TENANT, 'dev', {
          reportingManagerId: null,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
      });
    });

    it('returns the chain upward and the direct reports', async () => {
      const result = await service.getEmployeeReporting(TENANT, 'dev');
      expect(result.reportingChain.map((p) => p.id)).toEqual(['lead', 'ceo']);
      expect(result.directReports.map((p) => p.id)).toEqual(['intern']);
      expect(
        (await service.getEmployeeReporting(TENANT, 'lead')).headOf,
      ).toEqual([{ id: 'eng', name: 'Engineering' }]);
    });
  });

  describe("reassigning a manager's reports", () => {
    it('hands every direct report to the new manager with history', async () => {
      const result = await service.reassignReports(TENANT, {
        fromManagerId: 'lead',
        toManagerId: 'sales',
        note: 'Lead resigned',
      });
      expect(result.moved).toBe(2);
      expect(
        people.filter((p) => p.reportingManagerId === 'lead'),
      ).toHaveLength(0);
      expect(
        people
          .filter((p) => p.reportingManagerId === 'sales')
          .map((p) => p.id)
          .sort(),
      ).toEqual(['dev', 'dev2']);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        changeType: 'REPORTING_MANAGER',
        previousId: 'lead',
        nextId: 'sales',
        note: 'Lead resigned',
      });
    });

    it('refuses when the new manager sits under the people being moved', async () => {
      // intern reports to dev, who reports to lead: handing lead's reports to intern would loop.
      await expect(
        service.reassignReports(TENANT, {
          fromManagerId: 'lead',
          toManagerId: 'intern',
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('circular'),
      });
      expect(people.find((p) => p.id === 'dev').reportingManagerId).toBe(
        'lead',
      );
    });
  });

  describe('trees', () => {
    it('nests departments and sums headcount down the tree, organization-wide', async () => {
      const { scope, departments: roots } =
        await service.getDepartmentTree(TENANT);
      expect(scope).toBe('ORGANIZATION');
      expect(roots.map((d) => d.name)).toEqual(['Engineering', 'Sales']);
      const eng = roots[0];
      expect(eng).toMatchObject({
        location: 'Lahore HQ',
        head: expect.objectContaining({ id: 'lead' }),
        employeeCount: 3,
        totalEmployeeCount: 4,
      });
      expect(eng.children.map((d) => d.name)).toEqual(['QA']);
      expect(eng.children[0]).toMatchObject({
        employeeCount: 1,
        totalEmployeeCount: 1,
      });
    });

    it('shows a scoped caller only the departments holding people they may see, plus parents', async () => {
      visible = ['dev', 'intern'];
      const { scope, departments: roots } =
        await service.getDepartmentTree(TENANT);
      expect(scope).toBe('SCOPED');
      expect(roots.map((d) => d.name)).toEqual(['Engineering']);
      expect(roots[0]).toMatchObject({
        employeeCount: 1,
        totalEmployeeCount: 2,
      });
      expect(roots[0].children.map((d) => d.name)).toEqual(['QA']);
    });

    it('builds the reporting tree from the top with team sizes', async () => {
      const { roots } = await service.getReportingTree(TENANT);
      expect(roots.map((n) => n.id)).toEqual(['ceo', 'sales']);
      const ceo = roots[0];
      expect(ceo).toMatchObject({ directReports: 1, teamSize: 4 });
      expect(ceo.children[0]).toMatchObject({
        id: 'lead',
        directReports: 2,
        teamSize: 3,
        headOf: [{ id: 'eng', name: 'Engineering' }],
      });
    });

    it("roots a scoped caller's tree at the top of what they can see", async () => {
      visible = ['dev', 'intern'];
      const { roots } = await service.getReportingTree(TENANT);
      expect(roots.map((n) => n.id)).toEqual(['dev']);
      expect(roots[0]).toMatchObject({ teamSize: 1 });
      await expect(
        service.getReportingTree(TENANT, 'lead'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
      });
    });

    it('returns one branch when rooted at an employee', async () => {
      const { roots } = await service.getReportingTree(TENANT, 'lead');
      expect(roots).toHaveLength(1);
      expect(roots[0].children.map((n) => n.id)).toEqual(['dev', 'dev2']);
    });
  });

  describe('history', () => {
    it('records a department head change with names, and reads it back newest first', async () => {
      await service.recordDepartmentHead(TENANT, 'eng', 'lead', 'dev');
      await service.recordDepartmentHead(TENANT, 'eng', 'dev', 'dev'); // no change, nothing written
      const rows = await service.getDepartmentHistory(TENANT, 'eng');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        changeType: 'DEPARTMENT_HEAD',
        previous: { id: 'lead', label: 'lead X' },
        next: { id: 'dev', label: 'dev X' },
      });
    });

    it('records only the assignment fields that moved on a general employee edit', async () => {
      await service.recordEmployeeAssignment(
        TENANT,
        'dev',
        {
          reportingManagerId: 'lead',
          departmentId: 'eng',
          designationId: null,
        },
        {
          reportingManagerId: 'lead',
          departmentId: 'qa',
          designationId: undefined,
        },
      );
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        changeType: 'DEPARTMENT',
        previousLabel: 'Engineering',
        nextLabel: 'QA',
      });
    });
  });
});
