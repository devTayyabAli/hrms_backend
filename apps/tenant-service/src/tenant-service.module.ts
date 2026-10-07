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
  BackupSettings,
  BackupRecord,
} from './models';
import { PlatformReportsService } from './services/platform-reports.service';
import { EmployeeService } from './services/employee.service';
import { AttendanceService } from './services/attendance.service';
import { OrganizationDepartmentsService } from './services/organization-departments.service';
import { LeaveRequestService } from './services/leave-request.service';
import { JobOpeningService } from './services/job-opening.service';
import { WorkspaceTaskService } from './services/workspace-task.service';
import { WorkspaceProjectService } from './services/workspace-project.service';
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

import { InternalPaymentProvider } from './billing/providers/internal/internal-payment.provider';
import { PaymentProviderFactory } from './billing/providers/payment-provider.factory';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.development', '.env'] }),
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
      BackupSettings,
      BackupRecord,
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
    {
      // Wrapped rather than injected raw, for two reasons the audit raised
      // separately: service-to-service calls had no timeout, retry or
      // circuit breaker of their own, and they were unsigned — so every
      // internal hop was both unbounded and indistinguishable from a
      // stranger connecting to the port.
      provide: SERVICES.AUTH_SERVICE,
      inject: ['AUTH_SERVICE_RAW', TenantContextService, MicroserviceSigningService],
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
      inject: ['USER_SERVICE_RAW', TenantContextService, MicroserviceSigningService],
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
    OrganizationDepartmentsService,
    LeaveRequestService,
    WorkspaceTaskService,
    WorkspaceProjectService,
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
export class TenantServiceModule { }
