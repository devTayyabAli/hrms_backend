import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { PayrollCompensationController } from './payroll-compensation.controller';
import { MyApprovalsController } from './my-approvals.controller';

describe('Approval routes in payroll', () => {
  const payroll = PayrollCompensationController.prototype as unknown as Record<string, any>;
  const mine = MyApprovalsController.prototype as unknown as Record<string, any>;
  const meta = (proto: Record<string, any>, name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[] | undefined,
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]),
  });

  it('keeps approving a salary change apart from changing compensation', () => {
    const decide = meta(payroll, 'decideSalaryRevision');
    expect(decide.route).toBe('POST salary-revisions/:id/decision');
    expect(decide.permissions).toEqual(['payroll.compensation.approve', 'payroll.manage']);
    // Whoever may change compensation is not, by that, allowed to approve a change.
    expect(decide.permissions).not.toContain('payroll.compensation.manage');
    expect(decide.permissions).not.toContain('payroll.edit');
    expect(decide.module).toMatchObject({ moduleKey: HRMSModuleKey.PAYROLL, action: ModuleAction.EDIT });
  });

  it('lets people who change compensation, and those who approve it, read what is proposed', () => {
    const list = meta(payroll, 'listSalaryRevisions');
    expect(list.route).toBe('GET salary-revisions');
    expect(list.permissions).toEqual(expect.arrayContaining(['payroll.compensation.view', 'payroll.compensation.approve']));
  });

  it('lets only people who change compensation withdraw a proposal', () => {
    expect(meta(payroll, 'cancelSalaryRevision')).toMatchObject({
      route: 'POST salary-revisions/:id/cancel',
      permissions: ['payroll.compensation.manage', 'payroll.edit', 'payroll.manage'],
    });
  });

  it('asks the manager\'s own routes for no permission, only the Payroll module', () => {
    expect(meta(mine, 'getReimbursements')).toMatchObject({ route: 'GET reimbursements', permissions: undefined });
    expect(meta(mine, 'decideReimbursement')).toMatchObject({ route: 'POST reimbursements/:id/decision', permissions: undefined });
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyApprovalsController)).toMatchObject({ moduleKey: HRMSModuleKey.PAYROLL, action: ModuleAction.VIEW });
  });
});
