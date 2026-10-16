import { Op, UniqueConstraintError } from 'sequelize';
import { EmployeeStatus, ShiftStatusFilter } from '@app/common';
import { ShiftService } from './shift.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MORNING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NIGHT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const E1 = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const E2 = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';

/** A Sequelize-like instance: `update` writes the fields back onto it. */
const shift = (over: Record<string, any> = {}) => {
  const row: any = {
    id: MORNING,
    tenantId: TENANT,
    name: 'Morning Shift',
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 60,
    workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    isActive: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
  row.update = jest.fn(async (patch: Record<string, any>) => Object.assign(row, patch));
  row.destroy = jest.fn().mockResolvedValue(undefined);
  return row;
};

describe('ShiftService', () => {
  let shiftModel: any;
  let employeeShiftModel: any;
  let employeeModel: any;
  let sequelize: any;
  let dataScope: any;
  let service: ShiftService;

  beforeEach(() => {
    shiftModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (values: any) => shift({ id: 'new-id', ...values })),
    };
    sequelize = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (work: (t: unknown) => unknown) => work('tx')),
    };
    employeeShiftModel = {
      sequelize,
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      destroy: jest.fn().mockResolvedValue(0),
      bulkCreate: jest.fn().mockResolvedValue([]),
    };
    employeeModel = { findAll: jest.fn().mockResolvedValue([]) };
    dataScope = { employeeWhere: jest.fn().mockResolvedValue({}) };

    const provider: any = {
      getShiftModel: jest.fn().mockResolvedValue(shiftModel),
      getEmployeeShiftModel: jest.fn().mockResolvedValue(employeeShiftModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
    };
    service = new ShiftService(provider, dataScope);
  });

  const existing = (row = shift()) => shiftModel.findOne.mockResolvedValueOnce(row);

  describe('create', () => {
    const dto = (over: Record<string, any> = {}) => ({
      name: 'Morning Shift',
      startTime: '09:00',
      endTime: '18:00',
      workingDays: ['FRIDAY', 'MONDAY', 'TUESDAY'],
      ...over,
    });

    it('creates the shift with defaults, working days in week order, and nobody on it', async () => {
      const row = await service.create(TENANT, dto() as any);

      expect(shiftModel.create).toHaveBeenCalledWith({
        tenantId: TENANT,
        name: 'Morning Shift',
        startTime: '09:00',
        endTime: '18:00',
        breakMinutes: 60,
        workingDays: ['MONDAY', 'TUESDAY', 'FRIDAY'],
        isActive: true,
      });
      expect(row).toMatchObject({
        durationMinutes: 540,
        workingMinutes: 480,
        crossesMidnight: false,
        employeeCount: 0,
        workingDays: ['MONDAY', 'TUESDAY', 'FRIDAY'],
      });
    });

    it('understands a night shift that ends the next day', async () => {
      const row = await service.create(TENANT, dto({ startTime: '22:00', endTime: '06:00', breakMinutes: 30 }) as any);

      expect(row).toMatchObject({ crossesMidnight: true, durationMinutes: 480, workingMinutes: 450 });
    });

    it('refuses a shift that starts and ends at the same time', async () => {
      await expect(service.create(TENANT, dto({ endTime: '09:00' }) as any)).rejects.toMatchObject({ status: 400 });
      expect(shiftModel.create).not.toHaveBeenCalled();
    });

    it('refuses a break as long as the shift', async () => {
      await expect(service.create(TENANT, dto({ startTime: '09:00', endTime: '10:00', breakMinutes: 60 }) as any)).rejects.toMatchObject({
        status: 400,
        message: 'The break must be shorter than the shift.',
      });
    });

    it('refuses a name already used, whatever its case', async () => {
      shiftModel.findOne.mockResolvedValue({ id: 'other' });

      await expect(service.create(TENANT, dto({ name: 'MORNING shift' }) as any)).rejects.toMatchObject({
        status: 409,
        message: "A shift named 'MORNING shift' already exists in this organization.",
      });
    });

    it('reports a duplicate that two requests raced into as the same conflict', async () => {
      shiftModel.create.mockRejectedValue(new UniqueConstraintError({}));

      await expect(service.create(TENANT, dto() as any)).rejects.toMatchObject({ status: 409 });
    });

    it('lets an unexpected database error through untouched', async () => {
      shiftModel.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(TENANT, dto() as any)).rejects.toThrow('connection lost');
    });
  });

  describe('list', () => {
    beforeEach(() => {
      shiftModel.findAll.mockResolvedValue([
        shift({ id: MORNING, name: 'Morning Shift' }),
        shift({ id: NIGHT, name: 'Night Shift', startTime: '22:00', endTime: '06:00', isActive: false }),
      ]);
      sequelize.query.mockResolvedValue([{ shiftId: MORNING, count: 4 }, { shiftId: NIGHT, count: 2 }]);
    });

    it('counts the people on each shift and totals them for the page header', async () => {
      const result = await service.getAll(TENANT, {});

      expect(result.data.map((row) => [row.name, row.employeeCount])).toEqual([
        ['Morning Shift', 4],
        ['Night Shift', 2],
      ]);
      expect(result.summary).toEqual({ total: 2, active: 1, inactive: 1, assignedEmployees: 6 });
    });

    it('counts only people still employed', async () => {
      await service.getAll(TENANT, {});

      const [sql, options] = sequelize.query.mock.calls[0];
      expect(sql).toContain('e.status IN (:statuses)');
      expect(options.replacements).toEqual({ tenantId: TENANT, statuses: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] });
    });

    it('filters by status and name, but the header totals still cover every shift', async () => {
      const inactive = await service.getAll(TENANT, { status: ShiftStatusFilter.INACTIVE });
      expect(inactive.data.map((row) => row.name)).toEqual(['Night Shift']);
      expect(inactive.summary.total).toBe(2);

      const named = await service.getAll(TENANT, { search: ' morn ' });
      expect(named.data.map((row) => row.name)).toEqual(['Morning Shift']);
    });

    it('gives a shift nobody is on a count of zero', async () => {
      sequelize.query.mockResolvedValue([]);

      const result = await service.getAll(TENANT, {});

      expect(result.data.every((row) => row.employeeCount === 0)).toBe(true);
    });
  });

  describe('update', () => {
    it('changes only what was sent, and keeps the working days in week order', async () => {
      const row = shift();
      existing(row);

      const result = await service.update(TENANT, MORNING, { workingDays: ['SATURDAY', 'MONDAY'] as any, isActive: false });

      expect(row.update).toHaveBeenCalledWith({
        name: 'Morning Shift',
        startTime: '09:00',
        endTime: '18:00',
        breakMinutes: 60,
        workingDays: ['MONDAY', 'SATURDAY'],
        isActive: false,
      });
      expect(result.isActive).toBe(false);
    });

    it('checks the schedule as it will be, not just the fields that changed', async () => {
      existing(shift({ startTime: '09:00', endTime: '18:00', breakMinutes: 60 }));

      // Moving only the end time to 09:30 leaves a 30-minute shift with a 60-minute break.
      await expect(service.update(TENANT, MORNING, { endTime: '09:30' })).rejects.toMatchObject({ status: 400 });
    });

    it('refuses a rename onto another shift\'s name, ignoring the shift itself', async () => {
      existing(shift());
      shiftModel.findOne.mockResolvedValueOnce({ id: 'other' });

      await expect(service.update(TENANT, MORNING, { name: 'Night Shift' })).rejects.toMatchObject({ status: 409 });
      const clash = shiftModel.findOne.mock.calls[1][0].where;
      expect(clash.id).toEqual({ [Op.ne]: MORNING });
    });

    it('does not look for a clash when only the case of its own name changes', async () => {
      existing(shift());

      await service.update(TENANT, MORNING, { name: 'MORNING SHIFT' });

      expect(shiftModel.findOne).toHaveBeenCalledTimes(1);
    });

    it('is a 404 for a shift that is not there', async () => {
      await expect(service.update(TENANT, MORNING, { name: 'X' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('duplicate', () => {
    it('copies the shift under "<name> Copy" with nobody on it', async () => {
      existing(shift());
      shiftModel.findAll.mockResolvedValue([{ name: 'Morning Shift' }]);

      const copy = await service.duplicate(TENANT, MORNING);

      expect(shiftModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Morning Shift Copy', startTime: '09:00', endTime: '18:00', breakMinutes: 60 }),
      );
      expect(copy.employeeCount).toBe(0);
    });

    it('numbers the copy when "Copy" is taken', async () => {
      existing(shift());
      shiftModel.findAll.mockResolvedValue([{ name: 'Morning Shift' }, { name: 'morning shift copy' }]);

      await service.duplicate(TENANT, MORNING);

      expect(shiftModel.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Morning Shift Copy 2' }));
    });

    it('keeps a very long name inside the limit', async () => {
      existing(shift({ name: 'N'.repeat(100) }));
      shiftModel.findAll.mockResolvedValue([{ name: 'N'.repeat(100) }]);

      await service.duplicate(TENANT, MORNING);

      const { name } = shiftModel.create.mock.calls[0][0];
      expect(name).toHaveLength(100);
      expect(name.endsWith(' Copy')).toBe(true);
    });
  });

  describe('delete', () => {
    it('refuses while people are on the shift and says what to do instead', async () => {
      existing(shift());
      employeeShiftModel.count.mockResolvedValue(3);

      await expect(service.remove(TENANT, MORNING)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('has 3 employees on it'),
      });
    });

    it('deletes an empty shift and returns a body', async () => {
      const row = shift();
      existing(row);

      await expect(service.remove(TENANT, MORNING)).resolves.toEqual({ deleted: true, id: MORNING });
      expect(row.destroy).toHaveBeenCalled();
    });
  });

  describe('employees on a shift', () => {
    const employed = (id: string, status = EmployeeStatus.ACTIVE) => ({ id, firstName: 'Ayesha', lastName: 'Khan', status });

    it('lists them by name with their department', async () => {
      existing(shift());
      employeeShiftModel.findAll.mockResolvedValue([
        {
          employee: {
            id: E1,
            employeeCode: 'EMP001',
            firstName: 'Ayesha',
            lastName: 'Khan',
            email: 'a@example.com',
            avatarUrl: null,
            department: { id: 'd1', name: 'Engineering' },
          },
        },
      ]);

      const result = await service.getEmployees(TENANT, MORNING);

      expect(result).toEqual({
        total: 1,
        data: [
          {
            id: E1,
            employeeCode: 'EMP001',
            name: 'Ayesha Khan',
            email: 'a@example.com',
            avatarUrl: null,
            department: { id: 'd1', name: 'Engineering' },
          },
        ],
      });
    });

    it('sets the roster: takes unlisted people off, moves listed ones here, adds the new', async () => {
      existing(shift());
      employeeModel.findAll.mockResolvedValue([employed(E1), employed(E2)]);
      // E1 is already on this shift; E2 is new.
      employeeShiftModel.findAll
        .mockResolvedValueOnce([{ employeeId: E1 }]) // already here, before the transaction
        .mockResolvedValueOnce([{ employeeId: E1 }]); // inside the transaction

      await service.setEmployees(TENANT, MORNING, { employeeIds: [E1, E2, E1] });

      expect(sequelize.transaction).toHaveBeenCalledTimes(1);
      const destroys = employeeShiftModel.destroy.mock.calls.map(([options]: any) => options.where);
      // Off this shift: everyone not listed.
      expect(destroys[0]).toEqual({ tenantId: TENANT, shiftId: MORNING, employeeId: { [Op.notIn]: [E1, E2] } });
      // Off their previous shift.
      expect(destroys[1]).toEqual({ tenantId: TENANT, employeeId: { [Op.in]: [E1, E2] }, shiftId: { [Op.ne]: MORNING } });
      // Only the new person is added.
      expect(employeeShiftModel.bulkCreate).toHaveBeenCalledWith([{ tenantId: TENANT, shiftId: MORNING, employeeId: E2 }], {
        transaction: 'tx',
      });
    });

    it('an empty list clears the shift', async () => {
      existing(shift());

      await service.setEmployees(TENANT, MORNING, { employeeIds: [] });

      expect(employeeShiftModel.destroy).toHaveBeenCalledTimes(1);
      expect(employeeShiftModel.destroy.mock.calls[0][0].where).toEqual({ tenantId: TENANT, shiftId: MORNING });
      expect(employeeShiftModel.bulkCreate).not.toHaveBeenCalled();
      expect(employeeModel.findAll).not.toHaveBeenCalled();
    });

    it('is a 404 when someone is not in the organization, or outside the caller\'s scope', async () => {
      existing(shift());
      employeeModel.findAll.mockResolvedValue([employed(E1)]);

      await expect(service.setEmployees(TENANT, MORNING, { employeeIds: [E1, E2] })).rejects.toMatchObject({
        status: 404,
        message: '1 of the selected employees were not found in this organization.',
      });
      expect(sequelize.transaction).not.toHaveBeenCalled();
    });

    it('refuses people who are no longer employed', async () => {
      existing(shift());
      employeeModel.findAll.mockResolvedValue([employed(E1, EmployeeStatus.RESIGNED)]);

      await expect(service.setEmployees(TENANT, MORNING, { employeeIds: [E1] })).rejects.toMatchObject({ status: 400 });
    });

    it('will not put new people on an inactive shift', async () => {
      existing(shift({ isActive: false }));
      employeeModel.findAll.mockResolvedValue([employed(E1)]);

      await expect(service.setEmployees(TENANT, MORNING, { employeeIds: [E1] })).rejects.toMatchObject({ status: 409 });
    });

    it('still lets an inactive shift keep or shed the people already on it', async () => {
      existing(shift({ isActive: false }));
      employeeModel.findAll.mockResolvedValue([employed(E1)]);
      employeeShiftModel.findAll.mockResolvedValue([{ employeeId: E1 }]);

      await expect(service.setEmployees(TENANT, MORNING, { employeeIds: [E1] })).resolves.toBeDefined();
    });

    it('applies the caller\'s data scope when looking the employees up', async () => {
      existing(shift());
      dataScope.employeeWhere.mockResolvedValue({ id: { [Op.in]: [E1] } });
      employeeModel.findAll.mockResolvedValue([employed(E1)]);
      employeeShiftModel.findAll.mockResolvedValue([]);

      await service.setEmployees(TENANT, MORNING, { employeeIds: [E1] });

      expect(dataScope.employeeWhere).toHaveBeenCalledWith(TENANT, 'id');
      expect(employeeModel.findAll.mock.calls[0][0].where.id).toEqual({ [Op.in]: [E1] });
    });
  });
});
