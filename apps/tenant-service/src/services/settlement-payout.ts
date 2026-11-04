import { Logger } from '@nestjs/common';
import { SettlementStatus } from '@app/common';
import type { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';

/**
 * A payroll has been paid: the final settlements it carried are paid too.
 *
 * A settlement is posted to its payroll month as earnings and deductions, so
 * once that month's payroll is marked paid there is nothing left for anyone
 * to do by hand. A settlement counts when it is approved, is for that month,
 * and its employee has a line in this payroll: that line is what carried it.
 * One that was not carried (the employee had no line in that run) is left
 * approved, for payroll to deal with.
 *
 * Kept apart from FinalSettlementService, which depends on the payroll
 * service: this is called by the payroll service, so it must not depend back.
 */
export const markSettlementsPaidForRun = async (
  modelProvider: TenantModelProviderService,
  logger: Logger,
  tenantId: string,
  run: { id: string; periodStart: string },
  payment: { date: string; actorEmail: string | null },
): Promise<number> => {
  const Settlement = await modelProvider.getFinalSettlementModel(tenantId);
  const period = String(run.periodStart).slice(0, 7);
  const approved = (await Settlement.findAll({ where: { tenantId, status: SettlementStatus.APPROVED, payrollPeriod: period } as any })) as any[];
  if (!approved.length) return 0;

  const Record = await modelProvider.getPayrollRecordModel(tenantId);
  const carried = (await Record.findAll({ where: { tenantId, payrollRunId: run.id }, attributes: ['employeeId'], raw: true })) as unknown as { employeeId: string }[];
  const inRun = new Set(carried.map((row) => row.employeeId));

  let paid = 0;
  for (const settlement of approved) {
    if (!inRun.has(settlement.employeeId)) continue;
    await settlement.update({ status: SettlementStatus.PAID, paidAt: new Date(`${payment.date}T12:00:00Z`), paidByEmail: payment.actorEmail });
    await writeAudit(modelProvider, logger, tenantId, 'final_settlements', settlement.id, 'UPDATE', {
      event: { from: null, to: 'SETTLEMENT_PAID' },
      status: { from: 'APPROVED', to: 'PAID' },
      payrollRunId: { from: null, to: run.id },
    });
    paid++;
  }
  return paid;
};
