import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { DataScope } from '@app/common';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { PayrollCompensationService } from './payroll-compensation.service';

/**
 * A department or team role keeps the payroll permission, but only for its
 * own people. Organization-wide roles are unchanged because they never pass
 * a narrowed scope in.
 */
describe('scoped payroll reads', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  const scope = {
    scope: () => DataScope.DEPARTMENT,
    visibleEmployeeIds: async () => ['emp-1'],
    employeeWhere: async (_tenant: string, field = 'employeeId') => ({ [field]: { [Op.in]: ['emp-1'] } }),
    assertCanSee: async (_tenant: string, employeeId: string) => {
      if (employeeId !== 'emp-1') {
        const error = new Error('outside') as Error & { status: number };
        error.status = HttpStatus.NOT_FOUND;
        throw error;
      }
    },
  };

  it('refuses to open a company payroll run from a narrowed role', async () => {
    const service = new PayrollDashboardService({} as any, undefined, undefined, undefined, undefined, scope as any);

    await expect(
      service.createRun(TENANT, { periodStart: '2026-10-01', periodEnd: '2026-10-31' } as any),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('lists compensation only for the people in scope', async () => {
    const employees = { findAll: jest.fn().mockResolvedValue([]) };
    const provider = {
      getEmployeeModel: async () => employees,
      getSalaryRevisionModel: async () => ({ findAll: async () => [] }),
      getDepartmentModel: async () => ({}),
    };
    const service = new PayrollCompensationService(provider as any, scope as any);

    await service.listEmployeeCompensation(TENANT);

    expect(employees.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { [Op.in]: ['emp-1'] } }),
      }),
    );
  });
});
