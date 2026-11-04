import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  ApprovalRequestType,
  ApprovalStageKind,
  EmployeeStatus,
  MAX_APPROVAL_STAGES,
  MAX_MANAGER_LEVEL,
  TenantErrorCode,
  TenantException,
  UpdateApprovalPolicyDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { DEFAULT_LEAVE_POLICY, PolicyStage, permissionLabel } from './approval-engine';
import { fullName } from './workspace-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

/**
 * What a type is approved by when the organization has saved nothing. An empty
 * list means no approval route: the work is done directly, as before.
 */
const DEFAULTS: Record<ApprovalRequestType, PolicyStage[]> = {
  [ApprovalRequestType.LEAVE]: DEFAULT_LEAVE_POLICY,
  [ApprovalRequestType.REIMBURSEMENT]: [],
  [ApprovalRequestType.SALARY_REVISION]: [],
  // A final settlement is always approved: by anyone holding payroll.approve until the organization chooses otherwise.
  [ApprovalRequestType.FINAL_SETTLEMENT]: [{ kind: ApprovalStageKind.PERMISSION, permission: 'payroll.approve' }],
  // Until a route is saved, employee requests follow the older approval-flow setting.
  [ApprovalRequestType.EMPLOYEE_REQUEST]: [],
};

/**
 * An organization's approval routes. Only the stages are stored; who they
 * resolve to is worked out for each request, so a change of manager or
 * department head never needs the policy touched.
 */
@Injectable()
export class ApprovalPolicyService {
  private readonly logger = new Logger(ApprovalPolicyService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  /** The words an admin reads for one stage. */
  private label(stage: PolicyStage, employeeName?: string | null): string {
    switch (stage.kind) {
      case ApprovalStageKind.REPORTING_MANAGER:
        return (stage.level ?? 1) === 1 ? 'Reporting manager' : `Reporting manager, ${stage.level} levels up`;
      case ApprovalStageKind.DEPARTMENT_HEAD:
        return 'Head of the department';
      case ApprovalStageKind.ADDITIONAL_MANAGER:
        return 'Additional (dotted-line) manager, when they have one';
      case ApprovalStageKind.EMPLOYEE:
        return employeeName ? `${employeeName} (named approver)` : 'A named approver';
      case ApprovalStageKind.PERMISSION:
        return `Anyone with ${stage.permission}`;
      default:
        return 'HR';
    }
  }

  private async stageViews(tenantId: string, stages: PolicyStage[]) {
    const ids = stages.filter((stage) => stage.kind === ApprovalStageKind.EMPLOYEE && stage.employeeId).map((stage) => stage.employeeId as string);
    const names = new Map<string, string>();
    if (ids.length) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName'] })) as any[];
      for (const row of rows) names.set(row.id, fullName(row));
    }
    return stages.map((stage) => ({
      kind: stage.kind,
      level: stage.kind === ApprovalStageKind.REPORTING_MANAGER ? (stage.level ?? 1) : null,
      employeeId: stage.employeeId ?? null,
      employeeName: stage.employeeId ? (names.get(stage.employeeId) ?? null) : null,
      permission: stage.permission ?? null,
      label: this.label(stage, stage.employeeId ? names.get(stage.employeeId) : null),
    }));
  }

  private async rowFor(tenantId: string, requestType: ApprovalRequestType) {
    const Policy = await this.modelProvider.getApprovalPolicyModel(tenantId);
    return (await Policy.findOne({ where: { tenantId, requestType } })) as any;
  }

  private async view(tenantId: string, requestType: ApprovalRequestType) {
    const row = await this.rowFor(tenantId, requestType);
    const saved = Array.isArray(row?.stages) && row.stages.length;
    const stages = saved ? (row.stages as PolicyStage[]) : DEFAULTS[requestType];
    return {
      requestType,
      editable: true,
      isDefault: !saved,
      // Leave always has a route. The others have one only once it is saved.
      approvalRequired: stages.length > 0,
      stages: await this.stageViews(tenantId, stages),
      updatedAt: (saved ? row.updatedAt : null) as Date | null,
      updatedBy: (saved ? (row.updatedByEmail ?? null) : null) as string | null,
    };
  }

  /**
   * Employee requests: the saved route, or until one is saved the approval-flow
   * setting they still follow, shown as stages.
   */
  private async employeeRequestView(tenantId: string) {
    const saved = await this.view(tenantId, ApprovalRequestType.EMPLOYEE_REQUEST);
    if (!saved.isDefault) return { ...saved, managedBy: 'policy' };
    const Setting = await this.modelProvider.getApprovalSettingModel(tenantId);
    let flow: 'SINGLE' | 'MANAGER_THEN_HR' = 'SINGLE';
    try {
      const row: any = await Setting.findOne({ where: { tenantId }, attributes: ['flow'] });
      flow = row?.flow === 'MANAGER_THEN_HR' ? 'MANAGER_THEN_HR' : 'SINGLE';
    } catch {
      /* no setting table yet: one step */
    }
    const employeeRequestStages: PolicyStage[] = flow === 'MANAGER_THEN_HR' ? [{ kind: ApprovalStageKind.REPORTING_MANAGER, level: 1 }, { kind: ApprovalStageKind.HR }] : [{ kind: ApprovalStageKind.HR }];
    return {
      ...saved,
      managedBy: 'approval-flow',
      flow,
      approvalRequired: true,
      stages: await this.stageViews(tenantId, employeeRequestStages),
    };
  }

  /** Every request type and how it is approved. */
  async list(tenantId: string) {
    return {
      data: [
        await this.view(tenantId, ApprovalRequestType.LEAVE),
        await this.view(tenantId, ApprovalRequestType.REIMBURSEMENT),
        await this.view(tenantId, ApprovalRequestType.SALARY_REVISION),
        await this.view(tenantId, ApprovalRequestType.FINAL_SETTLEMENT),
        await this.employeeRequestView(tenantId),
      ],
      limits: { maxStages: MAX_APPROVAL_STAGES, maxManagerLevel: MAX_MANAGER_LEVEL },
    };
  }

  /**
   * What each kind of request may use. A pay change is approved by people who
   * hold a permission, so the authority stays separate from who proposes it.
   * A reimbursement can pass through managers first, but the last word is
   * payroll's, because the claim is then paid.
   */
  private assertFits(requestType: ApprovalRequestType, stages: PolicyStage[]) {
    if ((requestType === ApprovalRequestType.SALARY_REVISION || requestType === ApprovalRequestType.FINAL_SETTLEMENT) && stages.some((stage) => stage.kind !== ApprovalStageKind.PERMISSION)) {
      this.fail(HttpStatus.BAD_REQUEST, 'A salary change or a final settlement is approved by people holding a permission, such as payroll.approve. Use only permission stages.');
    }
    if (requestType === ApprovalRequestType.EMPLOYEE_REQUEST && !['HR', 'PERMISSION'].includes(stages[stages.length - 1].kind)) {
      this.fail(HttpStatus.BAD_REQUEST, 'An employee request must end with HR or a permission stage: that stage applies the request to the records.');
    }
    if (requestType === ApprovalRequestType.REIMBURSEMENT && stages[stages.length - 1].kind !== ApprovalStageKind.PERMISSION) {
      this.fail(HttpStatus.BAD_REQUEST, 'A reimbursement must end with a permission stage, such as payroll.adjustments.manage: payroll staff give the final approval.');
    }
  }

  /** Checks a policy before it is saved and returns it in its stored form. */
  private async validate(tenantId: string, dto: UpdateApprovalPolicyDto): Promise<PolicyStage[]> {
    const stages: PolicyStage[] = [];
    const levels = new Set<number>();
    const people = new Set<string>();
    const permissions = new Set<string>();
    const kinds = new Set<string>();

    dto.stages.forEach((raw, index) => {
      const at = `Stage ${index + 1}`;
      const extras = (allowed: Array<'level' | 'employeeId' | 'permission'>) => {
        for (const key of ['level', 'employeeId', 'permission'] as const) {
          if (!allowed.includes(key) && raw[key] !== undefined) this.fail(HttpStatus.BAD_REQUEST, `${at}: ${key} does not apply to ${raw.kind}.`);
        }
      };
      switch (raw.kind) {
        case ApprovalStageKind.REPORTING_MANAGER: {
          extras(['level']);
          const level = raw.level ?? 1;
          if (levels.has(level)) this.fail(HttpStatus.BAD_REQUEST, `${at}: the reporting manager at level ${level} is already a stage.`);
          levels.add(level);
          stages.push({ kind: raw.kind, level });
          break;
        }
        case ApprovalStageKind.EMPLOYEE:
          extras(['employeeId']);
          if (!raw.employeeId) this.fail(HttpStatus.BAD_REQUEST, `${at}: choose the person who approves.`);
          if (people.has(raw.employeeId!)) this.fail(HttpStatus.BAD_REQUEST, `${at}: that person is already a stage.`);
          people.add(raw.employeeId!);
          stages.push({ kind: raw.kind, employeeId: raw.employeeId });
          break;
        case ApprovalStageKind.PERMISSION:
          extras(['permission']);
          if (!raw.permission) this.fail(HttpStatus.BAD_REQUEST, `${at}: choose the permission whose holders approve.`);
          if (permissions.has(raw.permission!)) this.fail(HttpStatus.BAD_REQUEST, `${at}: that permission is already a stage.`);
          permissions.add(raw.permission!);
          stages.push({ kind: raw.kind, permission: raw.permission });
          break;
        case ApprovalStageKind.DEPARTMENT_HEAD:
        case ApprovalStageKind.ADDITIONAL_MANAGER:
        case ApprovalStageKind.HR:
          extras([]);
          if (kinds.has(raw.kind)) this.fail(HttpStatus.BAD_REQUEST, `${at}: ${raw.kind === ApprovalStageKind.HR ? 'HR' : raw.kind === ApprovalStageKind.ADDITIONAL_MANAGER ? 'The additional manager' : 'The department head'} is already a stage.`);
          if (raw.kind === ApprovalStageKind.HR && index !== dto.stages.length - 1) this.fail(HttpStatus.BAD_REQUEST, `${at}: HR can only be the last stage.`);
          kinds.add(raw.kind);
          stages.push({ kind: raw.kind });
          break;
      }
    });

    if (people.size) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const found = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: [...people] }, status: { [Op.in]: EMPLOYED } }, attributes: ['id'] })) as any[];
      if (found.length !== people.size) this.fail(HttpStatus.BAD_REQUEST, 'A named approver was not found, or no longer works here.');
    }
    return stages;
  }

  private assertEditable(requestType: string): ApprovalRequestType {
    if (!(requestType in DEFAULTS)) this.fail(HttpStatus.BAD_REQUEST, `'${requestType}' cannot be given an approval route.`);
    return requestType as ApprovalRequestType;
  }

  async update(tenantId: string, requestTypeInput: string, dto: UpdateApprovalPolicyDto, actorEmail?: string) {
    const requestType = this.assertEditable(requestTypeInput);
    const stages = await this.validate(tenantId, dto);
    this.assertFits(requestType, stages);
    const Policy = await this.modelProvider.getApprovalPolicyModel(tenantId);
    const row = await this.rowFor(tenantId, requestType);
    const before = Array.isArray(row?.stages) && row.stages.length ? row.stages : DEFAULTS[requestType];
    if (row) await row.update({ stages, updatedByEmail: actorEmail ?? null });
    else await Policy.create({ tenantId, requestType, stages, updatedByEmail: actorEmail ?? null } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'approval_policies', requestType, 'UPDATE', {
      stages: { from: JSON.stringify(before), to: JSON.stringify(stages) },
    });
    return this.viewOf(tenantId, requestType);
  }

  private viewOf(tenantId: string, requestType: ApprovalRequestType) {
    return requestType === ApprovalRequestType.EMPLOYEE_REQUEST ? this.employeeRequestView(tenantId) : this.view(tenantId, requestType);
  }

  /** Back to the built-in route. Requests already on their way keep the route they were given. */
  async reset(tenantId: string, requestTypeInput: string, actorEmail?: string) {
    const requestType = this.assertEditable(requestTypeInput);
    const row = await this.rowFor(tenantId, requestType);
    if (row) {
      await row.destroy();
      await writeAudit(this.modelProvider, this.logger, tenantId, 'approval_policies', requestType, 'UPDATE', {
        stages: { from: JSON.stringify(row.stages), to: 'default' },
        ...(actorEmail ? { resetBy: { from: null, to: actorEmail } } : {}),
      });
    }
    return this.viewOf(tenantId, requestType);
  }
}
