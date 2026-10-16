import { Op } from 'sequelize';
import { EXPORT_MAX_ROWS, EmployeeStatus, LeaveRequestStatus } from '@app/common';
import { LeaveBalanceService } from './leave-balance.service';
import { fiscalYear, fiscalYearContaining, fiscalYearStarting, roundDays } from './leave-fiscal-year';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ANNUAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SICK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INACTIVE_POLICY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const employee = (id: string, first: string, last: string, department = { id: 'd1', name: 'Engineering' }) => ({
  id,
  employeeCode: `EMP-${id}`,
  firstName: first,
  lastName: last,
  email: `${first.toLowerCase()}@example.com`,
  avatarUrl: null,
  department,
});

describe('LeaveBalanceService', () => {
  let employeeModel: any;
  let policyModel: any;
  let leaveModel: any;
  let dataScope: any;
  let service: LeaveBalanceService;

  beforeEach(() => {
    employeeModel = {
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
    };
    policyModel = {
      findAll: jest.fn().mockResolvedValue([
        { id: ANNUAL, name: 'Annual Leave', isPaid: true, annualAllocation: 21 },
        { id: SICK, name: 'Sick Leave', isPaid: true, annualAllocation: 8 },
      ]),
    };
    leaveModel = { findAll: jest.fn().mockResolvedValue([]) };
    dataScope = { employeeWhere: jest.fn().mockResolvedValue({}) };

    const modelProvider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getLeavePolicyModel: jest.fn().mockResolvedValue(policyModel),
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveModel),
    };
    service = new LeaveBalanceService(modelProvider, dataScope);
  });

  const withEmployees = (...rows: any[]) =>
    employeeModel.findAndCountAll.mockResolvedValue({ rows, count: rows.length });

  const sum = (employeeId: string, leavePolicyId: string, status: string, days: string | number) => ({
    employeeId,
    leavePolicyId,
    status,
    days,
  });

  describe('balances', () => {
    it('gives every active leave type its own column, ordered as the policies are', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));

      const result = await service.getAll(TENANT, {});

      expect(result.policies).toEqual([
        { id: ANNUAL, name: 'Annual Leave', isPaid: true, allocation: 21 },
        { id: SICK, name: 'Sick Leave', isPaid: true, allocation: 8 },
      ]);
      expect(result.data[0].balances.map((b) => b.name)).toEqual(['Annual Leave', 'Sick Leave']);
      // Only active leave types are asked for.
      expect(policyModel.findAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, isActive: true });
    });

    it('leaves an employee with no leave on their full allocation', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));

      const [row] = (await service.getAll(TENANT, {})).data;

      expect(row.balances[0]).toMatchObject({ allocation: 21, used: 0, pending: 0, remaining: 21, available: 21 });
      expect(row.totals).toEqual({ allocation: 29, used: 0, pending: 0, remaining: 29, available: 29 });
    });

    it('counts approved days as used and pending days as held back, per leave type', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'), employee('e2', 'Bilal', 'Hussain'));
      leaveModel.findAll.mockResolvedValue([
        sum('e1', ANNUAL, LeaveRequestStatus.APPROVED, '6'),
        sum('e1', ANNUAL, LeaveRequestStatus.PENDING, '2'),
        sum('e1', SICK, LeaveRequestStatus.APPROVED, 3),
        sum('e2', SICK, LeaveRequestStatus.PENDING, '1.5'),
      ]);

      const { data } = await service.getAll(TENANT, {});

      expect(data[0].balances[0]).toMatchObject({ used: 6, pending: 2, remaining: 15, available: 13 });
      expect(data[0].balances[1]).toMatchObject({ used: 3, pending: 0, remaining: 5, available: 5 });
      expect(data[0].totals).toMatchObject({ used: 9, pending: 2, remaining: 20, available: 18 });
      // Another employee's days never leak into this row.
      expect(data[1].balances[0]).toMatchObject({ used: 0, pending: 0, remaining: 21 });
      expect(data[1].balances[1]).toMatchObject({ used: 0, pending: 1.5, remaining: 8, available: 6.5 });
    });

    it('keeps half days exact and never goes below zero', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));
      leaveModel.findAll.mockResolvedValue([
        sum('e1', ANNUAL, LeaveRequestStatus.APPROVED, '0.5'),
        sum('e1', SICK, LeaveRequestStatus.APPROVED, '12'), // more than the 8 allowed
      ]);

      const [row] = (await service.getAll(TENANT, {})).data;

      expect(row.balances[0]).toMatchObject({ used: 0.5, remaining: 20.5 });
      expect(row.balances[1]).toMatchObject({ used: 12, remaining: 0, available: 0 });
    });

    it('ignores days taken under a leave type that is no longer active', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));
      leaveModel.findAll.mockResolvedValue([sum('e1', INACTIVE_POLICY, LeaveRequestStatus.APPROVED, '4')]);

      const [row] = (await service.getAll(TENANT, {})).data;

      expect(row.totals.used).toBe(0);
    });

    it('carries the department, or null for someone without one', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'), { ...employee('e2', 'Bilal', 'Hussain'), department: null });

      const { data } = await service.getAll(TENANT, {});

      expect(data[0].department).toEqual({ id: 'd1', name: 'Engineering' });
      expect(data[1].department).toBeNull();
    });
  });

  describe('fiscal year', () => {
    it('defaults to the current April–March year and reads leave that starts inside it', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));

      const result = await service.getAll(TENANT, {});

      const current = fiscalYear();
      expect(result.fiscalYear).toBe(current.label);
      expect(result.fiscalYearStart).toBe(current.start);
      expect(leaveModel.findAll.mock.calls[0][0].where.fromDate).toEqual({
        [Op.between]: [current.start, current.end],
      });
    });

    it('uses the starting year it is given', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));

      const result = await service.getAll(TENANT, { fiscalYear: 2025 });

      expect(result).toMatchObject({ fiscalYear: 'FY 2025-26', fiscalYearStart: '2025-04-01', fiscalYearEnd: '2026-03-31' });
      expect(leaveModel.findAll.mock.calls[0][0].where.fromDate).toEqual({
        [Op.between]: ['2025-04-01', '2026-03-31'],
      });
    });

    it('counts only approved and pending requests', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));

      await service.getAll(TENANT, {});

      expect(leaveModel.findAll.mock.calls[0][0].where.status).toEqual({
        [Op.in]: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING],
      });
    });
  });

  describe('who is listed and how', () => {
    it('lists only people still employed, narrowed to the caller\'s scope', async () => {
      dataScope.employeeWhere.mockResolvedValue({ id: { [Op.in]: ['e1'] } });

      await service.getAll(TENANT, {});

      const where = employeeModel.findAndCountAll.mock.calls[0][0].where;
      expect(where.tenantId).toBe(TENANT);
      expect(where.status).toEqual({ [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] });
      expect(where.id).toEqual({ [Op.in]: ['e1'] });
      expect(dataScope.employeeWhere).toHaveBeenCalledWith(TENANT, 'id');
    });

    it('filters by department', async () => {
      await service.getAll(TENANT, { departmentId: 'd9' });

      expect(employeeModel.findAndCountAll.mock.calls[0][0].where.departmentId).toBe('d9');
    });

    it('searches name, code and email, and treats % and _ as plain characters', async () => {
      await service.getAll(TENANT, { search: ' 50%_off ' });

      const { where } = employeeModel.findAndCountAll.mock.calls[0][0];
      const [{ [Op.or]: alternatives }] = where[Op.and];
      expect(alternatives).toHaveLength(5);
      expect(alternatives[0]).toEqual({ firstName: { [Op.iLike]: '%50\\%\\_off%' } });
      expect(alternatives[3]).toEqual({ employeeCode: { [Op.iLike]: '%50\\%\\_off%' } });
    });

    it('adds no search clause for a blank search', async () => {
      await service.getAll(TENANT, { search: '   ' });

      expect(employeeModel.findAndCountAll.mock.calls[0][0].where[Op.and]).toBeUndefined();
    });

    it('pages the employees, and the leave query covers only that page', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee('e11', 'Ayesha', 'Khan'), employee('e12', 'Bilal', 'Hussain')],
        count: 25,
      });

      const result = await service.getAll(TENANT, { page: 2, limit: 10 });

      const call = employeeModel.findAndCountAll.mock.calls[0][0];
      expect(call.offset).toBe(10);
      expect(call.limit).toBe(10);
      expect(result).toMatchObject({ total: 25, page: 2, limit: 10, totalPages: 3 });
      expect(leaveModel.findAll.mock.calls[0][0].where.employeeId).toEqual({ [Op.in]: ['e11', 'e12'] });
    });

    it('does not query leave at all when nobody matches', async () => {
      const result = await service.getAll(TENANT, { search: 'nobody' });

      expect(leaveModel.findAll).not.toHaveBeenCalled();
      expect(result).toMatchObject({ data: [], total: 0, totalPages: 1 });
    });

    it('sorts by name by default, and by department or code on request', async () => {
      await service.getAll(TENANT, {});
      expect(employeeModel.findAndCountAll.mock.calls[0][0].order).toEqual([
        ['firstName', 'ASC'],
        ['lastName', 'ASC'],
      ]);

      await service.getAll(TENANT, { sortBy: 'employeeCode', sortOrder: 'DESC' });
      expect(employeeModel.findAndCountAll.mock.calls[1][0].order).toEqual([['employeeCode', 'DESC']]);

      await service.getAll(TENANT, { sortBy: 'department' });
      const order = employeeModel.findAndCountAll.mock.calls[2][0].order;
      expect(order).toHaveLength(3);
      expect(order[1]).toEqual(['firstName', 'ASC']);
    });
  });

  describe('export', () => {
    it('returns every matching row with the leave types, and reports when it is not truncated', async () => {
      withEmployees(employee('e1', 'Ayesha', 'Khan'));

      const result = await service.getAllForExport(TENANT, { departmentId: 'd1' });

      expect(result).toMatchObject({ totalMatched: 1, truncated: false, limit: EXPORT_MAX_ROWS });
      expect(result.policies.map((p) => p.name)).toEqual(['Annual Leave', 'Sick Leave']);
      expect(result.rows).toHaveLength(1);
      expect(employeeModel.findAndCountAll.mock.calls[0][0].limit).toBe(EXPORT_MAX_ROWS);
      expect(employeeModel.findAndCountAll.mock.calls[0][0].offset).toBeUndefined();
    });

    it('says so when more people matched than the cap allows', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee('e1', 'Ayesha', 'Khan')],
        count: EXPORT_MAX_ROWS + 5,
      });

      const result = await service.getAllForExport(TENANT, {});

      expect(result.truncated).toBe(true);
      expect(result.totalMatched).toBe(EXPORT_MAX_ROWS + 5);
    });
  });
});

describe('leave fiscal year', () => {
  it('runs April to March', () => {
    expect(fiscalYearStarting(2026)).toEqual({ label: 'FY 2026-27', start: '2026-04-01', end: '2027-03-31' });
  });

  it('puts January to March in the year that began the previous April', () => {
    expect(fiscalYear(new Date(2027, 1, 10)).label).toBe('FY 2026-27');
    expect(fiscalYear(new Date(2026, 3, 1)).label).toBe('FY 2026-27');
    expect(fiscalYear(new Date(2026, 2, 31)).label).toBe('FY 2025-26');
  });

  it('places a date in its fiscal year', () => {
    expect(fiscalYearContaining('2026-03-31').label).toBe('FY 2025-26');
    expect(fiscalYearContaining('2026-04-01').label).toBe('FY 2026-27');
  });

  it('rounds days to one decimal', () => {
    expect(roundDays(0.5)).toBe(0.5);
    expect(roundDays(2.0000001)).toBe(2);
    expect(roundDays(1.26)).toBe(1.3);
  });
});
