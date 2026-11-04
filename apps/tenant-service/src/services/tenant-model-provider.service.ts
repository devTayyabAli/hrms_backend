import { Injectable } from '@nestjs/common';
import { Model } from 'sequelize-typescript';
import {
  BaseTenantModelProvider,
  TenantConnectionManager,
  TenantContextService,
} from '@app/tenant-context';
import {
  Department,
  Branch,
  HelpdeskTicket,
  EmployeeAssignment,
  DepartmentChecklistItem,
  PerformanceCycle,
  KpiTemplate,
  ReviewKpi,
  Designation,
  Employee,
  HierarchyChange,
  AttendanceRecord,
  WorkingHours,
  Shift,
  EmployeeShift,
  AssetCategory,
  Asset,
  AssetEvent,
  AssetMaintenance,
  AssetRequest,
  AssetDeductionFlag,
  AssetClearance,
  TrainingCourse,
  TrainingMaterial,
  TrainingAssignment,
  TrainingProgress,
  LearningSetting,
  TrainingRecommendation,
  ChatConversation,
  ChatParticipant,
  ChatMessage,
  ChatPresence,
  LeavePolicy,
  AttendancePolicy,
  ApprovalSetting,
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
  WorkspaceProject,
  WorkspaceProjectMember,
  WorkspaceTask,
  WorkspaceTaskAssignee,
  WorkspaceTaskComment,
  WorkspaceTaskChecklistItem,
  WorkspaceTaskAttachment,
  WorkspaceSetting,
  CalendarEvent,
  CompanyDocument,
  CompanyDocumentAcknowledgement,
  CompanyDocumentAckNotice,
  ApprovalPolicy,
  SalaryRevisionRequest,
  OffboardingSetting,
  OffboardingCase,
  OffboardingClearance,
  FinalSettlement,
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
  // Before Employee, which carries a real FK to it.
  Branch,
  Designation,
  // Employee before AttendanceRecord: sync() creates tables in
  // registration order and attendance_records carries a real FK to
  // employees, so the referenced table has to exist first.
  Employee,
  // Structure change history. No FKs, so order is free; kept by Employee.
  HierarchyChange,
  // Additional roles beside the primary position. No FKs.
  EmployeeAssignment,
  // What departments add to onboarding and offboarding. No FKs.
  DepartmentChecklistItem,
  // Performance review cycles. No FKs.
  PerformanceCycle,
  // KPI templates and the KPIs of a review. No FKs.
  KpiTemplate,
  ReviewKpi,
  AttendanceRecord,
  WorkingHours,
  // Shift before EmployeeShift, which FKs to it (and to employees, above).
  Shift,
  EmployeeShift,
  // Assets: the category and the asset before the events that FK to the asset.
  AssetCategory,
  Asset,
  AssetEvent,
  AssetMaintenance,
  AssetRequest,
  AssetDeductionFlag,
  AssetClearance,
  // IT helpdesk tickets. No FKs.
  HelpdeskTicket,
  // Learning: the course before the materials that FK to it.
  TrainingCourse,
  TrainingMaterial,
  // Assignments FK to the course and to employees; progress FKs to the assignment and the material.
  TrainingAssignment,
  TrainingProgress,
  LearningSetting,
  TrainingRecommendation,
  // Messages: the conversation before the participants and messages that FK to it.
  ChatConversation,
  ChatParticipant,
  ChatMessage,
  ChatPresence,
  LeavePolicy,
  // LeaveRequest last of the three it depends on: it carries real FKs to
  // both employees and leave_policies, so both referenced tables have to
  // be created before it.
  LeaveRequest,
  AttendancePolicy,
  ApprovalSetting,
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
  // Workspace. After Employee and Department, which projects FK to; the
  // project before the members and tasks that FK to it. The task before its assignees.
  WorkspaceProject,
  WorkspaceProjectMember,
  WorkspaceTask,
  WorkspaceTaskAssignee,
  WorkspaceTaskComment,
  WorkspaceTaskChecklistItem,
  WorkspaceTaskAttachment,
  WorkspaceSetting,
  CalendarEvent,
  // After Employee, which it FKs to.
  CompanyDocument,
  // Acknowledgements and their reminder stamps FK to the document and to employees.
  CompanyDocumentAcknowledgement,
  CompanyDocumentAckNotice,
  ApprovalPolicy,
  SalaryRevisionRequest,
  // The case before the clearances that FK to it; both FK to employees.
  OffboardingSetting,
  OffboardingCase,
  OffboardingClearance,
  FinalSettlement,
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

  getHierarchyChangeModel(tenantId?: string): Promise<typeof HierarchyChange> {
    return this.model<typeof HierarchyChange>('HierarchyChange', tenantId);
  }

  getAttendanceRecordModel(tenantId?: string): Promise<typeof AttendanceRecord> {
    return this.model<typeof AttendanceRecord>('AttendanceRecord', tenantId);
  }

  getWorkingHoursModel(tenantId?: string): Promise<typeof WorkingHours> {
    return this.model<typeof WorkingHours>('WorkingHours', tenantId);
  }

  getShiftModel(tenantId?: string): Promise<typeof Shift> {
    return this.model<typeof Shift>('Shift', tenantId);
  }

  getAssetCategoryModel(tenantId?: string): Promise<typeof AssetCategory> {
    return this.model<typeof AssetCategory>('AssetCategory', tenantId);
  }

  getAssetModel(tenantId?: string): Promise<typeof Asset> {
    return this.model<typeof Asset>('Asset', tenantId);
  }

  getTrainingCourseModel(tenantId?: string): Promise<typeof TrainingCourse> {
    return this.model<typeof TrainingCourse>('TrainingCourse', tenantId);
  }

  getTrainingAssignmentModel(tenantId?: string): Promise<typeof TrainingAssignment> {
    return this.model<typeof TrainingAssignment>('TrainingAssignment', tenantId);
  }

  getTrainingRecommendationModel(tenantId?: string): Promise<typeof TrainingRecommendation> {
    return this.model<typeof TrainingRecommendation>('TrainingRecommendation', tenantId);
  }

  getLearningSettingModel(tenantId?: string): Promise<typeof LearningSetting> {
    return this.model<typeof LearningSetting>('LearningSetting', tenantId);
  }

  getTrainingProgressModel(tenantId?: string): Promise<typeof TrainingProgress> {
    return this.model<typeof TrainingProgress>('TrainingProgress', tenantId);
  }

  getTrainingMaterialModel(tenantId?: string): Promise<typeof TrainingMaterial> {
    return this.model<typeof TrainingMaterial>('TrainingMaterial', tenantId);
  }

  getAssetRequestModel(tenantId?: string): Promise<typeof AssetRequest> {
    return this.model<typeof AssetRequest>('AssetRequest', tenantId);
  }

  getAssetDeductionFlagModel(tenantId?: string): Promise<typeof AssetDeductionFlag> {
    return this.model<typeof AssetDeductionFlag>('AssetDeductionFlag', tenantId);
  }

  getAssetClearanceModel(tenantId?: string): Promise<typeof AssetClearance> {
    return this.model<typeof AssetClearance>('AssetClearance', tenantId);
  }

  getAssetMaintenanceModel(tenantId?: string): Promise<typeof AssetMaintenance> {
    return this.model<typeof AssetMaintenance>('AssetMaintenance', tenantId);
  }

  getAssetEventModel(tenantId?: string): Promise<typeof AssetEvent> {
    return this.model<typeof AssetEvent>('AssetEvent', tenantId);
  }

  getEmployeeShiftModel(tenantId?: string): Promise<typeof EmployeeShift> {
    return this.model<typeof EmployeeShift>('EmployeeShift', tenantId);
  }

  getChatConversationModel(tenantId?: string): Promise<typeof ChatConversation> {
    return this.model<typeof ChatConversation>('ChatConversation', tenantId);
  }

  getChatParticipantModel(tenantId?: string): Promise<typeof ChatParticipant> {
    return this.model<typeof ChatParticipant>('ChatParticipant', tenantId);
  }

  getChatMessageModel(tenantId?: string): Promise<typeof ChatMessage> {
    return this.model<typeof ChatMessage>('ChatMessage', tenantId);
  }

  getChatPresenceModel(tenantId?: string): Promise<typeof ChatPresence> {
    return this.model<typeof ChatPresence>('ChatPresence', tenantId);
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

  getApprovalSettingModel(tenantId?: string): Promise<typeof ApprovalSetting> {
    return this.model<typeof ApprovalSetting>('ApprovalSetting', tenantId);
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

  getWorkspaceProjectModel(tenantId?: string): Promise<typeof WorkspaceProject> {
    return this.model<typeof WorkspaceProject>('WorkspaceProject', tenantId);
  }

  getWorkspaceProjectMemberModel(tenantId?: string): Promise<typeof WorkspaceProjectMember> {
    return this.model<typeof WorkspaceProjectMember>('WorkspaceProjectMember', tenantId);
  }

  getWorkspaceTaskModel(tenantId?: string): Promise<typeof WorkspaceTask> {
    return this.model<typeof WorkspaceTask>('WorkspaceTask', tenantId);
  }

  getWorkspaceTaskAssigneeModel(tenantId?: string): Promise<typeof WorkspaceTaskAssignee> {
    return this.model<typeof WorkspaceTaskAssignee>('WorkspaceTaskAssignee', tenantId);
  }

  getWorkspaceTaskCommentModel(tenantId?: string): Promise<typeof WorkspaceTaskComment> {
    return this.model<typeof WorkspaceTaskComment>('WorkspaceTaskComment', tenantId);
  }

  getWorkspaceTaskChecklistItemModel(tenantId?: string): Promise<typeof WorkspaceTaskChecklistItem> {
    return this.model<typeof WorkspaceTaskChecklistItem>('WorkspaceTaskChecklistItem', tenantId);
  }

  getWorkspaceTaskAttachmentModel(tenantId?: string): Promise<typeof WorkspaceTaskAttachment> {
    return this.model<typeof WorkspaceTaskAttachment>('WorkspaceTaskAttachment', tenantId);
  }

  getWorkspaceSettingModel(tenantId?: string): Promise<typeof WorkspaceSetting> {
    return this.model<typeof WorkspaceSetting>('WorkspaceSetting', tenantId);
  }

  getCalendarEventModel(tenantId?: string): Promise<typeof CalendarEvent> {
    return this.model<typeof CalendarEvent>('CalendarEvent', tenantId);
  }

  getCompanyDocumentModel(tenantId?: string): Promise<typeof CompanyDocument> {
    return this.model<typeof CompanyDocument>('CompanyDocument', tenantId);
  }

  getCompanyDocumentAcknowledgementModel(tenantId?: string): Promise<typeof CompanyDocumentAcknowledgement> {
    return this.model<typeof CompanyDocumentAcknowledgement>('CompanyDocumentAcknowledgement', tenantId);
  }

  getSalaryRevisionRequestModel(tenantId?: string): Promise<typeof SalaryRevisionRequest> {
    return this.model<typeof SalaryRevisionRequest>('SalaryRevisionRequest', tenantId);
  }

  getFinalSettlementModel(tenantId?: string): Promise<typeof FinalSettlement> {
    return this.model<typeof FinalSettlement>('FinalSettlement', tenantId);
  }

  getOffboardingSettingModel(tenantId?: string): Promise<typeof OffboardingSetting> {
    return this.model<typeof OffboardingSetting>('OffboardingSetting', tenantId);
  }

  getOffboardingCaseModel(tenantId?: string): Promise<typeof OffboardingCase> {
    return this.model<typeof OffboardingCase>('OffboardingCase', tenantId);
  }

  getOffboardingClearanceModel(tenantId?: string): Promise<typeof OffboardingClearance> {
    return this.model<typeof OffboardingClearance>('OffboardingClearance', tenantId);
  }

  getKpiTemplateModel(tenantId?: string): Promise<typeof KpiTemplate> {
    return this.model<typeof KpiTemplate>('KpiTemplate', tenantId);
  }

  getReviewKpiModel(tenantId?: string): Promise<typeof ReviewKpi> {
    return this.model<typeof ReviewKpi>('ReviewKpi', tenantId);
  }

  getPerformanceCycleModel(tenantId?: string): Promise<typeof PerformanceCycle> {
    return this.model<typeof PerformanceCycle>('PerformanceCycle', tenantId);
  }

  getDepartmentChecklistItemModel(tenantId?: string): Promise<typeof DepartmentChecklistItem> {
    return this.model<typeof DepartmentChecklistItem>('DepartmentChecklistItem', tenantId);
  }

  getEmployeeAssignmentModel(tenantId?: string): Promise<typeof EmployeeAssignment> {
    return this.model<typeof EmployeeAssignment>('EmployeeAssignment', tenantId);
  }

  getHelpdeskTicketModel(tenantId?: string): Promise<typeof HelpdeskTicket> {
    return this.model<typeof HelpdeskTicket>('HelpdeskTicket', tenantId);
  }

  getBranchModel(tenantId?: string): Promise<typeof Branch> {
    return this.model<typeof Branch>('Branch', tenantId);
  }

  getApprovalPolicyModel(tenantId?: string): Promise<typeof ApprovalPolicy> {
    return this.model<typeof ApprovalPolicy>('ApprovalPolicy', tenantId);
  }

  getCompanyDocumentAckNoticeModel(tenantId?: string): Promise<typeof CompanyDocumentAckNotice> {
    return this.model<typeof CompanyDocumentAckNotice>('CompanyDocumentAckNotice', tenantId);
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
