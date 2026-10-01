import { PERMISSIONS_KEY } from '@app/tenant-context';
import { PayrollCompensationController } from './payroll-compensation.controller';

/**
 * Who may call each compensation route, pinned. Loans are their own grant;
 * nothing here opens to an employee, department or leave grant — a manager's
 * or team lead's permissions never reach compensation.
 */
const permissionsOf = (method: keyof PayrollCompensationController): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, PayrollCompensationController.prototype[method]) ?? [];

const COMPONENTS_VIEW = ['payroll.components.view', 'payroll.view', 'payroll.manage'];
const COMPONENTS_MANAGE = ['payroll.components.manage', 'payroll.manage'];
const COMPENSATION_VIEW = ['payroll.compensation.view', 'payroll.view', 'payroll.manage'];
const COMPENSATION_MANAGE = ['payroll.compensation.manage', 'payroll.edit', 'payroll.manage'];
const LOANS_VIEW = ['payroll.loans.view', 'payroll.manage'];
const LOANS_MANAGE = ['payroll.loans.manage', 'payroll.manage'];
const ADJUSTMENTS_VIEW = ['payroll.adjustments.view', 'payroll.view', 'payroll.manage'];
const ADJUSTMENTS_MANAGE = ['payroll.adjustments.manage', 'payroll.edit', 'payroll.manage'];

describe('PayrollCompensationController permissions', () => {
  it.each<[keyof PayrollCompensationController, string[]]>([
    ['listComponents', COMPONENTS_VIEW],
    ['componentOptions', COMPONENTS_VIEW],
    ['createComponent', COMPONENTS_MANAGE],
    ['updateComponent', COMPONENTS_MANAGE],
    ['setComponentStatus', COMPONENTS_MANAGE],
    ['listStructures', COMPENSATION_VIEW],
    ['createStructure', COMPENSATION_MANAGE],
    ['updateStructure', COMPENSATION_MANAGE],
    ['listEmployees', COMPENSATION_VIEW],
    ['getCompensation', COMPENSATION_VIEW],
    ['previewCompensation', COMPENSATION_VIEW],
    ['saveCompensation', COMPENSATION_MANAGE],
    ['listRecurring', COMPENSATION_VIEW],
    ['createRecurring', COMPENSATION_MANAGE],
    ['updateRecurring', COMPENSATION_MANAGE],
    ['importCompensation', COMPENSATION_MANAGE],
    ['listLoans', LOANS_VIEW],
    ['createLoan', LOANS_MANAGE],
    ['updateLoan', LOANS_MANAGE],
    ['listReimbursements', ADJUSTMENTS_VIEW],
    ['createReimbursement', ADJUSTMENTS_MANAGE],
    ['decideReimbursement', ADJUSTMENTS_MANAGE],
    ['listAdjustments', ADJUSTMENTS_VIEW],
    ['createAdjustment', ADJUSTMENTS_MANAGE],
    ['removeAdjustment', ADJUSTMENTS_MANAGE],
  ])('%s requires %j', (method, expected) => {
    expect(permissionsOf(method)).toEqual(expected);
  });

  it('never opens compensation to employee, department or team grants', () => {
    const methods = Object.getOwnPropertyNames(PayrollCompensationController.prototype).filter(
      (name) => name !== 'constructor' && name !== 'send',
    ) as (keyof PayrollCompensationController)[];
    for (const method of methods) {
      const keys = permissionsOf(method);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key.startsWith('payroll.'))).toBe(true);
    }
  });

  it('keeps loans away from general payroll viewers', () => {
    expect(permissionsOf('listLoans')).not.toContain('payroll.view');
  });
});
