import { Controller, Post, Get, Body, Param, Delete } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  MESSAGE_PATTERNS,
  // Organization / module access
  CreateOrganizationProvisionDto,
  CreateOrganizationOnboardingDto,
  ValidateOrganizationOnboardingDto,
  TenantIdDto,
  ApplyIndustryTemplateMessageDto,
  UpdateModuleAccessMessageDto,
  CheckModuleAccessDto,
  // Invitation
  CreateAdminInvitationMessageDto,
  ValidateInvitationTokenDto,
  ActivateAdminDto,
  // Organization setup wizard
  UpdateOrganizationProfileMessageDto,
  UpdateAdminAvatarMessageDto,
  CreateDepartmentMessageDto,
  TenantDepartmentIdDto,
  UpdateDepartmentMessageDto,
  CreateDesignationMessageDto,
  TenantDesignationIdDto,
  UpdateDesignationMessageDto,
  UpdateWorkingHoursMessageDto,
  CreateLeavePolicyMessageDto,
  TenantLeavePolicyIdDto,
  UpdateLeavePolicyMessageDto,
  UpdateAttendancePolicyMessageDto,
  // Platform Organizations DTOs
  GetPlatformOrganizationsQueryDto,
  UpdateOrganizationStatusMessageDto,
  DeleteOrganizationMessageDto,
  UpdateOrganizationMessageDto,
  GetAllTenantsQueryDto,
  // Policy Engine DTOs
  CreatePolicyMessageDto,
  GetPoliciesMessageDto,
  TenantPolicyIdDto,
  UpdatePolicyMessageDto,
  ActivatePolicyMessageDto,
  DeactivatePolicyMessageDto,
  ArchivePolicyMessageDto,
  GetActivePolicyMessageDto,
  CreateNewVersionMessageDto,
  // Billing DTOs
  PlanFilterDto,
  IdDto,
  CreatePlanDto,
  UpdatePlanMessageDto,
  CreateSubscriptionDto,
  UpdateSubscriptionStatusMessageDto,
  CreatePaymentMessageDto,
  SimulatePaymentMessageDto,
  GetPaymentsMessageDto,
  TenantPaymentIdDto,
  CreateInvoiceMessageDto,
  TenantInvoiceIdDto,
  GetInvoicesMessageDto,
  CancelSubscriptionMessageDto,
  SubscriptionIdMessageDto,
  ChangeSubscriptionPlanMessageDto,
  SubscriptionQueryDto,
  BillingEventsMessageDto,
  ThresholdDaysDto,
  GracePeriodDaysDto,
  ExtendGracePeriodMessageDto,
  // Backup DTOs
  UpdateBackupSettingsDto,
  GetBackupsQueryDto,
  // Admin Employees screen DTOs
  GetEmployeesMessageDto,
  ExportEmployeesMessageDto,
  TenantEmployeeIdDto,
  TenantEmployeeEmailDto,
  UpdateEmployeeAvatarByEmailDto,
  CreateEmployeeMessageDto,
  UpdateEmployeeMessageDto,
  UpdateEmployeeStatusMessageDto,
  BulkDeleteEmployeesMessageDto,
  // Admin Departments screen DTOs
  GetDepartmentsOverviewMessageDto,
  ExportDepartmentsMessageDto,
  AssignDepartmentManagerMessageDto,
  // Admin Attendance screen DTOs
  GetAttendanceMessageDto,
  ExportAttendanceMessageDto,
  TenantAttendanceIdDto,
  AttendanceStatsMessageDto,
  AttendanceOverviewMessageDto,
  AttendanceByDepartmentMessageDto,
  CreateAttendanceMessageDto,
  UpdateAttendanceMessageDto,
  BulkMarkAttendanceMessageDto,
  AttendanceDashboardMessageDto,
  AttendanceRegisterMessageDto,
  ExportAttendanceRegisterMessageDto,
  EmployeeAttendanceMessageDto,
  UnmarkedAttendanceMessageDto,
  TenantLeaveRequestIdDto,
  GetLeaveRequestsMessageDto,
  ExportLeaveRequestsMessageDto,
  CreateLeaveRequestMessageDto,
  UpdateLeaveRequestMessageDto,
  DecideLeaveRequestMessageDto,
  GetJobOpeningsMessageDto,
  CreateJobOpeningMessageDto,
  UpdateJobOpeningMessageDto,
  UpdateJobOpeningStatusMessageDto,
  ExportJobOpeningsMessageDto,
  TenantJobOpeningIdDto,
  GetCandidatesMessageDto,
  CreateCandidateMessageDto,
  UpdateCandidateMessageDto,
  MoveCandidateStageMessageDto,
  GetCandidatePipelineMessageDto,
  ExportCandidatesMessageDto,
  TenantCandidateIdDto,
  GetInterviewsMessageDto,
  ScheduleInterviewMessageDto,
  UpdateInterviewMessageDto,
  RescheduleInterviewMessageDto,
  SubmitInterviewFeedbackMessageDto,
  CancelInterviewMessageDto,
  GetUpcomingInterviewsMessageDto,
  TenantInterviewIdDto,
  GetApplicationSourcesMessageDto,
  GetHiringGoalMessageDto,
  GetRecruitmentActivityMessageDto,
  GetNewHiresMessageDto,
  CreateNewHireMessageDto,
  UpdateNewHireMessageDto,
  ExportNewHiresMessageDto,
  GetOnboardingProgressMessageDto,
  TenantNewHireIdDto,
  GetOnboardingTasksMessageDto,
  CreateOnboardingTaskMessageDto,
  UpdateOnboardingTaskMessageDto,
  SetOnboardingTaskStatusMessageDto,
  GetUpcomingOnboardingTasksMessageDto,
  TenantOnboardingTaskIdDto,
  CreatePayrollRunMessageDto,
  GetPayrollHistoryMessageDto,
  GetPayrollRecordsMessageDto,
  TenantPayrollRunIdDto,
  TenantPayrollRecordIdDto,
  ReturnPayrollRunMessageDto,
  PayPayrollRunMessageDto,
  AddPayrollAdjustmentMessageDto,
  RemovePayrollAdjustmentMessageDto,
  TenantEmployeePayDto,
  SetEmployeeSalaryMessageDto,
  SetEmployeeBankMessageDto,
  ListPayslipsMessageDto,
  EmailRunPayslipsMessageDto,
  MyPayslipMessageDto,
  TenantComplianceDto,
  ListComplianceRulesMessageDto,
  CreateComplianceRuleMessageDto,
  UpdateComplianceRuleMessageDto,
  ActivateComplianceRuleMessageDto,
  ComplianceRuleIdMessageDto,
  TaxYearMessageDto,
  EmployeeTaxYearMessageDto,
  SaveTaxProfileMessageDto,
  ComplianceReportMessageDto,
  TaxCertificateListMessageDto,
  TaxCertificateIdMessageDto,
  MyTaxSummaryMessageDto,
  MyTaxCertificateMessageDto,
  TenantCompensationDto,
  ComponentQueryMessageDto,
  CreateComponentMessageDto,
  UpdateComponentMessageDto,
  ComponentStatusMessageDto,
  StructureMessageDto,
  UpdateStructureMessageDto,
  EmployeeCompensationMessageDto,
  SaveCompensationMessageDto,
  RecurringItemMessageDto,
  UpdateRecurringItemMessageDto,
  LoanQueryMessageDto,
  LoanMessageDto,
  UpdateLoanMessageDto,
  ReimbursementQueryMessageDto,
  ReimbursementMessageDto,
  DecideReimbursementMessageDto,
  AdjustmentEntryQueryMessageDto,
  AdjustmentEntryMessageDto,
  CompensationIdMessageDto,
  CompensationImportMessageDto,
  MyReimbursementMessageDto,
  GetPerformanceTrendMessageDto,
  GetPerformanceListMessageDto,
  CreatePerformanceReviewMessageDto,
  UpdatePerformanceReviewMessageDto,
  TenantPerformanceReviewIdDto,
  CreatePerformanceGoalMessageDto,
  UpdatePerformanceGoalMessageDto,
  TenantPerformanceGoalIdDto,
  EmployeeActorDto,
  HierarchyActorDto,
  EmployeePunchDto,
  AdminDashboardMessageDto,
  GetEmployeeDocumentsMessageDto,
  HrDashboardMessageDto,
  LeaveApprovalsMessageDto,
  OnboardingMatrixMessageDto,
  GenerateHrReportMessageDto,
  InviteEmployeeMessageDto,
  EmployeeInvitationIdMessageDto,
  GetEmployeeInvitationsMessageDto,
  AcceptEmployeeInvitationDto,
  UpdateMyProfileMessageDto,
  GetMyAttendanceMessageDto,
  ApplyMyLeaveMessageDto,
  MyLeaveRequestMessageDto,
  UpdateMyLeaveMessageDto,
  GetMyLeaveSummaryMessageDto,
  GetMyLeaveHistoryMessageDto,
  GetMyDocumentsMessageDto,
  UploadMyDocumentMessageDto,
  MyDocumentMessageDto,
  UpdateMyDocumentMessageDto,
  TenantEmployeeDocumentIdDto,
  ReviewEmployeeDocumentMessageDto,
  CreateMyRequestMessageDto,
  MyRequestMessageDto,
  DecideEmployeeRequestMessageDto,
  GetEmployeeRequestsMessageDto,
  GetMyNotificationsMessageDto,
  MyNotificationMessageDto,
} from '@app/common';
import { AllowUnsignedRpc } from '@app/tenant-context';
import { TenantService } from './services/tenant.service';
import { TenantProvisioningService } from './services/tenant-provisioning.service';
import { OrganizationAdminInvitationService } from './services/organization-admin-invitation.service';
import { OrganizationSetupService } from './services/organization-setup.service';
import { OrganizationPolicyService } from './services/organization-policy.service';
import { IndustryTemplateService } from './services/industry-template.service';

import { OrganizationModuleAccessService } from './services/organization-module-access.service';
import { OrganizationOnboardingValidatorService } from './services/organization-onboarding-validator.service';
import { PlatformOrganizationsService } from './services/platform-organizations.service';
import { PlatformStatusService } from './services/platform-status.service';
import { BackupService } from './services/backup.service';
import { PlatformBillingService } from './services/platform-billing.service';
import { SubscriptionLimitService } from './services/subscription-limit.service';
import { BillingScheduler } from './services/billing.scheduler';
import { PlatformReportsService } from './services/platform-reports.service';
import { EmployeeService } from './services/employee.service';
import { AttendanceService } from './services/attendance.service';
import { OrganizationDepartmentsService } from './services/organization-departments.service';
import { LeaveRequestService } from './services/leave-request.service';
import { JobOpeningService } from './services/job-opening.service';
import { CandidateService } from './services/candidate.service';
import { InterviewService } from './services/interview.service';
import { RecruitmentOverviewService } from './services/recruitment-overview.service';
import { RecruitmentActivityService } from './services/recruitment-activity.service';
import { OnboardingService } from './services/onboarding.service';
import { OnboardingTaskService } from './services/onboarding-task.service';
import { EmployeeInvitationService } from './services/employee-invitation.service';
import { PerformanceDashboardService } from './services/performance-dashboard.service';
import { PayrollDashboardService } from './services/payroll-dashboard.service';
import { EmployeePortalService } from './services/employee-portal.service';
import { MyTeamService } from './services/my-team.service';
import { PayslipService } from './services/payslip.service';
import { PayrollComplianceService } from './services/payroll-compliance.service';
import { PayrollCompensationService } from './services/payroll-compensation.service';
import { HrDashboardService } from './services/hr-dashboard.service';
import { HrReportsService } from './services/hr-reports.service';
import { DirectoryProjectionService } from './services/directory-projection.service';
import { ProjectionRelayService } from './services/projection-relay.service';

@Controller('tenants')
export class TenantServiceController {
  constructor(
    private tenantService: TenantService,
    private tenantProvisioningService: TenantProvisioningService,
    private invitationService: OrganizationAdminInvitationService,
    private setupService: OrganizationSetupService,
    private policyService: OrganizationPolicyService,
    private industryTemplateService: IndustryTemplateService,
    private moduleAccessService: OrganizationModuleAccessService,
    private onboardingValidatorService: OrganizationOnboardingValidatorService,
    private platformOrganizationsService: PlatformOrganizationsService,
    private platformStatusService: PlatformStatusService,
    private backupService: BackupService,
    private billingService: PlatformBillingService,
    private limitService: SubscriptionLimitService,
    private scheduler: BillingScheduler,
    private reportsService: PlatformReportsService,
    private employeeService: EmployeeService,
    private attendanceService: AttendanceService,
    private departmentsService: OrganizationDepartmentsService,
    private leaveRequestService: LeaveRequestService,
    private jobOpeningService: JobOpeningService,
    private candidateService: CandidateService,
    private interviewService: InterviewService,
    private recruitmentOverviewService: RecruitmentOverviewService,
    private recruitmentActivityService: RecruitmentActivityService,
    private onboardingService: OnboardingService,
    private onboardingTaskService: OnboardingTaskService,
    private employeeInvitationService: EmployeeInvitationService,
    private performanceDashboardService: PerformanceDashboardService,
    private payrollDashboardService: PayrollDashboardService,
    private employeePortalService: EmployeePortalService,
    private myTeamService: MyTeamService,
    private payslipService: PayslipService,
    private complianceService: PayrollComplianceService,
    private compensationService: PayrollCompensationService,
    private hrDashboardService: HrDashboardService,
    private hrReportsService: HrReportsService,
    private directoryProjectionService: DirectoryProjectionService,
    private projectionRelayService: ProjectionRelayService,
  ) {}

  @MessagePattern(MESSAGE_PATTERNS.HEALTH.CHECK)
  // Liveness probes are run by orchestration, which has no reason to
  // hold MICROSERVICE_SIGNING_SECRET. Safe to exempt: it takes no
  // parameters, reads no tenant data and changes nothing.
  @AllowUnsignedRpc()
  healthCheck() {
    return {
      service: 'tenant-service',
      status: 'up',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    };
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.CREATE_ORGANIZATION)
  async createOrganizationMessage(@Payload() dto: CreateOrganizationProvisionDto) {
    return this.tenantProvisioningService.createOrganizationAndProvision(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.VALIDATE_ONBOARDING)
  async validateOnboardingMessage(@Payload() dto: ValidateOrganizationOnboardingDto) {
    return this.onboardingValidatorService.validateOnboardingPayload(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.REVIEW_ONBOARDING)
  async reviewOnboardingMessage(@Payload() dto: CreateOrganizationOnboardingDto) {
    return this.onboardingValidatorService.generateReviewSummary(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.GET_INITIAL_METADATA)
  async getInitialMetadataMessage() {
    return this.onboardingValidatorService.getInitialMetadata();
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.VALIDATE_INITIAL_STEP)
  async validateInitialStepMessage(@Payload() payload: any) {
    return this.onboardingValidatorService.validateInitialStep(payload?.step, payload?.data || payload);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.REVIEW_INITIAL)
  async reviewInitialMessage(@Payload() dto: any) {
    return this.onboardingValidatorService.generateInitialReview(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.CREATE_INITIAL)
  async createInitialMessage(@Payload() dto: any) {
    return this.tenantProvisioningService.createOrganizationAndProvision(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.GET_MODULE_ACCESS)
  async getModuleAccessMessage(@Payload() data: TenantIdDto) {
    return this.moduleAccessService.getOrganizationModules(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.UPDATE_MODULE_ACCESS)
  async updateModuleAccessMessage(@Payload() data: UpdateModuleAccessMessageDto) {
    return this.moduleAccessService.setOrganizationModules(data.tenantId, data.modules);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION.CHECK_MODULE_ACCESS)
  async checkModuleAccessMessage(@Payload() data: CheckModuleAccessDto) {
    return this.moduleAccessService.isModuleEnabled(data.tenantId, data.moduleKey, data.action);
  }

  @MessagePattern(MESSAGE_PATTERNS.TENANT.PROVISION_TENANT)
  async provisionTenantMessage(@Payload() data: TenantIdDto) {
    return this.tenantProvisioningService.provisionTenantDatabase(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.TENANT.RETRY_PROVISION)
  async retryProvisioningMessage(@Payload() data: TenantIdDto) {
    return this.tenantProvisioningService.retryProvisioning(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.TENANT.GET_TENANT)
  async getTenantMessage(@Payload() data: TenantIdDto) {
    return this.tenantService.getTenantById(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.TENANT.GET_ALL_TENANTS)
  async getAllTenantsMessage(@Payload() query: GetAllTenantsQueryDto) {
    return this.tenantService.getAllTenantsPaginated(query || {});
  }

  // ==========================================
  // SUPERADMIN PLATFORM ORGANIZATIONS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALL)
  async getAllPlatformOrganizationsMessage(@Payload() query: GetPlatformOrganizationsQueryDto) {
    return this.platformOrganizationsService.getOrganizations(query || {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_STATS)
  async getPlatformOrganizationsStatsMessage() {
    return this.platformOrganizationsService.getStats();
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE)
  async getOnePlatformOrganizationMessage(@Payload() data: TenantIdDto) {
    return this.platformOrganizationsService.getOrganizationById(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.UPDATE)
  async updatePlatformOrganizationMessage(@Payload() data: UpdateOrganizationMessageDto) {
    return this.platformOrganizationsService.updateOrganization(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.UPDATE_STATUS)
  async updatePlatformOrganizationStatusMessage(@Payload() data: UpdateOrganizationStatusMessageDto) {
    return this.platformOrganizationsService.updateOrganizationStatus(data.tenantId, data.status);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.DELETE)
  async deletePlatformOrganizationMessage(@Payload() data: DeleteOrganizationMessageDto) {
    return this.platformOrganizationsService.deleteOrganization(data.tenantId, data.dto.confirmName);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_STATUS.GET_STATUS)
  async getPlatformStatusMessage() {
    return this.platformStatusService.getStatus();
  }

  // ==========================================
  // SYSTEM MANAGEMENT — BACKUPS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.BACKUP.GET_SETTINGS)
  async getBackupSettingsMessage() {
    return this.backupService.getSettings();
  }

  @MessagePattern(MESSAGE_PATTERNS.BACKUP.UPDATE_SETTINGS)
  async updateBackupSettingsMessage(@Payload() dto: UpdateBackupSettingsDto) {
    return this.backupService.updateSettings(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BACKUP.CREATE_NOW)
  async createBackupNowMessage(@Payload() payload: { triggeredBy?: string }) {
    return this.backupService.createBackupNow(payload?.triggeredBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.BACKUP.LIST)
  async listBackupsMessage(@Payload() query: GetBackupsQueryDto) {
    return this.backupService.listBackups(query || {});
  }

  @MessagePattern(MESSAGE_PATTERNS.BACKUP.GET_ONE)
  async getBackupMessage(@Payload() payload: IdDto) {
    return this.backupService.getBackup(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.BACKUP.DELETE)
  async deleteBackupMessage(@Payload() payload: IdDto) {
    return this.backupService.deleteBackup(payload.id);
  }

  // ==========================================
  // INVITATION MESSAGE PATTERNS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.INVITATION.CREATE)
  async createAdminInvitationMessage(
    @Payload() data: CreateAdminInvitationMessageDto,
  ) {
    return this.invitationService.createAdminInvitation(
      data.tenantId,
      data.dto?.adminEmail,
      data.dto?.adminName,
      data.createdBy,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.INVITATION.RESEND)
  async resendAdminInvitationMessage(@Payload() data: TenantIdDto) {
    return this.invitationService.resendAdminInvitation(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.INVITATION.VALIDATE)
  async validateInvitationTokenMessage(@Payload() data: ValidateInvitationTokenDto) {
    return this.invitationService.validateInvitationToken(data.token);
  }

  @MessagePattern(MESSAGE_PATTERNS.INVITATION.ACTIVATE)
  async activateAdminAccountMessage(@Payload() dto: ActivateAdminDto) {
    return this.invitationService.activateAdminAccount(dto);
  }

  // Employee invitation validate/accept now go through
  // MESSAGE_PATTERNS.HR_PORTAL.VALIDATE_INVITATION/ACCEPT_INVITATION (see
  // below) — the employee-invitation system moved into the tenant's own
  // database and the old INVITATION.VALIDATE_EMPLOYEE/ACTIVATE_EMPLOYEE
  // patterns (and the API gateway's old EmployeeActivationController) are
  // retired along with it.

  // ==========================================
  // ORGANIZATION SETUP WIZARD MESSAGE PATTERNS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_PROGRESS)
  async getSetupProgressMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getSetupProgress(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_PROFILE)
  async getOrganizationProfileMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getOrganizationProfile(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_BRANDING)
  async getOrganizationBrandingMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getOrganizationBranding(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_ADMIN_AVATAR)
  async getAdminAvatarMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getAdminAvatar(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_ADMIN_AVATAR)
  async updateAdminAvatarMessage(@Payload() data: UpdateAdminAvatarMessageDto) {
    return this.setupService.updateAdminAvatar(data.tenantId, data.avatarUrl);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_PROFILE)
  async updateProfileMessage(@Payload() data: UpdateOrganizationProfileMessageDto) {
    return this.setupService.updateOrganizationProfile(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_DEPARTMENTS)
  async getDepartmentsMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getDepartments(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.CREATE_DEPARTMENT)
  async createDepartmentMessage(@Payload() data: CreateDepartmentMessageDto) {
    return this.setupService.createDepartment(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_DEPARTMENT)
  async updateDepartmentMessage(
    @Payload() data: UpdateDepartmentMessageDto,
  ) {
    return this.setupService.updateDepartment(data.tenantId, data.departmentId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.DELETE_DEPARTMENT)
  async deleteDepartmentMessage(@Payload() data: TenantDepartmentIdDto) {
    return this.setupService.deleteDepartment(data.tenantId, data.departmentId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_DESIGNATIONS)
  async getDesignationsMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getDesignations(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.CREATE_DESIGNATION)
  async createDesignationMessage(@Payload() data: CreateDesignationMessageDto) {
    return this.setupService.createDesignation(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_DESIGNATION)
  async updateDesignationMessage(
    @Payload() data: UpdateDesignationMessageDto,
  ) {
    return this.setupService.updateDesignation(data.tenantId, data.designationId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.DELETE_DESIGNATION)
  async deleteDesignationMessage(@Payload() data: TenantDesignationIdDto) {
    return this.setupService.deleteDesignation(data.tenantId, data.designationId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_WORKING_HOURS)
  async getWorkingHoursMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getWorkingHours(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_WORKING_HOURS)
  async updateWorkingHoursMessage(@Payload() data: UpdateWorkingHoursMessageDto) {
    return this.setupService.updateWorkingHours(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_LEAVE_POLICIES)
  async getLeavePoliciesMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getLeavePolicies(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.CREATE_LEAVE_POLICY)
  async createLeavePolicyMessage(@Payload() data: CreateLeavePolicyMessageDto) {
    return this.setupService.createLeavePolicy(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_LEAVE_POLICY)
  async updateLeavePolicyMessage(
    @Payload() data: UpdateLeavePolicyMessageDto,
  ) {
    return this.setupService.updateLeavePolicy(data.tenantId, data.policyId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.DELETE_LEAVE_POLICY)
  async deleteLeavePolicyMessage(@Payload() data: TenantLeavePolicyIdDto) {
    return this.setupService.deleteLeavePolicy(data.tenantId, data.policyId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_ATTENDANCE_POLICY)
  async getAttendancePolicyMessage(@Payload() data: TenantIdDto) {
    return this.setupService.getAttendancePolicy(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_ATTENDANCE_POLICY)
  async updateAttendancePolicyMessage(
    @Payload() data: UpdateAttendancePolicyMessageDto,
  ) {
    return this.setupService.updateAttendancePolicy(data.tenantId, data.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.COMPLETE_SETUP)
  async completeSetupMessage(@Payload() data: TenantIdDto) {
    return this.setupService.completeSetup(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_INDUSTRY_TEMPLATE)
  async getIndustryTemplateMessage(@Payload() data: TenantIdDto) {
    return this.industryTemplateService.getTemplate(data.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_SETUP.APPLY_INDUSTRY_TEMPLATE)
  async applyIndustryTemplateMessage(@Payload() data: ApplyIndustryTemplateMessageDto) {
    return this.industryTemplateService.applyTemplate(data.tenantId, data.actorUserId);
  }

  // ==========================================
  // DYNAMIC POLICY ENGINE MESSAGE PATTERNS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.CREATE)
  async createPolicyMessage(
    @Payload() data: CreatePolicyMessageDto,
  ) {
    return this.policyService.createPolicy(data.tenantId, data.dto, data.createdBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_ALL)
  async getPoliciesMessage(@Payload() data: GetPoliciesMessageDto) {
    return this.policyService.getPolicies(data.tenantId, data.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_ONE)
  async getPolicyByIdMessage(@Payload() data: TenantPolicyIdDto) {
    return this.policyService.getPolicyById(data.tenantId, data.policyId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.UPDATE)
  async updatePolicyMessage(
    @Payload() data: UpdatePolicyMessageDto,
  ) {
    return this.policyService.updatePolicy(data.tenantId, data.policyId, data.dto, data.updatedBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.DELETE)
  async deletePolicyMessage(@Payload() data: TenantPolicyIdDto) {
    return this.policyService.deletePolicy(data.tenantId, data.policyId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.ACTIVATE)
  async activatePolicyMessage(
    @Payload() data: ActivatePolicyMessageDto,
  ) {
    return this.policyService.activatePolicy(data.tenantId, data.policyId, data.dto, data.activatedBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.DEACTIVATE)
  async deactivatePolicyMessage(
    @Payload() data: DeactivatePolicyMessageDto,
  ) {
    return this.policyService.deactivatePolicy(data.tenantId, data.policyId, data.updatedBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.ARCHIVE)
  async archivePolicyMessage(
    @Payload() data: ArchivePolicyMessageDto,
  ) {
    return this.policyService.archivePolicy(data.tenantId, data.policyId, data.updatedBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_ACTIVE)
  async getActivePolicyMessage(@Payload() data: GetActivePolicyMessageDto) {
    return this.policyService.getActivePolicy(data.tenantId, data.policyType);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_VERSIONS)
  async getPolicyVersionsMessage(@Payload() data: TenantPolicyIdDto) {
    return this.policyService.getPolicyVersions(data.tenantId, data.policyId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_POLICY.CREATE_VERSION)
  async createNewVersionMessage(
    @Payload() data: CreateNewVersionMessageDto,
  ) {
    return this.policyService.createNewVersion(data.tenantId, data.policyId, data.dto, data.createdBy);
  }

  // ==========================================
  // BILLING MESSAGE PATTERNS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_PLANS)
  async getPlansMessage(@Payload() filter: PlanFilterDto) {
    return this.billingService.getPlans(filter);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_PLAN_BY_ID)
  async getPlanByIdMessage(@Payload() payload: IdDto) {
    return this.billingService.getPlanById(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.CREATE_PLAN)
  async createPlanMessage(@Payload() dto: CreatePlanDto) {
    return this.billingService.createPlan(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.UPDATE_PLAN)
  async updatePlanMessage(@Payload() payload: UpdatePlanMessageDto) {
    return this.billingService.updatePlan(payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_METRICS)
  async getBillingMetricsMessage() {
    return this.billingService.getBillingMetrics();
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.CREATE_SUBSCRIPTION)
  async createSubscriptionMessage(@Payload() payload: CreateSubscriptionDto) {
    return this.billingService.createSubscription(
      payload.tenantId,
      payload.planId,
      payload.billingCycle,
      payload.status,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_SUBSCRIPTION)
  async getSubscriptionMessage(@Payload() payload: TenantIdDto) {
    return this.billingService.getSubscriptionByTenant(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.UPDATE_SUBSCRIPTION_STATUS)
  async updateSubscriptionStatusMessage(@Payload() payload: UpdateSubscriptionStatusMessageDto) {
    return this.billingService.updateSubscriptionStatus(payload.id, payload.status);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.CREATE_PAYMENT)
  async createPaymentMessage(@Payload() payload: CreatePaymentMessageDto) {
    return this.billingService.createPayment(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SIMULATE_PAYMENT)
  async simulatePaymentMessage(@Payload() payload: SimulatePaymentMessageDto) {
    return this.billingService.simulatePayment(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_PAYMENTS)
  async getPaymentsMessage(@Payload() payload: GetPaymentsMessageDto) {
    return this.billingService.getOrganizationPayments(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_PAYMENT_BY_ID)
  async getPaymentByIdMessage(@Payload() payload: TenantPaymentIdDto) {
    return this.billingService.getPaymentById(payload.tenantId, payload.paymentId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.GET_PAYMENT_STATUS)
  async getPaymentStatusMessage(@Payload() payload: TenantPaymentIdDto) {
    return this.billingService.getPaymentStatus(payload.tenantId, payload.paymentId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.INVOICE_CREATE)
  async createInvoiceMessage(@Payload() payload: CreateInvoiceMessageDto) {
    return this.billingService.createInvoice(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.INVOICE_GET)
  async getInvoiceByIdMessage(@Payload() payload: TenantInvoiceIdDto) {
    return this.billingService.getInvoiceById(payload.tenantId, payload.invoiceId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.INVOICE_LIST)
  async getOrganizationInvoicesMessage(@Payload() payload: GetInvoicesMessageDto) {
    return this.billingService.getOrganizationInvoices(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_CANCEL)
  async cancelSubscriptionMessage(@Payload() payload: CancelSubscriptionMessageDto) {
    return this.billingService.cancelSubscription(payload.tenantId, payload.subscriptionId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_SUSPEND)
  async suspendSubscriptionMessage(@Payload() payload: SubscriptionIdMessageDto) {
    return this.billingService.suspendSubscription(payload.subscriptionId, payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_REACTIVATE)
  async reactivateSubscriptionMessage(@Payload() payload: SubscriptionIdMessageDto) {
    return this.billingService.reactivateSubscription(payload.subscriptionId, payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_CHANGE_PLAN)
  async changeSubscriptionPlanMessage(@Payload() payload: ChangeSubscriptionPlanMessageDto) {
    return this.billingService.changeSubscriptionPlan(payload.tenantId, payload.subscriptionId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_RENEW)
  async renewSubscriptionMessage(@Payload() payload: SubscriptionIdMessageDto) {
    return this.billingService.renewSubscription(payload.subscriptionId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_HISTORY)
  async getSubscriptionHistoryMessage(@Payload() payload: TenantIdDto) {
    return this.billingService.getSubscriptionHistory(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.BILLING_SUMMARY)
  async getBillingSummaryMessage(@Payload() payload: TenantIdDto) {
    return this.billingService.getBillingSummary(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTIONS)
  async getSuperAdminSubscriptionsMessage(@Payload() query: SubscriptionQueryDto) {
    return this.billingService.getSuperAdminSubscriptions(query);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_BY_ID)
  async getSuperAdminSubscriptionByIdMessage(@Payload() payload: IdDto) {
    return this.billingService.getSuperAdminSubscriptionById(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_INVOICES)
  async getSuperAdminSubscriptionInvoicesMessage(@Payload() payload: SubscriptionIdMessageDto) {
    return this.billingService.getSuperAdminSubscriptionInvoices(payload.subscriptionId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_PAYMENTS)
  async getSuperAdminSubscriptionPaymentsMessage(@Payload() payload: SubscriptionIdMessageDto) {
    return this.billingService.getSuperAdminSubscriptionPayments(payload.subscriptionId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUPERADMIN_SUSPEND_SUBSCRIPTION)
  async superAdminSuspendSubscriptionMessage(@Payload() payload: IdDto) {
    return this.billingService.suspendSubscription(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION)
  async superAdminReactivateSubscriptionMessage(@Payload() payload: IdDto) {
    return this.billingService.reactivateSubscription(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.BILLING_STATUS)
  async getBillingStatusMessage(@Payload() payload: TenantIdDto) {
    return this.billingService.getBillingStatus(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.BILLING_USAGE)
  async getBillingUsageMessage(@Payload() payload: TenantIdDto) {
    return this.limitService.getUsageOverview(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.BILLING_EVENTS)
  async getBillingEventsMessage(@Payload() payload: BillingEventsMessageDto) {
    return this.billingService.getBillingEvents(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.UPCOMING_RENEWALS)
  async getUpcomingRenewalsMessage(@Payload() payload: ThresholdDaysDto) {
    return this.billingService.getUpcomingRenewals(payload?.thresholdDays || 7);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.OVERDUE_SUBSCRIPTIONS)
  async getOverdueSubscriptionsMessage() {
    return this.billingService.getOverdueSubscriptions();
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.SUSPENDED_SUBSCRIPTIONS)
  async getSuspendedSubscriptionsMessage() {
    return this.billingService.getSuspendedSubscriptions();
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.PROCESS_RENEWALS)
  async processRenewalsJobMessage(@Payload() payload: ThresholdDaysDto) {
    return this.scheduler.processUpcomingRenewals(payload?.thresholdDays || 7);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.PROCESS_OVERDUE)
  async processOverdueJobMessage(@Payload() payload: GracePeriodDaysDto) {
    return this.scheduler.processOverdueInvoices(payload?.gracePeriodDays || 7);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.PROCESS_SUSPENSIONS)
  async processSuspensionsJobMessage() {
    return this.scheduler.processSuspensions();
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.EXTEND_GRACE_PERIOD)
  async extendGracePeriodMessage(@Payload() payload: ExtendGracePeriodMessageDto) {
    return this.billingService.extendGracePeriod(payload.id, payload.additionalDays || 7);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.MARK_PAST_DUE)
  async markPastDueMessage(@Payload() payload: IdDto) {
    return this.billingService.markPastDue(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.CHECK_EMPLOYEE_LIMIT)
  async checkEmployeeLimitMessage(@Payload() payload: TenantIdDto) {
    return this.limitService.checkEmployeeLimit(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.CHECK_HR_USER_LIMIT)
  async checkHrUserLimitMessage(@Payload() payload: TenantIdDto) {
    return this.limitService.checkHrUserLimit(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.BILLING.CHECK_ADMIN_USER_LIMIT)
  async checkAdminUserLimitMessage(@Payload() payload: TenantIdDto) {
    return this.limitService.checkAdminUserLimit(payload.tenantId);
  }

  // ==========================================
  // DIRECT HTTP ENDPOINTS (legacy dev routes)
  // ==========================================

  @Post('provision')
  async provisionTenant(
    @Body()
    data: {
      tenantName: string;
      organizationName: string;
      email: string;
      planType: string;
    },
  ) {
    return this.tenantProvisioningService.createOrganizationAndProvision({
      organizationName: data.organizationName || data.tenantName,
      adminEmail: data.email,
    });
  }

  @Get()
  async getAllTenants() {
    return this.tenantService.getAllTenants();
  }

  @Get(':id')
  async getTenantById(@Param('id') tenantId: string) {
    return this.tenantService.getTenantById(tenantId);
  }

  @Delete(':id')
  async deprovisionTenant(@Param('id') tenantId: string) {
    await this.tenantProvisioningService.deprovisionTenant(tenantId);
    return { message: `Tenant ${tenantId} deprovisioned successfully` };
  }

  // ==========================================
  // PLATFORM REPORTS & CUSTOM REPORTS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GET_STATS)
  async handleGetReportsStats() {
    return this.reportsService.getStats();
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GET_PLATFORM_GROWTH)
  async handleGetPlatformGrowth(@Payload() query: any) {
    return this.reportsService.getPlatformGrowth(query);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GET_TOP_ORGANIZATIONS)
  async handleGetTopOrganizations(@Payload() query: any) {
    return this.reportsService.getTopOrganizations(query);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GET_TEMPLATES)
  async handleGetPopularTemplates() {
    return this.reportsService.getPopularTemplates();
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GENERATE)
  async handleGenerateReport(@Payload() dto: any) {
    return this.reportsService.generateReport(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.EXPORT)
  async handleExportReport(@Payload() dto: any) {
    return this.reportsService.exportReport(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORTS)
  async handleGetCustomReports(@Payload() query: any) {
    return this.reportsService.getCustomReports(query);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORT_BY_ID)
  async handleGetCustomReportById(@Payload() payload: { id: string } | string) {
    const id = typeof payload === 'string' ? payload : payload?.id;
    return this.reportsService.getCustomReportById(id);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.CREATE_CUSTOM_REPORT)
  async handleCreateCustomReport(@Payload() payload: { dto: any; creatorName?: string }) {
    return this.reportsService.createCustomReport(payload.dto, payload.creatorName);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.UPDATE_CUSTOM_REPORT)
  async handleUpdateCustomReport(@Payload() payload: { id: string; dto: any }) {
    return this.reportsService.updateCustomReport(payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.DELETE_CUSTOM_REPORT)
  async handleDeleteCustomReport(@Payload() payload: { id: string } | string) {
    const id = typeof payload === 'string' ? payload : payload?.id;
    return this.reportsService.deleteCustomReport(id);
  }

  @MessagePattern(MESSAGE_PATTERNS.REPORTS.RUN_CUSTOM_REPORT)
  async handleRunCustomReport(@Payload() payload: { id: string } | string) {
    const id = typeof payload === 'string' ? payload : payload?.id;
    return this.reportsService.runCustomReport(id);
  }
  // ==========================================
  // ADMIN: EMPLOYEES SCREEN
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.GET_ALL)
  async handleGetEmployees(@Payload() payload: GetEmployeesMessageDto) {
    return this.employeeService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.GET_ONE)
  async handleGetEmployee(@Payload() payload: TenantEmployeeIdDto) {
    return this.employeeService.getOne(payload.tenantId, payload.employeeId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.GET_STATS)
  async handleGetEmployeeStats(@Payload() payload: TenantIdDto) {
    return this.employeeService.getStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.GET_DIRECTORY)
  async handleGetEmployeeDirectory(@Payload() payload: TenantIdDto) {
    return this.employeeService.getDirectory(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.GET_NEXT_CODE)
  async handleGetNextEmployeeCode(@Payload() payload: TenantIdDto) {
    return { employeeCode: await this.employeeService.nextEmployeeCode(payload.tenantId) };
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.GET_MY_AVATAR)
  async handleGetMyEmployeeAvatar(@Payload() payload: TenantEmployeeEmailDto) {
    return this.employeeService.getAvatarByEmail(
      payload.tenantId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.UPDATE_MY_AVATAR)
  async handleUpdateMyEmployeeAvatar(
    @Payload() payload: UpdateEmployeeAvatarByEmailDto,
  ) {
    return this.employeeService.updateAvatarByEmail(
      payload.tenantId,
      payload.email,
      payload.avatarUrl,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.CREATE)
  async handleCreateEmployee(@Payload() payload: CreateEmployeeMessageDto) {
    return this.employeeService.create(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.UPDATE)
  async handleUpdateEmployee(@Payload() payload: UpdateEmployeeMessageDto) {
    return this.employeeService.update(
      payload.tenantId,
      payload.employeeId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.UPDATE_STATUS)
  async handleUpdateEmployeeStatus(
    @Payload() payload: UpdateEmployeeStatusMessageDto,
  ) {
    return this.employeeService.updateStatus(
      payload.tenantId,
      payload.employeeId,
      payload.dto.status,
      payload.dto.exitDate,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.DELETE)
  async handleDeleteEmployee(@Payload() payload: TenantEmployeeIdDto) {
    return this.employeeService.remove(payload.tenantId, payload.employeeId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.BULK_DELETE)
  async handleBulkDeleteEmployees(
    @Payload() payload: BulkDeleteEmployeesMessageDto,
  ) {
    return this.employeeService.bulkRemove(
      payload.tenantId,
      payload.dto.employeeIds,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE.EXPORT)
  async handleExportEmployees(@Payload() payload: ExportEmployeesMessageDto) {
    return this.employeeService.getAllForExport(
      payload.tenantId,
      payload.query,
    );
  }

  // ==========================================
  // ADMIN: DEPARTMENTS SCREEN (read side + manager assignment)
  // Create / update / delete deliberately stay on the existing
  // ORGANIZATION_SETUP.*_DEPARTMENT handlers above rather than being
  // duplicated here, so there is one write path for departments.
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.GET_OVERVIEW)
  async handleGetDepartmentsOverview(
    @Payload() payload: GetDepartmentsOverviewMessageDto,
  ) {
    return this.departmentsService.getOverview(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.GET_STATS)
  async handleGetDepartmentStats(@Payload() payload: TenantIdDto) {
    return this.departmentsService.getStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.GET_ONE)
  async handleGetDepartmentDetail(@Payload() payload: TenantDepartmentIdDto) {
    return this.departmentsService.getOne(
      payload.tenantId,
      payload.departmentId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.ASSIGN_MANAGER)
  async handleAssignDepartmentManager(
    @Payload() payload: AssignDepartmentManagerMessageDto,
  ) {
    return this.departmentsService.assignManager(
      payload.tenantId,
      payload.departmentId,
      payload.dto.managerId ?? null,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.EXPORT)
  async handleExportDepartments(
    @Payload() payload: ExportDepartmentsMessageDto,
  ) {
    return this.departmentsService.getAllForExport(
      payload.tenantId,
      payload.query,
    );
  }

  // ==========================================
  // ADMIN: ATTENDANCE SCREEN
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_ALL)
  async handleGetAttendance(@Payload() payload: GetAttendanceMessageDto) {
    return this.attendanceService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_ONE)
  async handleGetAttendanceRecord(@Payload() payload: TenantAttendanceIdDto) {
    return this.attendanceService.getOne(payload.tenantId, payload.recordId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_STATS)
  async handleGetAttendanceStats(
    @Payload() payload: AttendanceStatsMessageDto,
  ) {
    return this.attendanceService.getStats(payload.tenantId, payload.query.date);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_OVERVIEW)
  async handleGetAttendanceOverview(
    @Payload() payload: AttendanceOverviewMessageDto,
  ) {
    return this.attendanceService.getOverview(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_BY_DEPARTMENT)
  async handleGetAttendanceByDepartment(
    @Payload() payload: AttendanceByDepartmentMessageDto,
  ) {
    return this.attendanceService.getByDepartment(
      payload.tenantId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.CREATE)
  async handleCreateAttendance(@Payload() payload: CreateAttendanceMessageDto) {
    return this.attendanceService.create(
      payload.tenantId,
      payload.dto,
      payload.markedByUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.UPDATE)
  async handleUpdateAttendance(@Payload() payload: UpdateAttendanceMessageDto) {
    return this.attendanceService.update(
      payload.tenantId,
      payload.recordId,
      payload.dto,
      payload.markedByUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.DELETE)
  async handleDeleteAttendance(@Payload() payload: TenantAttendanceIdDto) {
    return this.attendanceService.remove(payload.tenantId, payload.recordId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.BULK_MARK)
  async handleBulkMarkAttendance(
    @Payload() payload: BulkMarkAttendanceMessageDto,
  ) {
    return this.attendanceService.bulkMark(
      payload.tenantId,
      payload.dto,
      payload.markedByUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.EXPORT)
  async handleExportAttendance(@Payload() payload: ExportAttendanceMessageDto) {
    return this.attendanceService.getAllForExport(
      payload.tenantId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_DASHBOARD)
  async handleGetAttendanceDashboard(
    @Payload() payload: AttendanceDashboardMessageDto,
  ) {
    return this.attendanceService.getDashboard(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_REGISTER)
  async handleGetAttendanceRegister(
    @Payload() payload: AttendanceRegisterMessageDto,
  ) {
    return this.attendanceService.getRegister(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.EXPORT_REGISTER)
  async handleExportAttendanceRegister(
    @Payload() payload: ExportAttendanceRegisterMessageDto,
  ) {
    return this.attendanceService.getRegisterForExport(
      payload.tenantId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_EMPLOYEE)
  async handleGetEmployeeAttendance(
    @Payload() payload: EmployeeAttendanceMessageDto,
  ) {
    return this.attendanceService.getEmployeeAttendance(
      payload.tenantId,
      payload.employeeId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.GET_UNMARKED)
  async handleGetUnmarkedAttendance(
    @Payload() payload: UnmarkedAttendanceMessageDto,
  ) {
    return this.attendanceService.getUnmarked(payload.tenantId, payload.query);
  }

  // ==========================================
  // ADMIN: LEAVE MANAGEMENT SCREEN
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.GET_ALL)
  async handleGetLeaveRequests(@Payload() payload: GetLeaveRequestsMessageDto) {
    return this.leaveRequestService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.GET_ONE)
  async handleGetLeaveRequest(@Payload() payload: TenantLeaveRequestIdDto) {
    return this.leaveRequestService.getOne(
      payload.tenantId,
      payload.leaveRequestId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.GET_STATS)
  async handleGetLeaveStats(@Payload() payload: TenantIdDto) {
    return this.leaveRequestService.getStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.CREATE)
  async handleCreateLeaveRequest(
    @Payload() payload: CreateLeaveRequestMessageDto,
  ) {
    return this.leaveRequestService.create(
      payload.tenantId,
      payload.dto,
      payload.appliedByUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.UPDATE)
  async handleUpdateLeaveRequest(
    @Payload() payload: UpdateLeaveRequestMessageDto,
  ) {
    return this.leaveRequestService.update(
      payload.tenantId,
      payload.leaveRequestId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.DECIDE)
  async handleDecideLeaveRequest(
    @Payload() payload: DecideLeaveRequestMessageDto,
  ) {
    return this.leaveRequestService.decide(
      payload.tenantId,
      payload.leaveRequestId,
      payload.dto,
      payload.decidedByUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.CANCEL)
  async handleCancelLeaveRequest(@Payload() payload: TenantLeaveRequestIdDto) {
    return this.leaveRequestService.cancel(
      payload.tenantId,
      payload.leaveRequestId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.DELETE)
  async handleDeleteLeaveRequest(@Payload() payload: TenantLeaveRequestIdDto) {
    return this.leaveRequestService.remove(
      payload.tenantId,
      payload.leaveRequestId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.LEAVE_REQUEST.EXPORT)
  async handleExportLeaveRequests(
    @Payload() payload: ExportLeaveRequestsMessageDto,
  ) {
    return this.leaveRequestService.getAllForExport(
      payload.tenantId,
      payload.query,
    );
  }

  // ==========================================
  // RECRUITMENT — Job Openings
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.GET_ALL)
  async handleGetJobOpenings(@Payload() payload: GetJobOpeningsMessageDto) {
    return this.jobOpeningService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.GET_ONE)
  async handleGetJobOpening(@Payload() payload: TenantJobOpeningIdDto) {
    return this.jobOpeningService.getOne(
      payload.tenantId,
      payload.jobOpeningId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.CREATE)
  async handleCreateJobOpening(
    @Payload() payload: CreateJobOpeningMessageDto,
  ) {
    return this.jobOpeningService.create(
      payload.tenantId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.UPDATE)
  async handleUpdateJobOpening(
    @Payload() payload: UpdateJobOpeningMessageDto,
  ) {
    return this.jobOpeningService.update(
      payload.tenantId,
      payload.jobOpeningId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.UPDATE_STATUS)
  async handleUpdateJobOpeningStatus(
    @Payload() payload: UpdateJobOpeningStatusMessageDto,
  ) {
    return this.jobOpeningService.updateStatus(
      payload.tenantId,
      payload.jobOpeningId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.DELETE)
  async handleDeleteJobOpening(@Payload() payload: TenantJobOpeningIdDto) {
    await this.jobOpeningService.remove(
      payload.tenantId,
      payload.jobOpeningId,
    );
    return { message: 'Job opening deleted successfully' };
  }

  @MessagePattern(MESSAGE_PATTERNS.JOB_OPENING.EXPORT)
  async handleExportJobOpenings(
    @Payload() payload: ExportJobOpeningsMessageDto,
  ) {
    return this.jobOpeningService.export(payload.tenantId, payload.query);
  }

  // ==========================================
  // RECRUITMENT — Candidates
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.GET_ALL)
  async handleGetCandidates(@Payload() payload: GetCandidatesMessageDto) {
    return this.candidateService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.GET_ONE)
  async handleGetCandidate(@Payload() payload: TenantCandidateIdDto) {
    return this.candidateService.getOne(payload.tenantId, payload.candidateId);
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.GET_PIPELINE)
  async handleGetCandidatePipeline(
    @Payload() payload: GetCandidatePipelineMessageDto,
  ) {
    return this.candidateService.getPipeline(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.CREATE)
  async handleCreateCandidate(@Payload() payload: CreateCandidateMessageDto) {
    return this.candidateService.create(
      payload.tenantId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.UPDATE)
  async handleUpdateCandidate(@Payload() payload: UpdateCandidateMessageDto) {
    return this.candidateService.update(
      payload.tenantId,
      payload.candidateId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.MOVE_STAGE)
  async handleMoveCandidateStage(
    @Payload() payload: MoveCandidateStageMessageDto,
  ) {
    return this.candidateService.moveStage(
      payload.tenantId,
      payload.candidateId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.DELETE)
  async handleDeleteCandidate(@Payload() payload: TenantCandidateIdDto) {
    await this.candidateService.remove(payload.tenantId, payload.candidateId);
    return { message: 'Candidate deleted successfully' };
  }

  @MessagePattern(MESSAGE_PATTERNS.CANDIDATE.EXPORT)
  async handleExportCandidates(
    @Payload() payload: ExportCandidatesMessageDto,
  ) {
    return this.candidateService.export(payload.tenantId, payload.query);
  }

  // ==========================================
  // RECRUITMENT — Interviews
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.GET_ALL)
  async handleGetInterviews(@Payload() payload: GetInterviewsMessageDto) {
    return this.interviewService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.GET_ONE)
  async handleGetInterview(@Payload() payload: TenantInterviewIdDto) {
    return this.interviewService.getOne(payload.tenantId, payload.interviewId);
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.GET_UPCOMING)
  async handleGetUpcomingInterviews(
    @Payload() payload: GetUpcomingInterviewsMessageDto,
  ) {
    return this.interviewService.getUpcoming(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.SCHEDULE)
  async handleScheduleInterview(
    @Payload() payload: ScheduleInterviewMessageDto,
  ) {
    return this.interviewService.schedule(
      payload.tenantId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.UPDATE)
  async handleUpdateInterview(@Payload() payload: UpdateInterviewMessageDto) {
    return this.interviewService.update(
      payload.tenantId,
      payload.interviewId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.RESCHEDULE)
  async handleRescheduleInterview(
    @Payload() payload: RescheduleInterviewMessageDto,
  ) {
    return this.interviewService.reschedule(
      payload.tenantId,
      payload.interviewId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.SUBMIT_FEEDBACK)
  async handleSubmitInterviewFeedback(
    @Payload() payload: SubmitInterviewFeedbackMessageDto,
  ) {
    return this.interviewService.submitFeedback(
      payload.tenantId,
      payload.interviewId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.CANCEL)
  async handleCancelInterview(@Payload() payload: CancelInterviewMessageDto) {
    return this.interviewService.cancel(
      payload.tenantId,
      payload.interviewId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.INTERVIEW.DELETE)
  async handleDeleteInterview(@Payload() payload: TenantInterviewIdDto) {
    await this.interviewService.remove(payload.tenantId, payload.interviewId);
    return { message: 'Interview deleted successfully' };
  }

  // ==========================================
  // RECRUITMENT — KPI cards, charts, activity feed
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.RECRUITMENT.GET_STATS)
  async handleGetRecruitmentStats(@Payload() payload: TenantIdDto) {
    return this.recruitmentOverviewService.getStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.RECRUITMENT.GET_FUNNEL)
  async handleGetRecruitmentFunnel(@Payload() payload: TenantIdDto) {
    return this.recruitmentOverviewService.getFunnel(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.RECRUITMENT.GET_APPLICATION_SOURCES)
  async handleGetApplicationSources(
    @Payload() payload: GetApplicationSourcesMessageDto,
  ) {
    return this.recruitmentOverviewService.getApplicationSources(
      payload.tenantId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.RECRUITMENT.GET_HIRING_GOAL)
  async handleGetHiringGoal(@Payload() payload: GetHiringGoalMessageDto) {
    return this.recruitmentOverviewService.getHiringGoal(
      payload.tenantId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.RECRUITMENT.GET_ACTIVITY)
  async handleGetRecruitmentActivity(
    @Payload() payload: GetRecruitmentActivityMessageDto,
  ) {
    return this.recruitmentActivityService.getFeed(
      payload.tenantId,
      payload.query,
    );
  }

  // ==========================================
  // ONBOARDING — New Hires
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.GET_ALL)
  async handleGetNewHires(@Payload() payload: GetNewHiresMessageDto) {
    return this.onboardingService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.GET_ONE)
  async handleGetNewHire(@Payload() payload: TenantNewHireIdDto) {
    return this.onboardingService.getOne(payload.tenantId, payload.newHireId);
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.GET_STATS)
  async handleGetOnboardingStats(@Payload() payload: TenantIdDto) {
    return this.onboardingService.getStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.GET_PROGRESS)
  async handleGetOnboardingProgress(
    @Payload() payload: GetOnboardingProgressMessageDto,
  ) {
    return this.onboardingService.getProgress(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.CREATE)
  async handleCreateNewHire(@Payload() payload: CreateNewHireMessageDto) {
    return this.onboardingService.create(
      payload.tenantId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.UPDATE)
  async handleUpdateNewHire(@Payload() payload: UpdateNewHireMessageDto) {
    return this.onboardingService.update(
      payload.tenantId,
      payload.newHireId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.DELETE)
  async handleDeleteNewHire(@Payload() payload: TenantNewHireIdDto) {
    await this.onboardingService.remove(payload.tenantId, payload.newHireId);
    return { message: 'New hire deleted successfully' };
  }

  @MessagePattern(MESSAGE_PATTERNS.NEW_HIRE.EXPORT)
  async handleExportNewHires(@Payload() payload: ExportNewHiresMessageDto) {
    return this.onboardingService.export(payload.tenantId, payload.query);
  }

  // ==========================================
  // ONBOARDING — Checklist tasks
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.GET_ALL)
  async handleGetOnboardingTasks(
    @Payload() payload: GetOnboardingTasksMessageDto,
  ) {
    return this.onboardingTaskService.getAll(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.GET_ONE)
  async handleGetOnboardingTask(
    @Payload() payload: TenantOnboardingTaskIdDto,
  ) {
    return this.onboardingTaskService.getOne(payload.tenantId, payload.taskId);
  }

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.GET_UPCOMING)
  async handleGetUpcomingOnboardingTasks(
    @Payload() payload: GetUpcomingOnboardingTasksMessageDto,
  ) {
    return this.onboardingTaskService.getUpcoming(
      payload.tenantId,
      payload.query,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.CREATE)
  async handleCreateOnboardingTask(
    @Payload() payload: CreateOnboardingTaskMessageDto,
  ) {
    return this.onboardingTaskService.create(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.UPDATE)
  async handleUpdateOnboardingTask(
    @Payload() payload: UpdateOnboardingTaskMessageDto,
  ) {
    return this.onboardingTaskService.update(
      payload.tenantId,
      payload.taskId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.SET_STATUS)
  async handleSetOnboardingTaskStatus(
    @Payload() payload: SetOnboardingTaskStatusMessageDto,
  ) {
    return this.onboardingTaskService.setStatus(
      payload.tenantId,
      payload.taskId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ONBOARDING_TASK.DELETE)
  async handleDeleteOnboardingTask(
    @Payload() payload: TenantOnboardingTaskIdDto,
  ) {
    await this.onboardingTaskService.remove(payload.tenantId, payload.taskId);
    return { message: 'Onboarding task deleted successfully' };
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_OVERVIEW)
  async handleGetPerformanceOverview(@Payload() payload: TenantIdDto) {
    return this.performanceDashboardService.getOverview(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_TREND)
  async handleGetPerformanceTrend(@Payload() payload: GetPerformanceTrendMessageDto) {
    return this.performanceDashboardService.getTrend(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_METRICS)
  async handleGetPerformanceMetrics(@Payload() payload: TenantIdDto) {
    return this.performanceDashboardService.getMetrics(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_BY_DEPARTMENT)
  async handleGetPerformanceByDepartment(@Payload() payload: TenantIdDto) {
    return this.performanceDashboardService.getByDepartment(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_TOP_PERFORMERS)
  async handleGetTopPerformers(@Payload() payload: GetPerformanceListMessageDto) {
    return this.performanceDashboardService.getTopPerformers(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_REVIEWS)
  async handleGetPerformanceReviews(@Payload() payload: GetPerformanceListMessageDto) {
    return this.performanceDashboardService.getReviews(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_REVIEW)
  async handleGetPerformanceReview(@Payload() payload: TenantPerformanceReviewIdDto) {
    return this.performanceDashboardService.getReview(payload.tenantId, payload.reviewId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.CREATE_REVIEW)
  async handleCreatePerformanceReview(@Payload() payload: CreatePerformanceReviewMessageDto) {
    return this.performanceDashboardService.createReview(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.UPDATE_REVIEW)
  async handleUpdatePerformanceReview(@Payload() payload: UpdatePerformanceReviewMessageDto) {
    return this.performanceDashboardService.updateReview(
      payload.tenantId,
      payload.reviewId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.DELETE_REVIEW)
  async handleDeletePerformanceReview(@Payload() payload: TenantPerformanceReviewIdDto) {
    await this.performanceDashboardService.deleteReview(payload.tenantId, payload.reviewId);
    return { message: 'Performance review deleted successfully' };
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_GOALS)
  async handleGetPerformanceGoals(@Payload() payload: GetPerformanceListMessageDto) {
    return this.performanceDashboardService.getGoals(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.GET_GOAL)
  async handleGetPerformanceGoal(@Payload() payload: TenantPerformanceGoalIdDto) {
    return this.performanceDashboardService.getGoal(payload.tenantId, payload.goalId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.CREATE_GOAL)
  async handleCreatePerformanceGoal(@Payload() payload: CreatePerformanceGoalMessageDto) {
    return this.performanceDashboardService.createGoal(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.UPDATE_GOAL)
  async handleUpdatePerformanceGoal(@Payload() payload: UpdatePerformanceGoalMessageDto) {
    return this.performanceDashboardService.updateGoal(
      payload.tenantId,
      payload.goalId,
      payload.dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.PERFORMANCE.DELETE_GOAL)
  async handleDeletePerformanceGoal(@Payload() payload: TenantPerformanceGoalIdDto) {
    await this.performanceDashboardService.deleteGoal(payload.tenantId, payload.goalId);
    return { message: 'Performance goal deleted successfully' };
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_OVERVIEW)
  async handleGetPayrollOverview(@Payload() payload: TenantIdDto) {
    return this.payrollDashboardService.getOverview(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_BREAKDOWN)
  async handleGetPayrollBreakdown(@Payload() payload: TenantIdDto) {
    return this.payrollDashboardService.getBreakdown(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_HISTORY)
  async handleGetPayrollHistory(@Payload() payload: GetPayrollHistoryMessageDto) {
    return this.payrollDashboardService.getHistory(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RUNS)
  async handleGetPayrollRuns(@Payload() payload: GetPerformanceListMessageDto) {
    return this.payrollDashboardService.getRuns(payload.tenantId, payload.query?.limit);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RUN)
  async handleGetPayrollRun(@Payload() payload: TenantPayrollRunIdDto) {
    return this.payrollDashboardService.getRun(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.CREATE_RUN)
  async handleCreatePayrollRun(@Payload() payload: CreatePayrollRunMessageDto) {
    return this.payrollDashboardService.createRun(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.RECALCULATE_RUN)
  async handleRecalculatePayrollRun(@Payload() payload: TenantPayrollRunIdDto) {
    return this.payrollDashboardService.recalculateRun(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.SUBMIT_RUN)
  async handleSubmitPayrollRun(@Payload() payload: TenantPayrollRunIdDto) {
    return this.payrollDashboardService.submitRun(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.APPROVE_RUN)
  async handleApprovePayrollRun(@Payload() payload: TenantPayrollRunIdDto) {
    return this.payrollDashboardService.approveRun(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.RETURN_RUN)
  async handleReturnPayrollRun(@Payload() payload: ReturnPayrollRunMessageDto) {
    return this.payrollDashboardService.returnRun(payload.tenantId, payload.payrollRunId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.PAY_RUN)
  async handlePayPayrollRun(@Payload() payload: PayPayrollRunMessageDto) {
    return this.payrollDashboardService.payRun(payload.tenantId, payload.payrollRunId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RUN_ACTIVITY)
  async handleGetPayrollRunActivity(@Payload() payload: TenantPayrollRunIdDto) {
    return this.payrollDashboardService.getRunActivity(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RECORDS)
  async handleGetPayrollRecords(@Payload() payload: GetPayrollRecordsMessageDto) {
    return this.payrollDashboardService.getRecords(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RECORD)
  async handleGetPayrollRecord(@Payload() payload: TenantPayrollRecordIdDto) {
    return this.payrollDashboardService.getRecord(payload.tenantId, payload.recordId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.ADD_ADJUSTMENT)
  async handleAddPayrollAdjustment(@Payload() payload: AddPayrollAdjustmentMessageDto) {
    return this.payrollDashboardService.addAdjustment(payload.tenantId, payload.recordId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.REMOVE_ADJUSTMENT)
  async handleRemovePayrollAdjustment(@Payload() payload: RemovePayrollAdjustmentMessageDto) {
    return this.payrollDashboardService.removeAdjustment(payload.tenantId, payload.adjustmentId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_EMPLOYEE_PAY)
  async handleGetEmployeePay(@Payload() payload: TenantEmployeePayDto) {
    return this.payrollDashboardService.getEmployeePay(payload.tenantId, payload.employeeId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.SET_EMPLOYEE_SALARY)
  async handleSetEmployeeSalary(@Payload() payload: SetEmployeeSalaryMessageDto) {
    return this.payrollDashboardService.setEmployeeSalary(payload.tenantId, payload.employeeId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.SET_EMPLOYEE_BANK)
  async handleSetEmployeeBank(@Payload() payload: SetEmployeeBankMessageDto) {
    return this.payrollDashboardService.setEmployeeBank(payload.tenantId, payload.employeeId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RUN_PAYSLIPS)
  async handleGetRunPayslips(@Payload() payload: TenantPayrollRunIdDto) {
    return this.payslipService.listRunPayslips(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.LIST_PAYSLIPS)
  async handleListPayslips(@Payload() payload: ListPayslipsMessageDto) {
    return this.payslipService.listPayslips(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RECORD_PAYSLIP)
  async handleGetRecordPayslip(@Payload() payload: TenantPayrollRecordIdDto) {
    return this.payslipService.getRecordPayslip(payload.tenantId, payload.recordId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_RECORD_PAYSLIP_PDF)
  async handleGetRecordPayslipPdf(@Payload() payload: TenantPayrollRecordIdDto) {
    return this.payslipService.getRecordPayslipPdf(payload.tenantId, payload.recordId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.EMAIL_RECORD_PAYSLIP)
  async handleEmailRecordPayslip(@Payload() payload: TenantPayrollRecordIdDto) {
    return this.payslipService.emailRecordPayslip(payload.tenantId, payload.recordId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.EMAIL_RUN_PAYSLIPS)
  async handleEmailRunPayslips(@Payload() payload: EmailRunPayslipsMessageDto) {
    return this.payslipService.emailRunPayslips(payload.tenantId, payload.payrollRunId, payload.dto ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_PAYSLIPS)
  handleGetMyPayslips(@Payload() payload: EmployeeActorDto) {
    return this.payslipService.listMyPayslips(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_PAYSLIP)
  handleGetMyPayslip(@Payload() payload: MyPayslipMessageDto) {
    return this.payslipService.getMyPayslip(payload.tenantId, payload.userId, payload.email, payload.payslipId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_PAYSLIP_PDF)
  handleGetMyPayslipPdf(@Payload() payload: MyPayslipMessageDto) {
    return this.payslipService.getMyPayslipPdf(payload.tenantId, payload.userId, payload.email, payload.payslipId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.EMAIL_MY_PAYSLIP)
  handleEmailMyPayslip(@Payload() payload: MyPayslipMessageDto) {
    return this.payslipService.emailMyPayslip(payload.tenantId, payload.userId, payload.email, payload.payslipId);
  }

  // ── Payroll compensation ───────────────────────────────────────────────────

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_COMPONENTS)
  handleListPayComponents(@Payload() payload: ComponentQueryMessageDto) {
    return this.compensationService.listComponents(payload.tenantId, payload.query ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.COMPONENT_OPTIONS)
  handlePayComponentOptions(@Payload() _payload: TenantCompensationDto) {
    return this.compensationService.catalogOptions();
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_COMPONENT)
  handleCreatePayComponent(@Payload() payload: CreateComponentMessageDto) {
    return this.compensationService.createComponent(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_COMPONENT)
  handleUpdatePayComponent(@Payload() payload: UpdateComponentMessageDto) {
    return this.compensationService.updateComponent(payload.tenantId, payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.SET_COMPONENT_STATUS)
  handleSetPayComponentStatus(@Payload() payload: ComponentStatusMessageDto) {
    return this.compensationService.setComponentStatus(payload.tenantId, payload.id, payload.dto.status);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_STRUCTURES)
  handleListSalaryStructures(@Payload() payload: TenantCompensationDto) {
    return this.compensationService.listStructures(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_STRUCTURE)
  handleCreateSalaryStructure(@Payload() payload: StructureMessageDto) {
    return this.compensationService.createStructure(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_STRUCTURE)
  handleUpdateSalaryStructure(@Payload() payload: UpdateStructureMessageDto) {
    return this.compensationService.updateStructure(payload.tenantId, payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_EMPLOYEES)
  handleListEmployeeCompensation(@Payload() payload: TenantCompensationDto) {
    return this.compensationService.listEmployeeCompensation(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.GET_COMPENSATION)
  handleGetCompensation(@Payload() payload: EmployeeCompensationMessageDto) {
    return this.compensationService.getCompensation(payload.tenantId, payload.employeeId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.PREVIEW_COMPENSATION)
  handlePreviewCompensation(@Payload() payload: SaveCompensationMessageDto) {
    return this.compensationService.previewCompensation(payload.tenantId, payload.employeeId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.SAVE_COMPENSATION)
  handleSaveCompensation(@Payload() payload: SaveCompensationMessageDto) {
    return this.compensationService.saveCompensation(payload.tenantId, payload.employeeId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_RECURRING)
  handleListRecurringItems(@Payload() payload: EmployeeCompensationMessageDto) {
    return this.compensationService.listRecurringItems(payload.tenantId, payload.employeeId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_RECURRING)
  handleCreateRecurringItem(@Payload() payload: RecurringItemMessageDto) {
    return this.compensationService.createRecurringItem(payload.tenantId, payload.employeeId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_RECURRING)
  handleUpdateRecurringItem(@Payload() payload: UpdateRecurringItemMessageDto) {
    return this.compensationService.updateRecurringItem(payload.tenantId, payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_LOANS)
  handleListLoans(@Payload() payload: LoanQueryMessageDto) {
    return this.compensationService.listLoans(payload.tenantId, payload.query ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_LOAN)
  handleCreateLoan(@Payload() payload: LoanMessageDto) {
    return this.compensationService.createLoan(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.UPDATE_LOAN)
  handleUpdateLoan(@Payload() payload: UpdateLoanMessageDto) {
    return this.compensationService.updateLoan(payload.tenantId, payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_REIMBURSEMENTS)
  handleListReimbursements(@Payload() payload: ReimbursementQueryMessageDto) {
    return this.compensationService.listReimbursements(payload.tenantId, payload.query ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_REIMBURSEMENT)
  handleCreateReimbursement(@Payload() payload: ReimbursementMessageDto) {
    return this.compensationService.createReimbursement(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.DECIDE_REIMBURSEMENT)
  handleDecideReimbursement(@Payload() payload: DecideReimbursementMessageDto) {
    return this.compensationService.decideReimbursement(payload.tenantId, payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.LIST_ADJUSTMENTS)
  handleListAdjustmentEntries(@Payload() payload: AdjustmentEntryQueryMessageDto) {
    return this.payrollDashboardService.listAdjustmentEntries(payload.tenantId, payload.query ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.CREATE_ADJUSTMENT)
  handleCreateAdjustmentEntry(@Payload() payload: AdjustmentEntryMessageDto) {
    return this.payrollDashboardService.createAdjustmentEntry(payload.tenantId, payload.dto as any);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.REMOVE_ADJUSTMENT)
  handleRemoveAdjustmentEntry(@Payload() payload: CompensationIdMessageDto) {
    return this.payrollDashboardService.removeAdjustmentEntry(payload.tenantId, payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPENSATION.IMPORT)
  handleImportCompensation(@Payload() payload: CompensationImportMessageDto) {
    return this.compensationService.importCompensation(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_COMPENSATION)
  handleGetMyCompensation(@Payload() payload: EmployeeActorDto) {
    return this.compensationService.myCompensation(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_REIMBURSEMENTS)
  handleGetMyReimbursements(@Payload() payload: EmployeeActorDto) {
    return this.compensationService.myReimbursements(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.SUBMIT_MY_REIMBURSEMENT)
  handleSubmitMyReimbursement(@Payload() payload: MyReimbursementMessageDto) {
    return this.compensationService.submitMyReimbursement(payload.tenantId, payload.userId, payload.email, payload.dto);
  }

  // ── Payroll compliance ─────────────────────────────────────────────────────

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_RULES)
  handleListComplianceRules(@Payload() payload: ListComplianceRulesMessageDto) {
    return this.complianceService.listRules(payload.tenantId, payload.ruleType);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_TEMPLATES)
  handleListComplianceTemplates(@Payload() _payload: TenantComplianceDto) {
    return this.complianceService.listTemplates();
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.CREATE_RULE)
  handleCreateComplianceRule(@Payload() payload: CreateComplianceRuleMessageDto) {
    return this.complianceService.createRule(payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.UPDATE_RULE)
  handleUpdateComplianceRule(@Payload() payload: UpdateComplianceRuleMessageDto) {
    return this.complianceService.updateRule(payload.tenantId, payload.ruleId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.ACTIVATE_RULE)
  handleActivateComplianceRule(@Payload() payload: ActivateComplianceRuleMessageDto) {
    return this.complianceService.activateRule(payload.tenantId, payload.ruleId, payload.dto ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.RETIRE_RULE)
  handleRetireComplianceRule(@Payload() payload: ComplianceRuleIdMessageDto) {
    return this.complianceService.retireRule(payload.tenantId, payload.ruleId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_TAX_PROFILES)
  handleListTaxProfiles(@Payload() payload: TaxYearMessageDto) {
    return this.complianceService.listTaxProfiles(payload.tenantId, payload.taxYear);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_TAX_PROFILE)
  handleGetTaxProfile(@Payload() payload: EmployeeTaxYearMessageDto) {
    return this.complianceService.getTaxProfile(payload.tenantId, payload.employeeId, payload.taxYear);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.SAVE_TAX_PROFILE)
  handleSaveTaxProfile(@Payload() payload: SaveTaxProfileMessageDto) {
    return this.complianceService.saveTaxProfile(payload.tenantId, payload.employeeId, payload.taxYear, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_REPORT)
  handleComplianceReport(@Payload() payload: ComplianceReportMessageDto) {
    return this.complianceService.report(payload.tenantId, payload.type, payload.filters ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.EXPORT_REPORT)
  handleExportComplianceReport(@Payload() payload: ComplianceReportMessageDto) {
    return this.complianceService.exportReport(payload.tenantId, payload.type, payload.filters ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_TAX_SUMMARIES)
  handleListTaxSummaries(@Payload() payload: TaxYearMessageDto) {
    return this.complianceService.listTaxSummaries(payload.tenantId, payload.taxYear);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_TAX_SUMMARY)
  handleGetTaxSummary(@Payload() payload: EmployeeTaxYearMessageDto) {
    return this.complianceService.getTaxSummary(payload.tenantId, payload.employeeId, payload.taxYear);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.ISSUE_CERTIFICATE)
  handleIssueTaxCertificate(@Payload() payload: EmployeeTaxYearMessageDto) {
    return this.complianceService.issueCertificate(payload.tenantId, payload.employeeId, payload.taxYear);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.LIST_CERTIFICATES)
  handleListTaxCertificates(@Payload() payload: TaxCertificateListMessageDto) {
    return this.complianceService.listCertificates(payload.tenantId, payload.filters ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL_COMPLIANCE.GET_CERTIFICATE_PDF)
  handleGetTaxCertificatePdf(@Payload() payload: TaxCertificateIdMessageDto) {
    return this.complianceService.getCertificatePdf(payload.tenantId, payload.certificateId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TAX_SUMMARY)
  handleGetMyTaxSummary(@Payload() payload: MyTaxSummaryMessageDto) {
    return this.complianceService.myTaxSummary(payload.tenantId, payload.userId, payload.email, payload.taxYear);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TAX_CERTIFICATES)
  handleGetMyTaxCertificates(@Payload() payload: EmployeeActorDto) {
    return this.complianceService.myCertificates(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TAX_CERTIFICATE_PDF)
  handleGetMyTaxCertificatePdf(@Payload() payload: MyTaxCertificateMessageDto) {
    return this.complianceService.myCertificatePdf(payload.tenantId, payload.userId, payload.email, payload.certificateId);
  }

  // ── Payroll cycle, process checks and export ──────────────────────────────

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_CYCLE)
  async handleGetPayrollCycle(@Payload() payload: TenantIdDto) {
    return this.payrollDashboardService.getCycle(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.GET_PROCESS_CHECKS)
  async handleGetPayrollProcessChecks(
    @Payload() payload: { tenantId: string; payrollRunId: string },
  ) {
    return this.payrollDashboardService.getProcessChecks(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PAYROLL.EXPORT_RECORDS)
  async handleExportPayrollRecords(
    @Payload() payload: { tenantId: string; payrollRunId?: string },
  ) {
    return this.payrollDashboardService.exportRecords(payload.tenantId, payload.payrollRunId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DASHBOARD)
  handleEmployeeDashboard(@Payload() payload: EmployeeActorDto) {
    return this.employeePortalService.getDashboard(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TEAM)
  handleMyTeam(@Payload() payload: EmployeeActorDto) {
    return this.myTeamService.getMyTeam(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_HIERARCHY)
  handleHierarchy(@Payload() payload: HierarchyActorDto) {
    return this.myTeamService.getHierarchy(payload.tenantId, payload.userId, payload.email, payload.canViewAll);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEADERSHIP)
  handleLeadership(@Payload() payload: EmployeeActorDto) {
    return this.myTeamService.getLeadership(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_PROFILE)
  handleEmployeeProfile(@Payload() payload: EmployeeActorDto) {
    return this.employeePortalService.getProfile(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_PROFILE)
  handleUpdateEmployeeProfile(@Payload() payload: UpdateMyProfileMessageDto) {
    return this.employeePortalService.updateProfile(payload.tenantId, payload.userId, payload.dto, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_ATTENDANCE)
  handleEmployeeAttendance(@Payload() payload: GetMyAttendanceMessageDto) {
    return this.employeePortalService.getAttendance(payload.tenantId, payload.userId, payload.query, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_ATTENDANCE_TODAY)
  handleEmployeeAttendanceToday(@Payload() payload: EmployeeActorDto) {
    return this.employeePortalService.getAttendanceToday(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CHECK_IN)
  handleEmployeeCheckIn(@Payload() payload: EmployeePunchDto) {
    return this.employeePortalService.checkIn(payload.tenantId, payload.userId, payload.email, payload.clientIp);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CHECK_OUT)
  handleEmployeeCheckOut(@Payload() payload: EmployeePunchDto) {
    return this.employeePortalService.checkOut(payload.tenantId, payload.userId, payload.email, payload.clientIp);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEAVE_SUMMARY)
  handleEmployeeLeaveSummary(@Payload() payload: GetMyLeaveSummaryMessageDto) {
    return this.employeePortalService.getLeaveSummary(payload.tenantId, payload.userId, payload.query, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEAVE_HISTORY)
  handleEmployeeLeaveHistory(@Payload() payload: GetMyLeaveHistoryMessageDto) {
    return this.employeePortalService.getLeaveHistory(payload.tenantId, payload.userId, payload.query, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.APPLY_LEAVE)
  handleEmployeeApplyLeave(@Payload() payload: ApplyMyLeaveMessageDto) {
    return this.employeePortalService.applyLeave(payload.tenantId, payload.userId, payload.dto, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.PREVIEW_LEAVE)
  handleEmployeePreviewLeave(@Payload() payload: ApplyMyLeaveMessageDto) {
    return this.employeePortalService.previewLeave(payload.tenantId, payload.userId, payload.dto, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEAVE)
  handleEmployeeGetLeave(@Payload() payload: MyLeaveRequestMessageDto) {
    return this.employeePortalService.getLeave(
      payload.tenantId,
      payload.userId,
      payload.leaveRequestId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_LEAVE)
  handleEmployeeUpdateLeave(@Payload() payload: UpdateMyLeaveMessageDto) {
    return this.employeePortalService.updateLeave(
      payload.tenantId,
      payload.userId,
      payload.leaveRequestId,
      payload.dto,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CANCEL_LEAVE)
  handleEmployeeCancelLeave(@Payload() payload: MyLeaveRequestMessageDto) {
    return this.employeePortalService.cancelLeave(
      payload.tenantId,
      payload.userId,
      payload.leaveRequestId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENTS)
  handleEmployeeDocuments(@Payload() payload: GetMyDocumentsMessageDto) {
    return this.employeePortalService.getDocuments(payload.tenantId, payload.userId, payload.query, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPLOAD_DOCUMENT)
  handleEmployeeUploadDocument(@Payload() payload: UploadMyDocumentMessageDto) {
    return this.employeePortalService.uploadDocument(payload.tenantId, payload.userId, payload.dto, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENT)
  handleEmployeeDocument(@Payload() payload: MyDocumentMessageDto) {
    return this.employeePortalService.getDocument(
      payload.tenantId,
      payload.userId,
      payload.documentId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.DELETE_DOCUMENT)
  handleEmployeeDeleteDocument(@Payload() payload: MyDocumentMessageDto) {
    return this.employeePortalService.deleteDocument(
      payload.tenantId,
      payload.userId,
      payload.documentId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_DOCUMENT)
  handleEmployeeUpdateDocument(@Payload() payload: UpdateMyDocumentMessageDto) {
    return this.employeePortalService.updateDocument(
      payload.tenantId,
      payload.userId,
      payload.documentId,
      payload.dto,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.HR_GET_DOCUMENTS)
  handleHrGetEmployeeDocuments(@Payload() payload: GetEmployeeDocumentsMessageDto) {
    // The same list as LIST_ALL_DOCUMENTS — one implementation for both.
    return this.employeePortalService.listAllDocuments(payload.tenantId, payload.query, {
      userId: payload.actorUserId,
      email: payload.actorEmail,
    });
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.HR_GET_DOCUMENT)
  handleHrGetEmployeeDocument(@Payload() payload: TenantEmployeeDocumentIdDto) {
    return this.employeePortalService.getEmployeeDocument(payload.tenantId, payload.documentId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.REVIEW_DOCUMENT)
  handleReviewEmployeeDocument(@Payload() payload: ReviewEmployeeDocumentMessageDto) {
    return this.employeePortalService.reviewDocument(payload.tenantId, payload.documentId, payload.dto, {
      userId: payload.actorUserId,
      email: payload.actorEmail,
    });
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.LIST_ALL_DOCUMENTS)
  handleListAllEmployeeDocuments(@Payload() payload: GetEmployeeDocumentsMessageDto) {
    return this.employeePortalService.listAllDocuments(payload.tenantId, payload.query, {
      userId: payload.actorUserId,
      email: payload.actorEmail,
    });
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENT_STATS)
  handleGetEmployeeDocumentStats(@Payload() payload: TenantIdDto) {
    return this.employeePortalService.getDocumentStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_REQUESTS)
  handleEmployeeRequests(@Payload() payload: EmployeeActorDto) {
    return this.employeePortalService.getRequests(payload.tenantId, payload.userId, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CREATE_REQUEST)
  handleEmployeeCreateRequest(@Payload() payload: CreateMyRequestMessageDto) {
    return this.employeePortalService.createRequest(payload.tenantId, payload.userId, payload.dto, payload.email);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CANCEL_REQUEST)
  handleEmployeeCancelRequest(@Payload() payload: MyRequestMessageDto) {
    return this.employeePortalService.cancelRequest(
      payload.tenantId,
      payload.userId,
      payload.requestId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.LIST_ALL_REQUESTS)
  handleListAllEmployeeRequests(@Payload() payload: GetEmployeeRequestsMessageDto) {
    return this.employeePortalService.listAllRequests(payload.tenantId, payload.query, {
      userId: payload.actorUserId,
      email: payload.actorEmail,
    });
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_REQUEST_STATS)
  handleGetEmployeeRequestStats(@Payload() payload: TenantIdDto) {
    return this.employeePortalService.getRequestStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.DECIDE_REQUEST)
  handleDecideEmployeeRequest(@Payload() payload: DecideEmployeeRequestMessageDto) {
    return this.employeePortalService.decideRequest(
      payload.tenantId,
      payload.requestId,
      payload.dto,
      payload.actorUserId,
      payload.actorEmail,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_NOTIFICATIONS)
  handleEmployeeNotifications(@Payload() payload: GetMyNotificationsMessageDto) {
    return this.employeePortalService.getNotifications(
      payload.tenantId,
      payload.userId,
      payload.query,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.MARK_NOTIFICATION_READ)
  handleEmployeeNotificationRead(@Payload() payload: MyNotificationMessageDto) {
    return this.employeePortalService.markNotificationRead(
      payload.tenantId,
      payload.userId,
      payload.notificationId,
      payload.email,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.MARK_ALL_NOTIFICATIONS_READ)
  handleEmployeeNotificationsReadAll(@Payload() payload: EmployeeActorDto) {
    return this.employeePortalService.markAllNotificationsRead(payload.tenantId, payload.userId, payload.email);
  }
  // ==========================================
  // SUPERADMIN READ MODEL (directory projection)
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.APPLY)
  async handleProjectionApply(
    @Payload() payload: { events?: any[]; markPending?: string },
  ) {
    // An empty batch carrying markPending is a caller telling us its inline
    // apply failed, so the relay should visit that tenant rather than wait
    // for the hourly sweep.
    if (payload?.markPending) {
      await this.directoryProjectionService.markPending(
        payload.markPending,
        'inline apply failed',
      );
      return { applied: 0, skipped: 0, pending: payload.markPending };
    }
    return this.directoryProjectionService.apply(payload?.events ?? []);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.QUERY_DIRECTORY)
  handleProjectionQuery(@Payload() payload: any) {
    return this.directoryProjectionService.queryDirectory(payload ?? {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.DIRECTORY_STATS)
  handleProjectionDirectoryStats() {
    return this.directoryProjectionService.directoryStats();
  }

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.GET_COUNTERS)
  handleProjectionCounters(@Payload() payload: { tenantIds?: string[] }) {
    return this.directoryProjectionService.getCounters(payload?.tenantIds);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.GET_HEALTH)
  handleProjectionHealth() {
    return this.directoryProjectionService.health();
  }

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.GET_LAG)
  handleProjectionLag(@Payload() payload: { tenantId: string }) {
    return this.projectionRelayService.lagFor(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROJECTION.DROP_TENANT)
  async handleProjectionDropTenant(@Payload() payload: { tenantId: string }) {
    await this.directoryProjectionService.dropTenant(payload.tenantId);
    return { dropped: true, tenantId: payload.tenantId };
  }

  // ==========================================
  // HR PORTAL — dashboard, reports, invitations
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_DASHBOARD)
  handleHrDashboard(@Payload() payload: HrDashboardMessageDto) {
    return this.hrDashboardService.getDashboard(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_ADMIN_OVERVIEW)
  handleAdminDashboardOverview(@Payload() payload: AdminDashboardMessageDto) {
    return this.hrDashboardService.getAdminOverview(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_INSIGHTS)
  handleHrDashboardInsights(@Payload() payload: TenantIdDto) {
    return this.hrDashboardService.getInsights(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_STATS)
  handleHrDashboardStats(@Payload() payload: TenantIdDto) {
    return this.hrDashboardService.getStats(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_LEAVE_APPROVALS)
  handleHrLeaveApprovals(@Payload() payload: LeaveApprovalsMessageDto) {
    return this.hrDashboardService.getLeaveApprovals(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_ONBOARDING_MATRIX)
  handleHrOnboardingMatrix(@Payload() payload: OnboardingMatrixMessageDto) {
    return this.hrDashboardService.getOnboardingMatrix(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_REPORT_TEMPLATES)
  handleHrReportTemplates(@Payload() payload: TenantIdDto) {
    return this.hrReportsService.getTemplates(payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GENERATE_REPORT)
  handleGenerateHrReport(@Payload() payload: GenerateHrReportMessageDto) {
    return this.hrReportsService.generate(payload.tenantId, payload.dto, payload.actorUserId);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.EXPORT_REPORT)
  handleExportHrReport(@Payload() payload: GenerateHrReportMessageDto) {
    return this.hrReportsService.export(payload.tenantId, payload.dto, payload.actorUserId);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.INVITE_EMPLOYEE)
  handleInviteEmployee(@Payload() payload: InviteEmployeeMessageDto) {
    return this.employeeInvitationService.invite(
      payload.tenantId,
      payload.dto,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.GET_INVITATIONS)
  handleGetEmployeeInvitations(@Payload() payload: GetEmployeeInvitationsMessageDto) {
    return this.employeeInvitationService.list(payload.tenantId, payload.query);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.RESEND_INVITATION)
  handleResendEmployeeInvitation(@Payload() payload: EmployeeInvitationIdMessageDto) {
    return this.employeeInvitationService.resend(
      payload.tenantId,
      payload.invitationId,
      payload.actorUserId,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.REVOKE_INVITATION)
  handleRevokeEmployeeInvitation(@Payload() payload: EmployeeInvitationIdMessageDto) {
    return this.employeeInvitationService.revoke(payload.tenantId, payload.invitationId);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.VALIDATE_INVITATION)
  handleValidateEmployeeInvitation(@Payload() payload: { token: string }) {
    return this.employeeInvitationService.validate(payload.token);
  }

  @MessagePattern(MESSAGE_PATTERNS.HR_PORTAL.ACCEPT_INVITATION)
  handleAcceptEmployeeInvitation(@Payload() payload: { dto: AcceptEmployeeInvitationDto }) {
    return this.employeeInvitationService.accept(payload.dto);
  }
}
