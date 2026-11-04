import { Logger } from '@nestjs/common';
import { markSettlementsPaidForRun } from './settlement-payout';
import { table } from './testing/fake-table';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = { id: 'run-1', periodStart: '2026-12-01' };

describe('markSettlementsPaidForRun', () => {
  let models: Record<string, any>;
  const provider = () =>
    ({
      getFinalSettlementModel: async () => models.Settlement,
      getPayrollRecordModel: async () => models.Record,
      getEntityAuditLogModel: async () => models.Audit,
    }) as any;
  const run = () => markSettlementsPaidForRun(provider(), new Logger('test'), TENANT, RUN, { date: '2027-01-02', actorEmail: 'fin@x.com' });

  beforeEach(() => {
    models = {
      Settlement: table([
        { tenantId: TENANT, employeeId: 'anna', status: 'APPROVED', payrollPeriod: '2026-12' },
        { tenantId: TENANT, employeeId: 'omar', status: 'APPROVED', payrollPeriod: '2026-12' },
        { tenantId: TENANT, employeeId: 'sara', status: 'APPROVED', payrollPeriod: '2027-01' },
        { tenantId: TENANT, employeeId: 'hina', status: 'SUBMITTED', payrollPeriod: '2026-12' },
        { tenantId: TENANT, employeeId: 'zain', status: 'PAID', payrollPeriod: '2026-12' },
      ]),
      Record: table([
        { tenantId: TENANT, payrollRunId: 'run-1', employeeId: 'anna' },
        { tenantId: TENANT, payrollRunId: 'run-1', employeeId: 'hina' },
        { tenantId: TENANT, payrollRunId: 'run-1', employeeId: 'sara' },
        { tenantId: TENANT, payrollRunId: 'other-run', employeeId: 'omar' },
      ]),
      Audit: table(),
    };
  });

  it('pays the approved settlements of that month whose employee the payroll carried, and records it', async () => {
    expect(await run()).toBe(1);

    const [anna, omar] = models.Settlement.rows;
    expect(anna).toMatchObject({ status: 'PAID', paidByEmail: 'fin@x.com' });
    expect(new Date(anna.paidAt).toISOString()).toBe('2027-01-02T12:00:00.000Z');
    expect(omar.status).toBe('APPROVED');
    expect(models.Audit.rows.map((row: any) => row.changes?.event?.to)).toEqual(['SETTLEMENT_PAID']);
  });

  it('leaves other months, unapproved settlements and ones already paid alone', async () => {
    await run();
    expect(models.Settlement.rows.map((row: any) => [row.employeeId, row.status])).toEqual([
      ['anna', 'PAID'],
      ['omar', 'APPROVED'],
      ['sara', 'APPROVED'],
      ['hina', 'SUBMITTED'],
      ['zain', 'PAID'],
    ]);
  });

  it('does nothing when no settlement waits for that month', async () => {
    models.Settlement.rows.length = 0;
    expect(await run()).toBe(0);
    expect(models.Record.findAll).not.toHaveBeenCalled();
  });
});
