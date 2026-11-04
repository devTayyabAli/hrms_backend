import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClientsModule, ClientProxy, Transport } from '@nestjs/microservices';
import {
  DatabaseModule,
  PlatformDirectoryPerson,
  PlatformProjectionSignal,
  PlatformTenantCounters,
} from '@app/database';
import {
  TenantContextModule,
  TenantContextService,
  MicroserviceSigningService,
  RpcSignatureGuard,
  RpcActorInterceptor,
} from '@app/tenant-context';
import { DataScopeService } from './services/data-scope.service';
import { SERVICES, ResilientClientProxy } from '@app/common';
import { TenantService } from './services/tenant.service';
import { TenantDatabaseConfigService } from './services/tenant-database-config.service';
import { TenantProvisioningService } from './services/tenant-provisioning.service';
import { OrganizationAdminInvitationService } from './services/organization-admin-invitation.service';
import { EmployeeInvitationService } from './services/employee-invitation.service';
import { OrganizationSetupService } from './services/organization-setup.service';
import { PolicyConfigurationValidatorService } from './services/policy-configuration-validator.service';
import { OrganizationPolicyService } from './services/organization-policy.service';
import { IndustryTemplateService } from './services/industry-template.service';
import { OrganizationModuleAccessService } from './services/organization-module-access.service';
import { OrganizationOnboardingValidatorService } from './services/organization-onboarding-validator.service';
import { PlatformOrganizationsService } from './services/platform-organizations.service';
import { PlatformStatusService } from './services/platform-status.service';
import { BackupService } from './services/backup.service';
import { PlatformBillingService } from './services/platform-billing.service';
import { TenantModelProviderService } from './services/tenant-model-provider.service';
import { TenantServiceController } from './tenant-service.controller';
import {
  Tenant,
  TenantDatabaseConfig,
  OrganizationAdminInvitation,
  EmployeeInvitationLookup,
  Plan,
  Subscription,
  Payment,
  Invoice,
  BillingEvent,
  CustomReport,
  ReportRun,
  BackupSettings,
  BackupRecord,
  PlatformHealthSample,
} from './models';
import { PlatformReportsService } from './services/platform-reports.service';
import { PlatformSchemaService } from './services/platform-schema.service';
import { EmployeeService } from './services/employee.service';
import { AttendanceService } from './services/attendance.service';
import { OrganizationDepartmentsService } from './services/organization-departments.service';
import { OrganizationHierarchyService } from './services/organization-hierarchy.service';
import { LeaveRequestService } from './services/leave-request.service';
import { LeaveBalanceService } from './services/leave-balance.service';
import { ShiftService } from './services/shift.service';
import { ChatService } from './services/chat.service';
import { AssetService } from './services/asset.service';
import { WorkspaceAccessService } from './services/workspace-access.service';
import { LearningCourseService } from './services/learning-course.service';
import { LearningAssignmentService } from './services/learning-assignment.service';
import { LearningSelfService } from './services/learning-self.service';
import { LearningNotificationService } from './services/learning-notification.service';
import { LearningRecommendationService } from './services/learning-recommendation.service';
import { LearningReportService } from './services/learning-report.service';
import { LearningReminderScheduler } from './services/learning-reminder.scheduler';
import { AssetSelfService } from './services/asset-self.service';
import { AssetRequestService } from './services/asset-request.service';
import { AssetClearanceService } from './services/asset-clearance.service';
import { JobOpeningService } from './services/job-opening.service';
import { WorkspaceTaskService } from './services/workspace-task.service';
import { WorkspaceDashboardService } from './services/workspace-dashboard.service';
import { WorkspaceProjectService } from './services/workspace-project.service';
import { PlatformNotifierService } from './services/platform-notifier.service';
import { PlatformClientContactsService } from './services/platform-client-contacts.service';
import { CalendarService } from './services/calendar.service';
import { CompanyDocumentService } from './services/company-document.service';
import { CandidateService } from './services/candidate.service';
import { InterviewService } from './services/interview.service';
import { RecruitmentOverviewService } from './services/recruitment-overview.service';
import { RecruitmentActivityService } from './services/recruitment-activity.service';
import { OnboardingService } from './services/onboarding.service';
import { OnboardingTaskService } from './services/onboarding-task.service';
import { SubscriptionLimitService } from './services/subscription-limit.service';
import { BillingScheduler } from './services/billing.scheduler';
import { AttendanceAutoCheckoutScheduler } from './services/attendance-auto-checkout.scheduler';
import { WorkspaceReminderScheduler } from './services/workspace-reminder.scheduler';
import { PerformanceDashboardService } from './services/performance-dashboard.service';
import { PerformanceSelfService } from './services/performance-self.service';
import { PolicyAcknowledgementService } from './services/policy-acknowledgement.service';
import { ApprovalPolicyService } from './services/approval-policy.service';
import { PermissionHoldersService } from './services/permission-holders.service';
import { BranchService } from './services/branch.service';
import { HelpdeskService } from './services/helpdesk.service';
import { EmployeeAssignmentService } from './services/employee-assignment.service';
import { DepartmentChecklistService } from './services/department-checklist.service';
import { PerformanceCycleService } from './services/performance-cycle.service';
import { KpiTemplateService } from './services/kpi-template.service';
import { PerformancePlanService } from './services/performance-plan.service';
import { PerformanceSyncService } from './services/performance-sync.service';
import { ReviewRolesService } from './services/review-roles.service';
import { PerformanceEvaluatorService } from './services/performance-evaluator.service';
import { PerformancePipService } from './services/performance-pip.service';
import { PerformanceDevelopmentService } from './services/performance-development.service';
import { PerformanceAcknowledgementService } from './services/performance-acknowledgement.service';
import { OffboardingService } from './services/offboarding.service';
import { FinalSettlementService } from './services/final-settlement.service';
import { RoleDashboardService } from './services/role-dashboard.service';
import { PolicyAckReminderScheduler } from './services/policy-ack-reminder.scheduler';
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

import { InternalPaymentProvider } from './billing/providers/internal/internal-payment.provider';
import { PaymentProviderFactory } from './billing/providers/payment-provider.factory';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
    }),
    DatabaseModule.forRoot({ isPlatform: true }),
    SequelizeModule.forFeature([
      Tenant,
      TenantDatabaseConfig,
      OrganizationAdminInvitation,
      EmployeeInvitationLookup,
      Plan,
      Subscription,
      Payment,
      Invoice,
      BillingEvent,
      CustomReport,
      ReportRun,
      BackupSettings,
      BackupRecord,
      PlatformHealthSample,
      // SuperAdmin read model. Lives in the platform DB; tenant-service is
      // its only writer, user-service reads it.
      PlatformDirectoryPerson,
      PlatformTenantCounters,
      PlatformProjectionSignal,
    ]),
    TenantContextModule,
    ClientsModule.registerAsync([
      {
        name: 'AUTH_SERVICE_RAW',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: config.get('AUTH_SERVICE_HOST', '127.0.0.1'),
            port: config.get('AUTH_SERVICE_PORT', 3001),
          },
        }),
      },
      {
        name: 'USER_SERVICE_RAW',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: config.get('USER_SERVICE_HOST', '127.0.0.1'),
            port: config.get('USER_SERVICE_PORT', 3003),
          },
        }),
      },
    ]),
  ],
  providers: [
    {
      // Global so every @MessagePattern in this service requires a valid
      // signature. The point of the guard is that it cannot be forgotten on
      // a new handler — per-handler signing had reached 13 of ~260 patterns,
      // which is why this port was effectively an unauthenticated admin API
      // over tenant provisioning, billing and every tenant's employee data.
      provide: APP_GUARD,
      useClass: RpcSignatureGuard,
    },
    {
      // Makes the signed caller (and their team/department data scope)
      // available to every handler — see DataScopeService.
      provide: APP_INTERCEPTOR,
      useClass: RpcActorInterceptor,
    },
    DataScopeService,
    PlatformSchemaService,
    {
      // Wrapped rather than injected raw, for two reasons the audit raised
      // separately: service-to-service calls had no timeout, retry or
      // circuit breaker of their own, and they were unsigned — so every
      // internal hop was both unbounded and indistinguishable from a
      // stranger connecting to the port.
      provide: SERVICES.AUTH_SERVICE,
      inject: [
        'AUTH_SERVICE_RAW',
        TenantContextService,
        MicroserviceSigningService,
      ],
      useFactory: (
        client: ClientProxy,
        tenantContext: TenantContextService,
        signing: MicroserviceSigningService,
      ) =>
        new ResilientClientProxy(client, {
          serviceName: 'Auth service',
          getCorrelationId: () => tenantContext.getContext()?.requestId,
          signPayload: (data) => signing.signInPlace(data),
        }),
    },
    {
      provide: SERVICES.USER_SERVICE,
      inject: [
        'USER_SERVICE_RAW',
        TenantContextService,
        MicroserviceSigningService,
      ],
      useFactory: (
        client: ClientProxy,
        tenantContext: TenantContextService,
        signing: MicroserviceSigningService,
      ) =>
        new ResilientClientProxy(client, {
          serviceName: 'User service',
          getCorrelationId: () => tenantContext.getContext()?.requestId,
          signPayload: (data) => signing.signInPlace(data),
        }),
    },
    TenantService,
    TenantDatabaseConfigService,
    TenantProvisioningService,
    OrganizationAdminInvitationService,
    OrganizationSetupService,
    PolicyConfigurationValidatorService,
    OrganizationPolicyService,
    IndustryTemplateService,
    OrganizationModuleAccessService,
    OrganizationOnboardingValidatorService,
    PlatformOrganizationsService,
    PlatformStatusService,
    BackupService,
    PlatformBillingService,
    SubscriptionLimitService,
    BillingScheduler,
    InternalPaymentProvider,
    PaymentProviderFactory,
    TenantModelProviderService,
    PlatformReportsService,
    EmployeeInvitationService,
    EmployeeService,
    AttendanceService,
    AttendanceAutoCheckoutScheduler,
    WorkspaceReminderScheduler,
    OrganizationDepartmentsService,
    OrganizationHierarchyService,
    LeaveRequestService,
    LeaveBalanceService,
    ShiftService,
    ChatService,
    AssetService,
    WorkspaceAccessService,
    LearningCourseService,
    LearningAssignmentService,
    LearningSelfService,
    LearningNotificationService,
    LearningRecommendationService,
    LearningReportService,
    LearningReminderScheduler,
    AssetSelfService,
    AssetRequestService,
    AssetClearanceService,
    WorkspaceTaskService,
    WorkspaceProjectService,
    WorkspaceDashboardService,
    PlatformNotifierService,
    PlatformClientContactsService,
    CalendarService,
    CompanyDocumentService,
    JobOpeningService,
    CandidateService,
    InterviewService,
    RecruitmentOverviewService,
    RecruitmentActivityService,
    OnboardingService,
    OnboardingTaskService,
    PerformanceDashboardService,
    PerformanceSelfService,
    PolicyAcknowledgementService,
    ApprovalPolicyService,
    PermissionHoldersService,
    BranchService,
    HelpdeskService,
    EmployeeAssignmentService,
    DepartmentChecklistService,
    PerformanceCycleService,
    KpiTemplateService,
    PerformancePlanService,
    PerformanceSyncService,
    ReviewRolesService,
    PerformanceEvaluatorService,
    PerformancePipService,
    PerformanceDevelopmentService,
    PerformanceAcknowledgementService,
    OffboardingService,
    FinalSettlementService,
    RoleDashboardService,
    PolicyAckReminderScheduler,
    PayrollDashboardService,
    EmployeePortalService,
    MyTeamService,
    PayslipService,
    PayrollComplianceService,
    PayrollCompensationService,
    HrDashboardService,
    HrReportsService,
    DirectoryProjectionService,
    ProjectionRelayService,
  ],
  controllers: [TenantServiceController],
  exports: [
    TenantService,
    TenantDatabaseConfigService,
    TenantProvisioningService,
    OrganizationAdminInvitationService,
    OrganizationSetupService,
    PolicyConfigurationValidatorService,
    OrganizationPolicyService,
    IndustryTemplateService,
    OrganizationModuleAccessService,
    OrganizationOnboardingValidatorService,
    PlatformOrganizationsService,
    PlatformStatusService,
    BackupService,
    PlatformBillingService,
    SubscriptionLimitService,
    BillingScheduler,
    InternalPaymentProvider,
    PaymentProviderFactory,
    TenantModelProviderService,
    PlatformReportsService,
  ],
})
export class TenantServiceModule {}
