import { Injectable } from '@nestjs/common';
import { Model } from 'sequelize-typescript';
import {
  BaseTenantModelProvider,
  TenantConnectionManager,
  TenantContextService,
} from '@app/tenant-context';
import {
  Department,
  Designation,
  Employee,
  AttendanceRecord,
  WorkingHours,
  LeavePolicy,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
  LeaveRequest,
  JobOpening,
  Candidate,
  Interview,
  RecruitmentActivity,
  NewHire,
  OnboardingTask,
  PerformanceGoal,
  PerformanceReview,
  PayrollRun,
  PayrollRecord,
  PayrollAdjustment,
  SalaryRevision,
  EntityAuditLog,
  Payslip,
  ComplianceRule,
  EmployeeTaxProfile,
  TaxCertificate,
  PayrollComponent,
  SalaryStructure,
  SalaryStructureComponent,
  EmployeeRecurringItem,
  EmployeeLoan,
  Reimbursement,
  EmployeeDocument,
  EmployeeRequest,
  EmployeeNotification,
  EmployeeInvitation,
  HrReportRun,
} from '../models';
import { ProjectionOutbox } from '@app/database';

/**
 * Resolves per-tenant Sequelize connections for tenant-service's own
 * operational models (org structure, working hours, leave/attendance policy,
 * the dynamic policy engine, module-access toggles, recruitment and
 * onboarding) — these live in each tenant's own physical database, NOT in the
 * shared platform database where Tenant/Plan/Subscription/Payment/Invoice/
 * BillingEvent live.
 *
 * Connection resolution, caching and schema-sync gating live in
 * BaseTenantModelProvider, shared with user-service's provider. Only the
 * model list and the typed accessors are specific to this service.
 *
 * MUST stay singleton-scoped — see BaseTenantModelProvider for why.
 */
export const TENANT_OPERATIONAL_MODELS: Array<typeof Model> = [
  Department,
  Designation,
  // Employee before AttendanceRecord: sync() creates tables in
  // registration order and attendance_records carries a real FK to
  // employees, so the referenced table has to exist first.
  Employee,
  AttendanceRecord,
  WorkingHours,
  LeavePolicy,
  // LeaveRequest last of the three it depends on: it carries real FKs to
  // both employees and leave_policies, so both referenced tables have to
  // be created before it.
  LeaveRequest,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
  // Recruitment: JobOpening before Candidate before Interview. Each
  // carries a real FK to the one before it, so sync() has to create the
  // referenced table first (same ordering rule as LeaveRequest above).
  // RecruitmentActivity is last and depends on none of them — its id
  // columns are deliberately not FKs (see the model).
  JobOpening,
  Candidate,
  Interview,
  RecruitmentActivity,
  // Onboarding: NewHire before OnboardingTask, which FKs to it.
  NewHire,
  OnboardingTask,
  PerformanceGoal,
  PerformanceReview,
  PayrollRun,
  PayrollRecord,
  // After PayrollRecord and Employee, which they carry real FKs to.
  PayrollAdjustment,
  SalaryRevision,
  // The same table user-service writes; see the model.
  EntityAuditLog,
  // After PayrollRecord, which it carries a real FK to.
  Payslip,
  // Payroll compliance. EmployeeTaxProfile FKs to employees.
  ComplianceRule,
  EmployeeTaxProfile,
  TaxCertificate,
  // Compensation. The component before the structure lines that FK to it;
  // the employee items FK to employees.
  PayrollComponent,
  SalaryStructure,
  SalaryStructureComponent,
  EmployeeRecurringItem,
  EmployeeLoan,
  Reimbursement,
  EmployeeDocument,
  EmployeeRequest,
  EmployeeNotification,
  EmployeeInvitation,
  HrReportRun,
  // Shared with user-service: one outbox table per tenant database,
  // drained by ProjectionRelayService.
  ProjectionOutbox,
] as unknown as Array<typeof Model>;

@Injectable()
export class TenantModelProviderService extends BaseTenantModelProvider {
  constructor(
    tenantContextService: TenantContextService,
    connectionManager: TenantConnectionManager,
  ) {
    super(
      tenantContextService,
      connectionManager,
      TenantModelProviderService.name,
    );
  }

  protected get models(): Array<typeof Model> {
    return TENANT_OPERATIONAL_MODELS;
  }

  getDepartmentModel(tenantId?: string): Promise<typeof Department> {
    return this.model<typeof Department>('Department', tenantId);
  }

  getDesignationModel(tenantId?: string): Promise<typeof Designation> {
    return this.model<typeof Designation>('Designation', tenantId);
  }

  getEmployeeModel(tenantId?: string): Promise<typeof Employee> {
    return this.model<typeof Employee>('Employee', tenantId);
  }

  getAttendanceRecordModel(tenantId?: string): Promise<typeof AttendanceRecord> {
    return this.model<typeof AttendanceRecord>('AttendanceRecord', tenantId);
  }

  getWorkingHoursModel(tenantId?: string): Promise<typeof WorkingHours> {
    return this.model<typeof WorkingHours>('WorkingHours', tenantId);
  }

  getLeavePolicyModel(tenantId?: string): Promise<typeof LeavePolicy> {
    return this.model<typeof LeavePolicy>('LeavePolicy', tenantId);
  }

  getLeaveRequestModel(tenantId?: string): Promise<typeof LeaveRequest> {
    return this.model<typeof LeaveRequest>('LeaveRequest', tenantId);
  }

  getAttendancePolicyModel(tenantId?: string): Promise<typeof AttendancePolicy> {
    return this.model<typeof AttendancePolicy>('AttendancePolicy', tenantId);
  }

  getOrganizationPolicyModel(
    tenantId?: string,
  ): Promise<typeof OrganizationPolicy> {
    return this.model<typeof OrganizationPolicy>('OrganizationPolicy', tenantId);
  }

  getOrganizationModuleAccessModel(
    tenantId?: string,
  ): Promise<typeof OrganizationModuleAccess> {
    return this.model<typeof OrganizationModuleAccess>(
      'OrganizationModuleAccess',
      tenantId,
    );
  }

  // ==========================================
  // Recruitment
  // ==========================================

  getJobOpeningModel(tenantId?: string): Promise<typeof JobOpening> {
    return this.model<typeof JobOpening>('JobOpening', tenantId);
  }

  getCandidateModel(tenantId?: string): Promise<typeof Candidate> {
    return this.model<typeof Candidate>('Candidate', tenantId);
  }

  getInterviewModel(tenantId?: string): Promise<typeof Interview> {
    return this.model<typeof Interview>('Interview', tenantId);
  }

  getRecruitmentActivityModel(
    tenantId?: string,
  ): Promise<typeof RecruitmentActivity> {
    return this.model<typeof RecruitmentActivity>(
      'RecruitmentActivity',
      tenantId,
    );
  }

  // ==========================================
  // Onboarding
  // ==========================================

  getNewHireModel(tenantId?: string): Promise<typeof NewHire> {
    return this.model<typeof NewHire>('NewHire', tenantId);
  }

  getOnboardingTaskModel(tenantId?: string): Promise<typeof OnboardingTask> {
    return this.model<typeof OnboardingTask>('OnboardingTask', tenantId);
  }

  getPerformanceGoalModel(tenantId?: string): Promise<typeof PerformanceGoal> {
    return this.model<typeof PerformanceGoal>('PerformanceGoal', tenantId);
  }

  getPerformanceReviewModel(tenantId?: string): Promise<typeof PerformanceReview> {
    return this.model<typeof PerformanceReview>('PerformanceReview', tenantId);
  }

  getPayrollRunModel(tenantId?: string): Promise<typeof PayrollRun> {
    return this.model<typeof PayrollRun>('PayrollRun', tenantId);
  }

  getPayrollAdjustmentModel(tenantId?: string): Promise<typeof PayrollAdjustment> {
    return this.model<typeof PayrollAdjustment>('PayrollAdjustment', tenantId);
  }

  getSalaryRevisionModel(tenantId?: string): Promise<typeof SalaryRevision> {
    return this.model<typeof SalaryRevision>('SalaryRevision', tenantId);
  }

  getComplianceRuleModel(tenantId?: string): Promise<typeof ComplianceRule> {
    return this.model<typeof ComplianceRule>('ComplianceRule', tenantId);
  }

  getEmployeeTaxProfileModel(tenantId?: string): Promise<typeof EmployeeTaxProfile> {
    return this.model<typeof EmployeeTaxProfile>('EmployeeTaxProfile', tenantId);
  }

  getTaxCertificateModel(tenantId?: string): Promise<typeof TaxCertificate> {
    return this.model<typeof TaxCertificate>('TaxCertificate', tenantId);
  }

  getPayrollComponentModel(tenantId?: string): Promise<typeof PayrollComponent> {
    return this.model<typeof PayrollComponent>('PayrollComponent', tenantId);
  }

  getSalaryStructureModel(tenantId?: string): Promise<typeof SalaryStructure> {
    return this.model<typeof SalaryStructure>('SalaryStructure', tenantId);
  }

  getSalaryStructureComponentModel(tenantId?: string): Promise<typeof SalaryStructureComponent> {
    return this.model<typeof SalaryStructureComponent>('SalaryStructureComponent', tenantId);
  }

  getEmployeeRecurringItemModel(tenantId?: string): Promise<typeof EmployeeRecurringItem> {
    return this.model<typeof EmployeeRecurringItem>('EmployeeRecurringItem', tenantId);
  }

  getEmployeeLoanModel(tenantId?: string): Promise<typeof EmployeeLoan> {
    return this.model<typeof EmployeeLoan>('EmployeeLoan', tenantId);
  }

  getReimbursementModel(tenantId?: string): Promise<typeof Reimbursement> {
    return this.model<typeof Reimbursement>('Reimbursement', tenantId);
  }

  getPayslipModel(tenantId?: string): Promise<typeof Payslip> {
    return this.model<typeof Payslip>('Payslip', tenantId);
  }

  getEntityAuditLogModel(tenantId?: string): Promise<typeof EntityAuditLog> {
    return this.model<typeof EntityAuditLog>('EntityAuditLog', tenantId);
  }

  getPayrollRecordModel(tenantId?: string): Promise<typeof PayrollRecord> {
    return this.model<typeof PayrollRecord>('PayrollRecord', tenantId);
  }

  getEmployeeDocumentModel(tenantId?: string): Promise<typeof EmployeeDocument> {
    return this.model<typeof EmployeeDocument>('EmployeeDocument', tenantId);
  }

  getEmployeeRequestModel(tenantId?: string): Promise<typeof EmployeeRequest> {
    return this.model<typeof EmployeeRequest>('EmployeeRequest', tenantId);
  }

  getEmployeeNotificationModel(tenantId?: string): Promise<typeof EmployeeNotification> {
    return this.model<typeof EmployeeNotification>('EmployeeNotification', tenantId);
  }

  getEmployeeInvitationModel(tenantId?: string): Promise<typeof EmployeeInvitation> {
    return this.model<typeof EmployeeInvitation>('EmployeeInvitation', tenantId);
  }

  getHrReportRunModel(tenantId?: string): Promise<typeof HrReportRun> {
    return this.model<typeof HrReportRun>('HrReportRun', tenantId);
  }

  getProjectionOutboxModel(tenantId?: string): Promise<typeof ProjectionOutbox> {
    return this.model<typeof ProjectionOutbox>('ProjectionOutbox', tenantId);
  }
}
