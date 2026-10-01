import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Op } from 'sequelize';
import { firstValueFrom, timeout } from 'rxjs';
import { MESSAGE_PATTERNS, PayrollProcessStep, SERVICES } from '@app/common';
import { PayslipEmailStatus } from '../models/payslip.model';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { TenantService } from './tenant.service';
import { payrollActor, payrollError, requirePayrollPermission, writePayrollAudit } from './payroll-access';
import {
  buildPayslipDocument,
  formatPayslipNumber,
  isSnapshotComplete,
  periodLabel,
  type PayslipDocument,
  type PayslipOrganization,
} from './payslip-document';
import { renderPayslipPdf } from './payslip-pdf';

const RPC_TIMEOUT_MS = 30_000;
/** A send still "Sending" after this long was interrupted (a restart) and may be retried. */
const STALE_SENDING_MS = 10 * 60 * 1000;
/** Emails in flight at once during a bulk send. */
const BULK_CONCURRENCY = 3;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const nameOf = (employee: { firstName?: string; lastName?: string } | null | undefined) =>
  employee ? [employee.firstName, employee.lastName].filter(Boolean).join(' ') : '';

const moneyText = (value: number, currency: string | null) => {
  const plain = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${plain}` : plain;
};

const dayText = (iso: string | null | undefined) =>
  iso
    ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '—';

export interface PayslipPdf {
  filename: string;
  mimeType: 'application/pdf';
  /** The PDF, base64 — it travels back to the gateway over RPC as JSON. */
  contentBase64: string;
}

/**
 * Payslips: generated when a payroll is completed, read from its locked
 * snapshot, delivered as PDF and email.
 *
 * Two ways in, with different rules:
 * - payroll staff reach any payslip of a completed run through payroll
 *   permissions (`payroll.view` to read, `payroll.approve` to email);
 * - an employee reaches only their own, through the login they are signed in
 *   with — never an employee id from the request.
 * Every view of pay is a completed run's snapshot; nothing is recalculated.
 */
@Injectable()
export class PayslipService {
  private readonly logger = new Logger(PayslipService.name);
  /** Bulk sends still running, by run — tests wait on these. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly tenantService?: TenantService,
    @Optional() @Inject(SERVICES.AUTH_SERVICE) private readonly authClient?: ClientProxy,
  ) {}

  private audit(tenantId: string, runId: string, action: 'CREATE' | 'UPDATE', changes: Record<string, { from: unknown; to: unknown }>) {
    // Recorded against the run, so payslip events sit in the run's activity.
    return writePayrollAudit(this.modelProvider, this.logger, tenantId, 'Payslip', runId, action, changes);
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  private async loadRun(tenantId: string, runId: string) {
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const run = await Run.findOne({ where: { id: runId, tenantId } });
    if (!run) payrollError(`Payroll run '${runId}' not found in this organization.`, HttpStatus.NOT_FOUND);
    return run;
  }

  /** Payslips exist only once a payroll is paid — never for Review, Approval or Payment. */
  private assertCompleted(run: any) {
    if (run.step !== PayrollProcessStep.COMPLETED) {
      payrollError('Payslips are available once this payroll is completed (marked as paid).', HttpStatus.CONFLICT);
    }
  }

  private async employeeInclude(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    return {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'email', 'employmentType', 'avatarUrl'],
      include: [
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
        { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
      ],
    };
  }

  private async organization(tenantId: string): Promise<PayslipOrganization> {
    try {
      const tenant: any = await this.tenantService?.getTenantById(tenantId);
      if (tenant) {
        const address = [tenant.address, tenant.city, tenant.country].map((part) => String(part ?? '').trim()).filter(Boolean).join(', ');
        return {
          name: String(tenant.organizationName || tenant.name || 'Organization').trim(),
          address: address || null,
          phone: tenant.phone || null,
          email: tenant.officialEmail || tenant.email || null,
          website: tenant.website || null,
          logoUrl: tenant.logoUrl || null,
        };
      }
    } catch (error: any) {
      this.logger.warn(`Could not load the organization for a payslip: ${error?.message ?? error}`);
    }
    return { name: 'Organization', address: null, phone: null, email: null, website: null, logoUrl: null };
  }

  /** The organization's logo bytes, from file storage. Missing or unreadable → text header. */
  private async logoBytes(logoUrl: string | null): Promise<Buffer | null> {
    const fileId = logoUrl?.match(/files\/public\/([0-9a-f-]{36})/i)?.[1];
    if (!fileId || !this.authClient) return null;
    try {
      const result: any = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_PUBLIC_FILE, { fileId }).pipe(timeout(8_000)),
      );
      if (!result?.buffer) return null;
      return Buffer.from(result.buffer.data ?? result.buffer);
    } catch (error: any) {
      this.logger.warn(`Payslip logo unavailable: ${error?.message ?? error}`);
      return null;
    }
  }

  // ── Generation ────────────────────────────────────────────────────────────

  /**
   * Numbers a payslip for every line of a completed run that doesn't have
   * one. Safe to call again — it only fills gaps. Numbers come from one
   * organization-wide sequence under a transaction lock, so they are
   * consecutive, unique and never reused. Lines without a full snapshot (run
   * before payroll kept its calculation) get no payslip.
   */
  async generateForRun(tenantId: string, runId: string): Promise<number> {
    const run = await this.loadRun(tenantId, runId);
    this.assertCompleted(run);

    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);
    const records = (await Record.findAll({ where: { tenantId, payrollRunId: runId }, order: [['createdAt', 'ASC']] })) as any[];
    const have = new Set(
      ((await Payslip.findAll({ where: { tenantId, payrollRunId: runId }, attributes: ['payrollRecordId'], raw: true })) as any[]).map(
        (row) => row.payrollRecordId,
      ),
    );
    const missing = records.filter((record) => !have.has(record.id) && isSnapshotComplete(record));
    if (!missing.length) return 0;

    const actor = payrollActor();
    const sequelize: any = Payslip.sequelize;
    await sequelize.transaction(async (transaction: unknown) => {
      if (typeof sequelize.query === 'function') {
        // One numbering at a time per organization database.
        await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext('payslip_sequence'))`, { transaction });
      }
      const last = (await Payslip.max('sequence', { transaction } as any)) as number | null;
      let sequence = Number(last) || 0;
      const now = new Date();
      await Payslip.bulkCreate(
        missing.map((record) => {
          sequence += 1;
          return {
            tenantId,
            payrollRunId: runId,
            payrollRecordId: record.id,
            employeeId: record.employeeId,
            sequence,
            payslipNumber: formatPayslipNumber(String(run.periodStart), sequence),
            generatedAt: now,
            generatedByUserId: actor.userId,
            emailStatus: PayslipEmailStatus.NOT_SENT,
          };
        }),
        { transaction } as any,
      );
    });

    await this.audit(tenantId, runId, 'CREATE', {
      event: { from: null, to: 'PAYSLIPS_GENERATED' },
      count: { from: null, to: missing.length },
    });
    return missing.length;
  }

  /** The payslip for a line — generated on the spot if the run finished without one. */
  private async payslipForRecord(tenantId: string, record: any, run: any) {
    this.assertCompleted(run);
    if (!isSnapshotComplete(record)) {
      payrollError(
        'This payroll was run before payslip details were recorded, so an accurate payslip can’t be produced for it.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);
    let payslip = await Payslip.findOne({ where: { tenantId, payrollRecordId: record.id } });
    if (!payslip) {
      await this.generateForRun(tenantId, run.id);
      payslip = await Payslip.findOne({ where: { tenantId, payrollRecordId: record.id } });
    }
    if (!payslip) payrollError('This payslip isn’t available.', HttpStatus.NOT_FOUND);
    return payslip;
  }

  /** Everything the payslip shows, from the snapshot. */
  private async documentFor(tenantId: string, payslip: any, organization?: PayslipOrganization): Promise<PayslipDocument> {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const [record, run, adjustments] = await Promise.all([
      Record.findOne({ where: { tenantId, id: payslip.payrollRecordId }, include: [await this.employeeInclude(tenantId)] }),
      this.loadRun(tenantId, payslip.payrollRunId),
      Adjustment.findAll({ where: { tenantId, payrollRecordId: payslip.payrollRecordId }, order: [['createdAt', 'ASC']], raw: true }),
    ]);
    if (!record) payrollError('This payslip’s payroll line no longer exists.', HttpStatus.NOT_FOUND);
    this.assertCompleted(run);
    return buildPayslipDocument({
      payslip,
      run: run as any,
      record: record as any,
      adjustments: adjustments as any[],
      employee: (record as any).employee ?? null,
      organization: organization ?? (await this.organization(tenantId)),
    });
  }

  private async pdfFor(tenantId: string, payslip: any, cache?: { organization?: PayslipOrganization; logo?: Buffer | null }): Promise<PayslipPdf> {
    const organization = cache?.organization ?? (await this.organization(tenantId));
    const logo = cache && 'logo' in cache ? cache.logo : await this.logoBytes(organization.logoUrl);
    const document = await this.documentFor(tenantId, payslip, organization);
    let bytes: Buffer;
    try {
      bytes = await renderPayslipPdf(document, { logo });
    } catch (error: any) {
      this.logger.error(`Payslip PDF failed for ${payslip.payslipNumber}: ${error?.message ?? error}`);
      payrollError('The payslip PDF couldn’t be produced. Please try again.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return {
      filename: `Payslip-${payslip.payslipNumber}.pdf`,
      mimeType: 'application/pdf',
      contentBase64: bytes!.toString('base64'),
    };
  }

  // ── Payroll staff ─────────────────────────────────────────────────────────

  private isStale(payslip: any) {
    return (
      payslip.emailStatus === PayslipEmailStatus.SENDING &&
      (!payslip.emailQueuedAt || Date.now() - new Date(payslip.emailQueuedAt).getTime() > STALE_SENDING_MS)
    );
  }

  /** How a payslip's delivery reads — an interrupted send reads as failed, so it can be retried. */
  private emailState(payslip: any) {
    if (this.isStale(payslip)) {
      return { status: PayslipEmailStatus.FAILED, error: 'Sending was interrupted — send again.' };
    }
    return { status: payslip.emailStatus as PayslipEmailStatus, error: payslip.emailError ?? null };
  }

  /** A completed run's payslips with who can be emailed — the Payslips panel and the bulk-send check. */
  async listRunPayslips(tenantId: string, runId: string) {
    requirePayrollPermission('payroll.view', 'view payslips');
    const run = await this.loadRun(tenantId, runId);
    this.assertCompleted(run);
    await this.generateForRun(tenantId, runId);

    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);
    const [records, payslips] = await Promise.all([
      Record.findAll({ where: { tenantId, payrollRunId: runId }, include: [await this.employeeInclude(tenantId)] }),
      Payslip.findAll({ where: { tenantId, payrollRunId: runId } }),
    ]);
    const payslipOf = new Map((payslips as any[]).map((payslip) => [payslip.payrollRecordId, payslip]));

    const rows = (records as any[]).map((record) => {
      const payslip = payslipOf.get(record.id);
      const email = String(record.employee?.email ?? '').trim();
      const state = payslip ? this.emailState(payslip) : null;
      return {
        recordId: record.id,
        payslipId: payslip?.id ?? null,
        payslipNumber: payslip?.payslipNumber ?? null,
        available: Boolean(payslip),
        unavailableReason: payslip ? null : 'This line has no payroll snapshot, so no payslip was produced.',
        employee: {
          id: record.employee?.id ?? record.employeeId,
          name: nameOf(record.employee),
          employeeCode: record.employee?.employeeCode ?? '',
          department: record.employee?.department?.name ?? null,
        },
        email: email || null,
        emailValid: EMAIL_PATTERN.test(email),
        netPay: num(record.netPay),
        emailStatus: state?.status ?? null,
        emailError: state?.error ?? null,
        emailedAt: payslip?.emailedAt ?? null,
        emailedTo: payslip?.emailedTo ?? null,
      };
    });

    const available = rows.filter((row) => row.available);
    return {
      runId,
      periodLabel: periodLabel(String(run.periodStart)),
      currency: run.currency ?? null,
      summary: {
        payslips: available.length,
        unavailable: rows.length - available.length,
        withEmail: available.filter((row) => row.emailValid).length,
        missingEmail: available.filter((row) => !row.emailValid).map((row) => ({ name: row.employee.name, employeeCode: row.employee.employeeCode })),
        sent: available.filter((row) => row.emailStatus === PayslipEmailStatus.SENT).length,
        failed: available.filter((row) => row.emailStatus === PayslipEmailStatus.FAILED).length,
        sending: available.filter((row) => row.emailStatus === PayslipEmailStatus.SENDING).length,
        notSent: available.filter((row) => row.emailStatus === PayslipEmailStatus.NOT_SENT).length,
      },
      rows: rows.sort((a, b) => a.employee.name.localeCompare(b.employee.name)),
    };
  }

  /** Every payslip of completed runs, newest first — the Payroll → Payslips screen. */
  async listPayslips(tenantId: string, query: { search?: string; month?: string; limit?: number } = {}) {
    requirePayrollPermission('payroll.view', 'view payslips');
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const runs = (await Run.findAll({
      where: {
        tenantId,
        step: PayrollProcessStep.COMPLETED,
        ...(query.month ? { periodStart: `${query.month}-01` } : {}),
      },
      order: [['periodStart', 'DESC']],
    })) as any[];
    if (!runs.length) return { rows: [], total: 0, months: [] };
    // Runs finished before payslips existed get theirs now.
    for (const run of runs) await this.generateForRun(tenantId, run.id);

    const runOf = new Map(runs.map((run) => [run.id, run]));
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const payslips = (await Payslip.findAll({
      where: { tenantId, payrollRunId: { [Op.in]: runs.map((run) => run.id) } },
      order: [['sequence', 'DESC']],
    })) as any[];
    const records = (await Record.findAll({
      where: { tenantId, id: { [Op.in]: payslips.map((payslip) => payslip.payrollRecordId) } },
      include: [await this.employeeInclude(tenantId)],
    })) as any[];
    const recordOf = new Map(records.map((record) => [record.id, record]));

    const term = query.search?.trim().toLowerCase();
    const rows = payslips
      .map((payslip) => {
        const record = recordOf.get(payslip.payrollRecordId);
        const run = runOf.get(payslip.payrollRunId);
        const state = this.emailState(payslip);
        return {
          payslipId: payslip.id,
          recordId: payslip.payrollRecordId,
          runId: payslip.payrollRunId,
          payslipNumber: payslip.payslipNumber,
          periodLabel: periodLabel(String(run.periodStart)),
          periodStart: String(run.periodStart).slice(0, 10),
          paymentDate: run.paymentDate ?? null,
          currency: run.currency ?? null,
          employee: {
            id: payslip.employeeId,
            name: nameOf(record?.employee),
            employeeCode: record?.employee?.employeeCode ?? '',
            department: record?.employee?.department?.name ?? null,
          },
          grossPay: num(record?.grossPay),
          deductions: num(record?.deductions),
          netPay: num(record?.netPay),
          emailStatus: state.status,
          emailError: state.error,
          emailedAt: payslip.emailedAt ?? null,
        };
      })
      .filter(
        (row) =>
          !term ||
          [row.employee.name, row.employee.employeeCode, row.payslipNumber].some((value) => value.toLowerCase().includes(term)),
      );

    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    return {
      rows: rows.slice(0, limit),
      total: rows.length,
      months: [...new Set(runs.map((run) => String(run.periodStart).slice(0, 7)))].map((month) => ({
        value: month,
        label: periodLabel(`${month}-01`),
      })),
    };
  }

  private async recordAndRun(tenantId: string, recordId: string) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const record = await Record.findOne({ where: { tenantId, id: recordId } });
    if (!record) payrollError(`Payroll line '${recordId}' not found in this organization.`, HttpStatus.NOT_FOUND);
    return { record, run: await this.loadRun(tenantId, (record as any).payrollRunId) };
  }

  async getRecordPayslip(tenantId: string, recordId: string) {
    requirePayrollPermission('payroll.view', 'view payslips');
    const { record, run } = await this.recordAndRun(tenantId, recordId);
    const payslip = await this.payslipForRecord(tenantId, record, run);
    return { ...(await this.documentFor(tenantId, payslip)), email: this.emailState(payslip) };
  }

  async getRecordPayslipPdf(tenantId: string, recordId: string) {
    requirePayrollPermission('payroll.view', 'download payslips');
    const { record, run } = await this.recordAndRun(tenantId, recordId);
    const payslip = await this.payslipForRecord(tenantId, record, run);
    const pdf = await this.pdfFor(tenantId, payslip);
    await this.audit(tenantId, run.id, 'UPDATE', {
      event: { from: null, to: 'PAYSLIP_DOWNLOADED' },
      payslipNumber: { from: null, to: payslip.payslipNumber },
      employeeId: { from: null, to: payslip.employeeId },
    });
    return pdf;
  }

  /** Emails one payslip to the employee's address on file. */
  async emailRecordPayslip(tenantId: string, recordId: string) {
    requirePayrollPermission('payroll.approve', 'email payslips');
    const { record, run } = await this.recordAndRun(tenantId, recordId);
    const payslip = await this.payslipForRecord(tenantId, record, run);
    return this.deliver(tenantId, payslip, run);
  }

  /**
   * Emails every payslip of a completed run that hasn't gone out (or all of
   * them with `resend`). Returns at once with who will and won't receive
   * one; the sending happens in the background, one small batch at a time,
   * and each payslip's status shows how it went. One bad address never stops
   * the rest.
   */
  async emailRunPayslips(tenantId: string, runId: string, options: { resend?: boolean } = {}) {
    requirePayrollPermission('payroll.approve', 'email payslips');
    const overview = await this.listRunPayslips(tenantId, runId);
    const run = await this.loadRun(tenantId, runId);

    const candidates = overview.rows.filter((row) => row.available);
    const missingEmail = candidates.filter((row) => !row.emailValid);
    const queue = candidates.filter(
      (row) =>
        row.emailValid &&
        (options.resend ||
          row.emailStatus === PayslipEmailStatus.NOT_SENT ||
          row.emailStatus === PayslipEmailStatus.FAILED),
    );
    const alreadySent = candidates.filter((row) => row.emailValid && !queue.includes(row)).length;

    if (queue.length) {
      const Payslip = await this.modelProvider.getPayslipModel(tenantId);
      await Payslip.update(
        { emailStatus: PayslipEmailStatus.SENDING, emailQueuedAt: new Date(), emailError: null },
        { where: { tenantId, id: { [Op.in]: queue.map((row) => row.payslipId) } } } as any,
      );
      await this.audit(tenantId, runId, 'UPDATE', {
        event: { from: null, to: 'PAYSLIPS_BULK_EMAIL_STARTED' },
        queued: { from: null, to: queue.length },
        missingEmail: { from: null, to: missingEmail.length },
      });
      const work = this.deliverAll(tenantId, run, queue.map((row) => row.payslipId as string)).finally(() =>
        this.inflight.delete(runId),
      );
      this.inflight.set(runId, work);
    }

    return {
      queued: queue.length,
      alreadySent,
      missingEmail: missingEmail.map((row) => ({ name: row.employee.name, employeeCode: row.employee.employeeCode })),
      unavailable: overview.summary.unavailable,
    };
  }

  /** Resolves once a bulk send for the run has finished (tests; nothing to wait for otherwise). */
  whenIdle(runId: string) {
    return this.inflight.get(runId) ?? Promise.resolve();
  }

  private async deliverAll(tenantId: string, run: any, payslipIds: string[]) {
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);
    // The header is the same on every payslip — fetch it once.
    const organization = await this.organization(tenantId);
    const cache = { organization, logo: await this.logoBytes(organization.logoUrl) };
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < payslipIds.length; i += BULK_CONCURRENCY) {
      const batch = payslipIds.slice(i, i + BULK_CONCURRENCY);
      await Promise.all(
        batch.map(async (id) => {
          const payslip = await Payslip.findOne({ where: { tenantId, id } });
          if (!payslip) return;
          const result = await this.deliver(tenantId, payslip, run, cache).catch(() => ({ emailStatus: PayslipEmailStatus.FAILED }));
          if (result.emailStatus === PayslipEmailStatus.SENT) sent += 1;
          else failed += 1;
        }),
      );
    }
    await this.audit(tenantId, run.id, 'UPDATE', {
      event: { from: null, to: 'PAYSLIPS_BULK_EMAILED' },
      sent: { from: null, to: sent },
      failed: { from: null, to: failed },
    });
  }

  /**
   * Sends one payslip and records how it went. The body carries only the
   * summary; the breakdown is in the attached PDF.
   */
  private async deliver(
    tenantId: string,
    payslip: any,
    run: any,
    cache?: { organization?: PayslipOrganization; logo?: Buffer | null },
    recipientOverride?: string,
  ) {
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const record: any = await Record.findOne({ where: { tenantId, id: payslip.payrollRecordId }, include: [await this.employeeInclude(tenantId)] });
    const to = String(recipientOverride ?? record?.employee?.email ?? '').trim();
    if (!EMAIL_PATTERN.test(to)) {
      await payslip.update({ emailStatus: PayslipEmailStatus.FAILED, emailError: 'No valid email address on file.', emailQueuedAt: null });
      payrollError(`${nameOf(record?.employee) || 'This employee'} has no valid email address on file.`, HttpStatus.BAD_REQUEST);
    }

    await payslip.update({ emailStatus: PayslipEmailStatus.SENDING, emailQueuedAt: new Date(), emailError: null });
    const actor = payrollActor();
    let result: { success?: boolean; error?: string } = {};
    try {
      if (!this.authClient) throw new Error('Email is not configured for this service.');
      const organization = cache?.organization ?? (await this.organization(tenantId));
      const pdf = await this.pdfFor(tenantId, payslip, { organization, logo: cache && 'logo' in cache ? cache.logo : undefined });
      const label = periodLabel(String(run.periodStart));
      result = await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.MAIL.SEND_TEMPLATE_EMAIL, {
            to,
            subject: `Your Payslip — ${label}`,
            templateName: 'payslip',
            variables: {
              firstName: record?.employee?.firstName || 'there',
              organizationName: organization.name,
              periodLabel: label,
              netPay: moneyText(num(record?.netPay), run.currency ?? null),
              paymentDate: dayText(run.paymentDate),
              payslipNumber: payslip.payslipNumber,
            },
            attachments: [{ filename: pdf.filename, content: pdf.contentBase64, contentType: pdf.mimeType }],
          })
          .pipe(timeout(RPC_TIMEOUT_MS)),
      );
    } catch (error: any) {
      this.logger.error(`Payslip ${payslip.payslipNumber} email failed: ${error?.message ?? error}`);
      result = { success: false, error: error?.message?.includes('Timeout') ? 'The mail service timed out.' : 'The email could not be sent.' };
    }

    const ok = Boolean(result?.success);
    await payslip.update(
      ok
        ? {
            emailStatus: PayslipEmailStatus.SENT,
            emailedTo: to,
            emailedAt: new Date(),
            emailedByUserId: actor.userId,
            emailedByEmail: actor.email,
            emailError: null,
            emailQueuedAt: null,
          }
        : {
            emailStatus: PayslipEmailStatus.FAILED,
            emailError: String(result?.error ?? 'The email could not be sent.').slice(0, 300),
            emailQueuedAt: null,
          },
    );
    await this.audit(tenantId, run.id, 'UPDATE', {
      event: { from: null, to: ok ? 'PAYSLIP_EMAILED' : 'PAYSLIP_EMAIL_FAILED' },
      payslipNumber: { from: null, to: payslip.payslipNumber },
      employeeId: { from: null, to: payslip.employeeId },
      to: { from: null, to },
    });
    return {
      payslipId: payslip.id,
      payslipNumber: payslip.payslipNumber,
      emailStatus: payslip.emailStatus as PayslipEmailStatus,
      emailError: payslip.emailError ?? null,
      emailedAt: payslip.emailedAt ?? null,
      emailedTo: payslip.emailedTo ?? null,
    };
  }

  // ── The employee's own ────────────────────────────────────────────────────

  /** The employee record behind this login — user id first, then the same email. */
  private async me(tenantId: string, userId: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee = await Employee.findOne({ where: { tenantId, userId } });
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } as any });
    }
    if (!employee) payrollError('No employee profile is linked to this login.', HttpStatus.NOT_FOUND);
    return employee;
  }

  /**
   * One of the caller's own payslips. Someone else's reads exactly like one
   * that doesn't exist — the answer never confirms another person's payslip.
   */
  private async myPayslip(tenantId: string, employeeId: string, payslipId: string) {
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);
    const payslip = await Payslip.findOne({ where: { tenantId, id: payslipId, employeeId } });
    if (!payslip) payrollError('Payslip not found.', HttpStatus.NOT_FOUND);
    return payslip;
  }

  async listMyPayslips(tenantId: string, userId: string, email?: string) {
    const me: any = await this.me(tenantId, userId, email);
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const Record = await this.modelProvider.getPayrollRecordModel(tenantId);
    const Payslip = await this.modelProvider.getPayslipModel(tenantId);

    // Completed runs the employee is in that finished before numbering existed.
    const myRecords = (await Record.findAll({ where: { tenantId, employeeId: me.id }, attributes: ['id', 'payrollRunId'], raw: true })) as any[];
    const runs = myRecords.length
      ? ((await Run.findAll({
          where: { tenantId, id: { [Op.in]: [...new Set(myRecords.map((row) => row.payrollRunId))] }, step: PayrollProcessStep.COMPLETED },
        })) as any[])
      : [];
    const runOf = new Map(runs.map((run) => [run.id, run]));
    const mine = (await Payslip.findAll({ where: { tenantId, employeeId: me.id } })) as any[];
    const numbered = new Set(mine.map((payslip) => payslip.payrollRunId));
    for (const run of runs) if (!numbered.has(run.id)) await this.generateForRun(tenantId, run.id);

    const payslips = ((await Payslip.findAll({ where: { tenantId, employeeId: me.id } })) as any[]).filter((payslip) =>
      runOf.has(payslip.payrollRunId),
    );
    const records = payslips.length
      ? ((await Record.findAll({ where: { tenantId, id: { [Op.in]: payslips.map((payslip) => payslip.payrollRecordId) } } })) as any[])
      : [];
    const recordOf = new Map(records.map((record) => [record.id, record]));

    return payslips
      .map((payslip) => {
        const run = runOf.get(payslip.payrollRunId);
        const record = recordOf.get(payslip.payrollRecordId);
        return {
          payslipId: payslip.id,
          payslipNumber: payslip.payslipNumber,
          periodLabel: periodLabel(String(run.periodStart)),
          periodStart: String(run.periodStart).slice(0, 10),
          periodEnd: String(run.periodEnd).slice(0, 10),
          currency: run.currency ?? null,
          grossPay: num(record?.grossPay),
          deductions: num(record?.deductions),
          netPay: num(record?.netPay),
          paymentDate: run.paymentDate ?? null,
          status: 'PAID' as const,
        };
      })
      .sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  }

  async getMyPayslip(tenantId: string, userId: string, email: string | undefined, payslipId: string) {
    const me: any = await this.me(tenantId, userId, email);
    return this.documentFor(tenantId, await this.myPayslip(tenantId, me.id, payslipId));
  }

  async getMyPayslipPdf(tenantId: string, userId: string, email: string | undefined, payslipId: string) {
    const me: any = await this.me(tenantId, userId, email);
    const payslip = await this.myPayslip(tenantId, me.id, payslipId);
    const pdf = await this.pdfFor(tenantId, payslip);
    await this.audit(tenantId, payslip.payrollRunId, 'UPDATE', {
      event: { from: null, to: 'PAYSLIP_DOWNLOADED' },
      payslipNumber: { from: null, to: payslip.payslipNumber },
      employeeId: { from: null, to: payslip.employeeId },
      selfService: { from: null, to: true },
    });
    return pdf;
  }

  /** Sends the caller's own payslip to the email address HR has on file for them — nowhere else. */
  async emailMyPayslip(tenantId: string, userId: string, email: string | undefined, payslipId: string) {
    const me: any = await this.me(tenantId, userId, email);
    const payslip = await this.myPayslip(tenantId, me.id, payslipId);
    const run = await this.loadRun(tenantId, payslip.payrollRunId);
    const result = await this.deliver(tenantId, payslip, run, undefined, me.email);
    // Delivery detail stays with payroll staff; the employee just learns whether it went.
    return { emailStatus: result.emailStatus, emailedTo: result.emailStatus === PayslipEmailStatus.SENT ? result.emailedTo : null };
  }
}
