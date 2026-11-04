import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, QueryTypes } from 'sequelize';
import {
  ApproveAssetDeductionDto,
  AssetActorDto,
  AssetDeductionStatus,
  ConfirmAssetClearanceDto,
  GetAssetDeductionsQueryDto,
  PayrollAdjustmentType,
  TenantErrorCode,
  TenantException,
  WaiveAssetDeductionDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

const fullName = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');
const toNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const currentMonth = () => new Date().toISOString().slice(0, 7);
const REASON_MAX = 300;

/**
 * Leaving the company, as far as assets are concerned: what the employee still
 * has, what they may owe for assets lost or damaged on their watch, and IT /
 * Admin's confirmation that it is all settled.
 *
 * Marking an employee as Resigned goes through `assertCanLeave`, so an
 * employee cannot be cleared out while equipment is still with them. Salary
 * deductions for lost or damaged assets are raised automatically (see
 * AssetService) and sit here until payroll authority approves or waives them;
 * approving writes a one-off deduction that the chosen month's payroll picks up.
 */
@Injectable()
export class AssetClearanceService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  // ==========================================
  // Clearance
  // ==========================================

  private async loadEmployee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({
      where: { id: employeeId, tenantId },
      attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'status', 'exitDate'],
    });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, `Employee '${employeeId}' not found in this organization.`);
    return employee;
  }

  /**
   * Where the employee stands: what they still hold, deductions waiting for a
   * decision, whether IT / Admin has confirmed everything is settled, and what
   * is stopping that. A confirmation only counts if nothing has happened to an
   * asset of theirs since it was given.
   */
  async getClearance(tenantId: string, employeeId: string) {
    const employee = await this.loadEmployee(tenantId, employeeId);
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const Flag = await this.modelProvider.getAssetDeductionFlagModel(tenantId);
    const Clearance = await this.modelProvider.getAssetClearanceModel(tenantId);
    const Event = await this.modelProvider.getAssetEventModel(tenantId);

    const [held, pending, confirmation, activity] = await Promise.all([
      Asset.findAll({
        where: { tenantId, assignedEmployeeId: employeeId },
        include: [{ model: Category, as: 'category', attributes: ['id', 'name'], required: false }],
        order: [['assignedAt', 'ASC']],
      }) as Promise<any[]>,
      Flag.findAll({
        where: { tenantId, employeeId, status: AssetDeductionStatus.PENDING },
        include: [{ model: Asset, as: 'asset', attributes: ['id', 'assetCode', 'name'], required: false }],
        order: [['createdAt', 'ASC']],
      }) as Promise<any[]>,
      Clearance.findOne({ where: { tenantId, employeeId }, order: [['createdAt', 'DESC']] }) as Promise<any>,
      Event.sequelize!.query(
        `SELECT COUNT(*)::int AS "count", MAX("createdAt") AS "last" FROM asset_events WHERE "tenantId" = :tenantId AND "employeeId" = :employeeId`,
        { replacements: { tenantId, employeeId }, type: QueryTypes.SELECT },
      ) as Promise<{ count: number; last: Date | null }[]>,
    ]);

    const hasAssetHistory = Number(activity[0]?.count ?? 0) > 0;
    const lastActivity = activity[0]?.last ? new Date(activity[0].last) : null;
    const confirmed = Boolean(confirmation) && (!lastActivity || new Date(confirmation.createdAt) >= lastActivity);

    const blockers: string[] = [];
    if (held.length) {
      blockers.push(`${held.length} asset${held.length === 1 ? ' is' : 's are'} still with ${fullName(employee)}: ${held.map((asset) => asset.assetCode).join(', ')}.`);
    }
    if (pending.length) {
      blockers.push(`${pending.length} salary deduction${pending.length === 1 ? ' is' : 's are'} waiting for a decision.`);
    }
    if (!blockers.length && hasAssetHistory && !confirmed) {
      blockers.push(confirmation ? 'Something has happened to their assets since IT / Admin confirmed. Confirm again.' : 'IT / Admin has not confirmed the asset clearance yet.');
    }

    return {
      employee: { employeeId: employee.id, name: fullName(employee), employeeCode: employee.employeeCode ?? null, status: employee.status, exitDate: employee.exitDate ?? null },
      assets: held.map((asset) => ({
        id: asset.id,
        assetCode: asset.assetCode,
        name: asset.name,
        category: asset.category ? { id: asset.category.id, name: asset.category.name } : null,
        serialNumber: asset.serialNumber ?? null,
        status: asset.status,
        assignedAt: asset.assignedAt ?? null,
      })),
      pendingDeductions: pending.map((flag) => ({
        id: flag.id,
        reason: flag.reason,
        asset: flag.asset ? { id: flag.asset.id, assetCode: flag.asset.assetCode, name: flag.asset.name } : null,
        suggestedAmount: toNumber(flag.suggestedAmount),
        raisedAt: flag.createdAt,
      })),
      hasAssetHistory,
      confirmation: confirmed ? { confirmedAt: confirmation.createdAt, confirmedBy: confirmation.confirmedBy ?? null, note: confirmation.note ?? null } : null,
      // Everything handed back, nothing owed, and IT / Admin has said so (or there never was an asset).
      cleared: blockers.length === 0,
      // Nothing left to settle: only the confirmation is missing.
      readyToConfirm: !held.length && !pending.length && hasAssetHistory && !confirmed,
      blockers,
    };
  }

  /** IT / Admin: "everything has been handed back in satisfactory condition". Only when that is true. */
  async confirmClearance(actor: AssetActorDto, employeeId: string, dto: ConfirmAssetClearanceDto) {
    const { tenantId } = actor;
    const state = await this.getClearance(tenantId, employeeId);
    if (state.confirmation) return state;
    if (!state.readyToConfirm) {
      if (!state.hasAssetHistory) this.fail(HttpStatus.CONFLICT, 'This employee never had an asset, so there is nothing to confirm.');
      this.fail(HttpStatus.CONFLICT, state.blockers.join(' '));
    }
    const Clearance = await this.modelProvider.getAssetClearanceModel(tenantId);
    await Clearance.create({ tenantId, employeeId, confirmedBy: actor.email ?? null, note: dto.note ?? null } as any);
    return this.getClearance(tenantId, employeeId);
  }

  /**
   * The gate on leaving: refuses with what is outstanding. Called when an
   * employee is marked Resigned, and before one is deleted.
   */
  async assertCanLeave(tenantId: string, employeeId: string) {
    const state = await this.getClearance(tenantId, employeeId);
    if (!state.cleared) {
      this.fail(HttpStatus.CONFLICT, `Asset clearance is not complete. ${state.blockers.join(' ')}`);
    }
  }

  /**
   * Deleting an employee must not strand equipment: the asset would lose its
   * holder but stay "in use". Refuses while any of them still has an asset.
   */
  async assertHoldsNoAssets(tenantId: string, employeeIds: string[]) {
    if (!employeeIds.length) return;
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const held = await Asset.count({ where: { tenantId, assignedEmployeeId: { [Op.in]: employeeIds } } });
    if (held > 0) {
      this.fail(
        HttpStatus.CONFLICT,
        `${employeeIds.length === 1 ? 'This employee still has' : 'Some of these employees still have'} ${held} asset${held === 1 ? '' : 's'}. Return ${held === 1 ? 'it' : 'them'} before deleting.`,
      );
    }
  }

  // ==========================================
  // Deductions
  // ==========================================

  private deductionRow(flag: any) {
    return {
      id: flag.id,
      reason: flag.reason,
      status: flag.status,
      asset: flag.asset ? { id: flag.asset.id, assetCode: flag.asset.assetCode, name: flag.asset.name, purchaseCost: toNumber(flag.asset.purchaseCost) } : null,
      employee: flag.employee ? { employeeId: flag.employee.id, name: fullName(flag.employee), employeeCode: flag.employee.employeeCode ?? null } : null,
      suggestedAmount: toNumber(flag.suggestedAmount),
      amount: toNumber(flag.amount),
      payrollPeriod: flag.payrollPeriod ?? null,
      note: flag.note ?? null,
      decisionNote: flag.decisionNote ?? null,
      raisedBy: flag.raisedBy ?? null,
      raisedAt: flag.createdAt,
      decidedBy: flag.decidedBy ?? null,
      decidedAt: flag.decidedAt ?? null,
    };
  }

  private async deductionIncludes(tenantId: string) {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return [
      { model: Asset, as: 'asset', attributes: ['id', 'assetCode', 'name', 'purchaseCost'], required: false },
      { model: Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode'], required: false },
    ];
  }

  /** The deductions raised for lost and damaged assets, with what is waiting for a decision. */
  async getDeductions(tenantId: string, query: GetAssetDeductionsQueryDto = {}) {
    const Flag = await this.modelProvider.getAssetDeductionFlagModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;

    const where: Record<string, unknown> = { tenantId };
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.employeeId) where.employeeId = query.employeeId;

    const [{ rows, count }, pending] = await Promise.all([
      Flag.findAndCountAll({
        where: where as any,
        include: await this.deductionIncludes(tenantId),
        order: [['createdAt', 'DESC'], ['id', 'ASC']],
        limit,
        offset: (page - 1) * limit,
        distinct: true,
      }),
      Flag.count({ where: { tenantId, status: AssetDeductionStatus.PENDING } }),
    ]);

    return {
      data: (rows as any[]).map((flag) => this.deductionRow(flag)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      summary: { pending },
    };
  }

  private async loadPending(tenantId: string, deductionId: string) {
    const Flag = await this.modelProvider.getAssetDeductionFlagModel(tenantId);
    const flag: any = await Flag.findOne({ where: { id: deductionId, tenantId }, include: await this.deductionIncludes(tenantId) });
    if (!flag) this.fail(HttpStatus.NOT_FOUND, `Deduction '${deductionId}' not found in this organization.`);
    if (flag.status !== AssetDeductionStatus.PENDING) {
      this.fail(HttpStatus.CONFLICT, `This deduction was already ${flag.status === AssetDeductionStatus.APPROVED ? 'approved' : 'waived'}.`);
    }
    return flag;
  }

  /**
   * Approves taking the amount from the employee's salary: writes a one-off
   * deduction for the chosen payroll month, which that month's payroll run
   * picks up when it is calculated. A month that already has a run is too late.
   */
  async approveDeduction(actor: AssetActorDto, deductionId: string, dto: ApproveAssetDeductionDto) {
    const { tenantId } = actor;
    const flag = await this.loadPending(tenantId, deductionId);
    const period = dto.payrollPeriod ?? currentMonth();

    const Run = await this.modelProvider.getPayrollRunModel(tenantId);
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const run = await Run.findOne({
      where: { tenantId, periodStart: { [Op.lte]: periodStart }, periodEnd: { [Op.gte]: periodStart } },
      attributes: ['id'],
    });
    if (run) {
      this.fail(HttpStatus.CONFLICT, `Payroll for ${period} has already been run, so it will not pick this deduction up. Choose a later month.`);
    }

    const Adjustment = await this.modelProvider.getPayrollAdjustmentModel(tenantId);
    const label = `${flag.asset?.assetCode ?? 'Asset'} ${flag.asset?.name ?? ''}`.trim();
    const adjustment: any = await Adjustment.create(
      {
        tenantId,
        payrollRunId: null,
        payrollRecordId: null,
        employeeId: flag.employeeId,
        payrollPeriod: period,
        type: PayrollAdjustmentType.DEDUCTION,
        amount: dto.amount.toFixed(2),
        reason: `Asset ${flag.reason === 'LOST' ? 'lost' : 'damaged'}: ${label}`.slice(0, REASON_MAX),
        category: 'OTHER',
        createdByUserId: actor.userId ?? null,
        createdByEmail: actor.email ?? null,
      } as any,
    );
    await flag.update({
      status: AssetDeductionStatus.APPROVED,
      amount: dto.amount.toFixed(2),
      payrollPeriod: period,
      payrollAdjustmentId: adjustment.id,
      decisionNote: dto.note ?? null,
      decidedBy: actor.email ?? null,
      decidedAt: new Date(),
    });
    return this.deductionRow(flag);
  }

  /** Decides to take nothing. */
  async waiveDeduction(actor: AssetActorDto, deductionId: string, dto: WaiveAssetDeductionDto) {
    const { tenantId } = actor;
    const flag = await this.loadPending(tenantId, deductionId);
    await flag.update({
      status: AssetDeductionStatus.WAIVED,
      decisionNote: dto.note ?? null,
      decidedBy: actor.email ?? null,
      decidedAt: new Date(),
    });
    return this.deductionRow(flag);
  }
}
