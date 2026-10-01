import { HttpStatus } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { MESSAGE_PATTERNS, PayrollProcessStep } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PayslipService } from './payslip.service';
import { table } from './testing/fake-table';

/**
 * Payslips end to end through the service: only completed payrolls have
 * them, every figure is the locked snapshot, an employee only ever reaches
 * their own, salary stays behind payroll permissions, numbers never repeat,
 * and email delivery records what happened without stopping on one failure.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';

const PAYROLL_VIEWER = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['payroll.view', 'payroll.edit'] };
const APPROVER = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.view', 'payroll.approve'] };
const MANAGER = { roles: ['Department Manager'], isSuperAdmin: false, userId: 'u-mgr', email: 'mgr@x.com', permissions: ['employee.view', 'attendance.view'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

/** A line with a full Phase 1 snapshot. */
const snapshot = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  basicSalary: '100000',
  allowances: '0',
  workingDays: '26',
  eligibleDays: '26',
  paidDays: '26',
  absenceDays: '0',
  unpaidLeaveDays: '0',
  paidLeaveDays: '0',
  prorationFactor: '1',
  earnedBasic: '100000',
  earnedAllowances: '0',
  overtimePay: '0',
  overtimeMinutes: 0,
  absenceDeduction: '0',
  unpaidLeaveDeduction: '0',
  recurringDeductions: '0',
  grossPay: '100000',
  deductions: '0',
  netPay: '100000',
  bankAccountNumber: '0123-4567890-01',
  ...over,
});

describe('PayslipService', () => {
  let models: Record<string, any>;
  let mail: jest.Mock;
  let service: PayslipService;
  let ids: { run: string; ayesha: string; bilal: string; ayeshaLine: string; bilalLine: string };

  const build = (options: { step?: PayrollProcessStep; bilalEmail?: string | null } = {}) => {
    const employees = table([
      { tenantId: TENANT, firstName: 'Ayesha', lastName: 'Khan', employeeCode: 'EMP001', email: 'ayesha@x.com', userId: 'u-ayesha', basicSalary: '100000' },
      { tenantId: TENANT, firstName: 'Bilal', lastName: 'Ahmed', employeeCode: 'EMP002', email: options.bilalEmail === undefined ? 'bilal@x.com' : options.bilalEmail, userId: 'u-bilal', basicSalary: '80000' },
    ]);
    const [ayesha, bilal] = employees.rows;
    const runs = table([
      {
        tenantId: TENANT,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        step: options.step ?? PayrollProcessStep.COMPLETED,
        currency: 'PKR',
        paymentDate: '2026-10-01',
        paymentReference: 'HBL 12',
      },
    ]);
    const run = runs.rows[0];
    const records = table([
      snapshot({ payrollRunId: run.id, employeeId: ayesha.id, employee: ayesha }),
      snapshot({ payrollRunId: run.id, employeeId: bilal.id, employee: bilal, basicSalary: '80000', earnedBasic: '80000', grossPay: '80000', netPay: '80000' }),
    ]);
    models = {
      Employee: employees,
      Run: runs,
      Record: records,
      Payslip: table(),
      Adjustment: table(),
      Audit: table(),
    };
    ids = { run: run.id, ayesha: ayesha.id, bilal: bilal.id, ayeshaLine: records.rows[0].id, bilalLine: records.rows[1].id };

    mail = jest.fn().mockReturnValue(of({ success: true, messageId: 'm1' }));
    const authClient = {
      send: jest.fn((pattern: string, payload: any) => {
        if (pattern === MESSAGE_PATTERNS.MAIL.SEND_TEMPLATE_EMAIL) return mail(payload);
        return of(null); // no logo
      }),
    };
    const tenantService = {
      getTenantById: jest.fn(async () => ({ organizationName: 'Silicon Nexus', address: 'Lahore', logoUrl: null })),
    };
    const provider = {
      getEmployeeModel: async () => models.Employee,
      getPayrollRunModel: async () => models.Run,
      getPayrollRecordModel: async () => models.Record,
      getPayslipModel: async () => models.Payslip,
      getPayrollAdjustmentModel: async () => models.Adjustment,
      getEntityAuditLogModel: async () => models.Audit,
      getDepartmentModel: async () => ({}),
      getDesignationModel: async () => ({}),
    };
    service = new PayslipService(provider as any, tenantService as any, authClient as any);
  };

  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to);
  const payslipOf = (recordId: string) => models.Payslip.rows.find((p: any) => p.payrollRecordId === recordId);

  beforeEach(() => build());

  describe('availability', () => {
    it('exists only once the payroll is completed', async () => {
      for (const step of [PayrollProcessStep.REVIEW, PayrollProcessStep.APPROVAL, PayrollProcessStep.PAYMENT]) {
        build({ step });
        await expect(service.generateForRun(TENANT, ids.run)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
        await expect(service.getRecordPayslip(TENANT, ids.ayeshaLine)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
        expect(models.Payslip.rows).toHaveLength(0);
      }
    });

    it('is refused for a line without a payroll snapshot, rather than guessed', async () => {
      Object.assign(models.Record.rows[0], { workingDays: '0', eligibleDays: '0' });
      expect(await service.generateForRun(TENANT, ids.run)).toBe(1);
      await expect(service.getRecordPayslip(TENANT, ids.ayeshaLine)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('numbering', () => {
    it('gives every line a unique, sequential number, and never renumbers', async () => {
      expect(await service.generateForRun(TENANT, ids.run)).toBe(2);
      expect(models.Payslip.rows.map((p: any) => p.payslipNumber).sort()).toEqual(['PS-2026-09-000001', 'PS-2026-09-000002']);
      expect(await service.generateForRun(TENANT, ids.run)).toBe(0);
      expect(events()).toContain('PAYSLIPS_GENERATED');
    });

    it('continues the sequence across runs', async () => {
      await service.generateForRun(TENANT, ids.run);
      const october = await models.Run.create({ tenantId: TENANT, periodStart: '2026-10-01', periodEnd: '2026-10-31', step: PayrollProcessStep.COMPLETED });
      await models.Record.create(snapshot({ payrollRunId: october.id, employeeId: ids.ayesha }));
      await service.generateForRun(TENANT, october.id);
      const numbers = models.Payslip.rows.map((p: any) => p.payslipNumber);
      expect(numbers).toContain('PS-2026-10-000003');
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  describe('the snapshot', () => {
    it('shows the payroll’s figures even after the salary changes', async () => {
      // October raise, after September was paid.
      Object.assign(models.Employee.rows[0], { basicSalary: '120000' });
      const payslip = await as(PAYROLL_VIEWER, () => service.getRecordPayslip(TENANT, ids.ayeshaLine));
      expect(payslip.earnings[0]).toEqual({ label: 'Basic Salary', amount: 100_000 });
      expect(payslip.totals.net).toBe(100_000);
      expect(payslip.bank?.account).toBe('**** **** 9001');
    });

    it('produces a PDF and records the download', async () => {
      const pdf = await as(PAYROLL_VIEWER, () => service.getRecordPayslipPdf(TENANT, ids.ayeshaLine));
      expect(pdf.mimeType).toBe('application/pdf');
      expect(Buffer.from(pdf.contentBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.filename).toMatch(/^Payslip-PS-2026-09-\d{6}\.pdf$/);
      const entry = models.Audit.rows.find((row: any) => row.changes?.event?.to === 'PAYSLIP_DOWNLOADED');
      // The audit names the payslip and person, never an amount.
      expect(JSON.stringify(entry.changes)).not.toMatch(/100000|netPay/);
    });
  });

  describe('employee self-service', () => {
    const ayesha = { tenantId: TENANT, userId: 'u-ayesha', email: 'ayesha@x.com' };

    it('lists only the caller’s own payslips', async () => {
      const mine = await service.listMyPayslips(TENANT, ayesha.userId, ayesha.email);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toEqual(expect.objectContaining({ periodLabel: 'September 2026', netPay: 100_000, status: 'PAID' }));
    });

    it('opens and downloads the caller’s own payslip', async () => {
      const [mine] = await service.listMyPayslips(TENANT, ayesha.userId, ayesha.email);
      expect((await service.getMyPayslip(TENANT, ayesha.userId, ayesha.email, mine.payslipId)).employee.name).toBe('Ayesha Khan');
      expect((await service.getMyPayslipPdf(TENANT, ayesha.userId, ayesha.email, mine.payslipId)).mimeType).toBe('application/pdf');
    });

    it('treats another employee’s payslip as not found', async () => {
      await service.generateForRun(TENANT, ids.run);
      const bilals = payslipOf(ids.bilalLine).id;
      await expect(service.getMyPayslip(TENANT, ayesha.userId, ayesha.email, bilals)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(service.getMyPayslipPdf(TENANT, ayesha.userId, ayesha.email, bilals)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(service.emailMyPayslip(TENANT, ayesha.userId, ayesha.email, bilals)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('emails the caller’s payslip only to their own address on file', async () => {
      const [mine] = await service.listMyPayslips(TENANT, ayesha.userId, ayesha.email);
      const result = await service.emailMyPayslip(TENANT, ayesha.userId, ayesha.email, mine.payslipId);
      expect(result).toEqual({ emailStatus: 'SENT', emailedTo: 'ayesha@x.com' });
      expect(mail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ayesha@x.com' }));
    });

    it('refuses a login with no employee record', async () => {
      await expect(service.listMyPayslips(TENANT, 'u-nobody', 'nobody@x.com')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('permissions', () => {
    it('keeps payslips from someone with only employee access (a department manager)', async () => {
      await expect(as(MANAGER, () => service.getRecordPayslip(TENANT, ids.ayeshaLine))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(as(MANAGER, () => service.getRecordPayslipPdf(TENANT, ids.ayeshaLine))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(as(MANAGER, () => service.listPayslips(TENANT))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(as(MANAGER, () => service.listRunPayslips(TENANT, ids.run))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('lets payroll viewers read but only approvers send', async () => {
      await expect(as(PAYROLL_VIEWER, () => service.listRunPayslips(TENANT, ids.run))).resolves.toBeTruthy();
      await expect(as(PAYROLL_VIEWER, () => service.emailRecordPayslip(TENANT, ids.ayeshaLine))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(as(PAYROLL_VIEWER, () => service.emailRunPayslips(TENANT, ids.run))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(as(APPROVER, () => service.emailRecordPayslip(TENANT, ids.ayeshaLine))).resolves.toMatchObject({ emailStatus: 'SENT' });
    });
  });

  describe('tenant isolation', () => {
    it('never reaches another organization’s payroll', async () => {
      await expect(service.getRecordPayslip(OTHER_TENANT, ids.ayeshaLine)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(service.listRunPayslips(OTHER_TENANT, ids.run)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('email', () => {
    it('sends the PDF with a short summary in the body, and records it', async () => {
      const result = await as(APPROVER, () => service.emailRecordPayslip(TENANT, ids.ayeshaLine));
      expect(result.emailStatus).toBe('SENT');
      const sent = mail.mock.calls[0][0];
      expect(sent.subject).toBe('Your Payslip — September 2026');
      expect(sent.templateName).toBe('payslip');
      expect(sent.variables).toEqual(expect.objectContaining({ netPay: 'PKR 100,000.00', paymentDate: '01 Oct 2026' }));
      // No breakdown in the body — only the net figure and dates.
      expect(Object.keys(sent.variables)).not.toEqual(expect.arrayContaining(['basicSalary', 'deductions']));
      expect(sent.attachments[0]).toEqual(expect.objectContaining({ contentType: 'application/pdf', filename: expect.stringMatching(/\.pdf$/) }));
      expect(payslipOf(ids.ayeshaLine)).toEqual(expect.objectContaining({ emailStatus: 'SENT', emailedTo: 'ayesha@x.com', emailedByEmail: 'fin@x.com' }));
      expect(events()).toContain('PAYSLIP_EMAILED');
    });

    it('refuses to email someone with no address on file', async () => {
      build({ bilalEmail: null });
      await expect(service.emailRecordPayslip(TENANT, ids.bilalLine)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(mail).not.toHaveBeenCalled();
    });

    it('records a failed delivery with a safe reason', async () => {
      mail.mockReturnValue(of({ success: false, error: 'Mail server rejected the message (550).' }));
      const result = await service.emailRecordPayslip(TENANT, ids.ayeshaLine);
      expect(result).toEqual(expect.objectContaining({ emailStatus: 'FAILED', emailError: 'Mail server rejected the message (550).' }));
      expect(events()).toContain('PAYSLIP_EMAIL_FAILED');
    });

    it('treats a mail-service outage as a failed delivery, not a crash', async () => {
      mail.mockReturnValue(throwError(() => new Error('connect ECONNREFUSED')));
      expect((await service.emailRecordPayslip(TENANT, ids.ayeshaLine)).emailStatus).toBe('FAILED');
    });

    describe('in bulk', () => {
      it('queues everyone with an address, names who has none, and returns at once', async () => {
        build({ bilalEmail: '' });
        const summary = await as(APPROVER, () => service.emailRunPayslips(TENANT, ids.run));
        expect(summary.queued).toBe(1);
        expect(summary.missingEmail).toEqual([{ name: 'Bilal Ahmed', employeeCode: 'EMP002' }]);
        await service.whenIdle(ids.run);
        expect(payslipOf(ids.ayeshaLine).emailStatus).toBe('SENT');
        expect(events()).toEqual(expect.arrayContaining(['PAYSLIPS_BULK_EMAIL_STARTED', 'PAYSLIPS_BULK_EMAILED']));
      });

      it('carries on past one failure', async () => {
        mail.mockImplementation((payload: any) =>
          payload.to === 'ayesha@x.com' ? of({ success: false, error: 'Mailbox full' }) : of({ success: true }),
        );
        await service.emailRunPayslips(TENANT, ids.run);
        await service.whenIdle(ids.run);
        expect(payslipOf(ids.ayeshaLine).emailStatus).toBe('FAILED');
        expect(payslipOf(ids.bilalLine).emailStatus).toBe('SENT');
      });

      it('doesn’t resend what already went out, unless asked', async () => {
        await service.emailRunPayslips(TENANT, ids.run);
        await service.whenIdle(ids.run);
        mail.mockClear();
        expect((await service.emailRunPayslips(TENANT, ids.run)).queued).toBe(0);
        expect(mail).not.toHaveBeenCalled();
        expect((await service.emailRunPayslips(TENANT, ids.run, { resend: true })).queued).toBe(2);
        await service.whenIdle(ids.run);
      });

      it('retries a send that was interrupted', async () => {
        await service.generateForRun(TENANT, ids.run);
        Object.assign(payslipOf(ids.ayeshaLine), { emailStatus: 'SENDING', emailQueuedAt: new Date(Date.now() - 60 * 60 * 1000) });
        const overview = await service.listRunPayslips(TENANT, ids.run);
        expect(overview.rows.find((row) => row.recordId === ids.ayeshaLine)?.emailStatus).toBe('FAILED');
        expect((await service.emailRunPayslips(TENANT, ids.run)).queued).toBe(2);
        await service.whenIdle(ids.run);
      });
    });
  });
});
