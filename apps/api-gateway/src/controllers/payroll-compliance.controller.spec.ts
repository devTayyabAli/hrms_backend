import { PERMISSIONS_KEY } from '@app/tenant-context';
import { PayrollComplianceController } from './payroll-compliance.controller';

/**
 * Who may call each compliance route, pinned. Rules and employees' tax
 * details are separate grants; view never writes; nothing here opens to an
 * employee or manager permission. tenant-service checks the same again.
 */
const permissionsOf = (method: keyof PayrollComplianceController): string[] =>
  Reflect.getMetadata(
    PERMISSIONS_KEY,
    PayrollComplianceController.prototype[method],
  ) ?? [];

describe('PayrollComplianceController permissions', () => {
  it.each<[keyof PayrollComplianceController, string[]]>([
    ['listRules', ['payroll.compliance.view', 'payroll.manage']],
    ['listTemplates', ['payroll.compliance.view', 'payroll.manage']],
    ['createRule', ['payroll.compliance.manage', 'payroll.manage']],
    ['updateRule', ['payroll.compliance.manage', 'payroll.manage']],
    ['activateRule', ['payroll.compliance.manage', 'payroll.manage']],
    ['retireRule', ['payroll.compliance.manage', 'payroll.manage']],
    ['listTaxProfiles', ['payroll.tax.view', 'payroll.manage']],
    ['getTaxProfile', ['payroll.tax.view', 'payroll.manage']],
    ['saveTaxProfile', ['payroll.tax.manage', 'payroll.manage']],
    [
      'getReport',
      ['payroll.tax.view', 'payroll.compliance.view', 'payroll.manage'],
    ],
    [
      'exportReport',
      ['payroll.tax.view', 'payroll.compliance.view', 'payroll.manage'],
    ],
    ['listTaxSummaries', ['payroll.tax.view', 'payroll.manage']],
    ['getTaxSummary', ['payroll.tax.view', 'payroll.manage']],
    ['listCertificates', ['payroll.tax.view', 'payroll.manage']],
    ['issueCertificate', ['payroll.tax.manage', 'payroll.manage']],
    ['getCertificatePdf', ['payroll.tax.view', 'payroll.manage']],
  ])('%s requires %j', (method, expected) => {
    expect(permissionsOf(method)).toEqual(expected);
  });

  it('never opens compliance to general payroll, employee or manager permissions', () => {
    const methods = Object.getOwnPropertyNames(
      PayrollComplianceController.prototype,
    ).filter(
      (name) => name !== 'constructor' && name !== 'reportType',
    ) as (keyof PayrollComplianceController)[];
    for (const method of methods) {
      const keys = permissionsOf(method);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).not.toContain('payroll.view');
      expect(keys).not.toContain('payroll.edit');
      expect(
        keys.some(
          (key) =>
            key.startsWith('employee.') || key.startsWith('departments.'),
        ),
      ).toBe(false);
    }
  });
});
