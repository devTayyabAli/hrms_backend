import { PERMISSIONS_KEY } from '@app/tenant-context';
import { PayrollController } from './payroll.controller';

/**
 * Who may call each payroll route, pinned. The separation that matters:
 * preparing a payroll (edit) and signing it off (approve) are different
 * grants, and salary data needs payroll permissions — never employee ones.
 */
const permissionsOf = (method: keyof PayrollController): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, PayrollController.prototype[method]) ?? [];

describe('PayrollController permissions', () => {
  it.each<[keyof PayrollController, string[]]>([
    ['getOverview', ['payroll.view', 'payroll.manage']],
    ['getRuns', ['payroll.view', 'payroll.manage']],
    ['getRun', ['payroll.view', 'payroll.manage']],
    ['getRecord', ['payroll.view', 'payroll.manage']],
    ['createRun', ['payroll.create', 'payroll.manage']],
    ['recalculateRun', ['payroll.edit', 'payroll.manage']],
    ['submitRun', ['payroll.edit', 'payroll.manage']],
    ['addAdjustment', ['payroll.edit', 'payroll.manage']],
    ['removeAdjustment', ['payroll.edit', 'payroll.manage']],
    ['approveRun', ['payroll.approve', 'payroll.manage']],
    ['returnRun', ['payroll.approve', 'payroll.manage']],
    ['payRun', ['payroll.approve', 'payroll.manage']],
    ['getEmployeePay', ['payroll.view', 'payroll.manage']],
    ['setEmployeeSalary', ['payroll.edit', 'payroll.manage']],
    ['setEmployeeBank', ['payroll.edit', 'payroll.manage']],
  ])('%s requires %j', (method, expected) => {
    expect(permissionsOf(method)).toEqual(expected);
  });

  it('never lets payroll.edit approve or pay', () => {
    for (const method of ['approveRun', 'returnRun', 'payRun'] as const) {
      expect(permissionsOf(method)).not.toContain('payroll.edit');
    }
  });

  it('never opens salary data to employee permissions', () => {
    for (const method of ['getEmployeePay', 'setEmployeeSalary', 'setEmployeeBank'] as const) {
      expect(permissionsOf(method).some((key) => key.startsWith('employee.'))).toBe(false);
    }
  });
});
