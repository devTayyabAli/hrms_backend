import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, ClientProxy, Transport } from '@nestjs/microservices';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SERVICES, ResilientClientProxy } from '@app/common';
import {
  TenantContextModule,
  TenantResolverMiddleware,
  TenantContextService,
  MicroserviceSigningService,
} from '@app/tenant-context';
import { ApiGatewayAuthController } from './controllers/auth.controller';
import { SuperAdminController } from './controllers/superadmin.controller';
import { SuperAdminProfileController } from './controllers/superadmin-profile.controller';
import { SuperAdminNotificationsController } from './controllers/superadmin-notifications.controller';
import { SessionActivityController } from './controllers/session-activity.controller';
import { SuperAdminAiController } from './controllers/superadmin-ai.controller';
import { AiAssistantService } from './ai-assistant/ai-assistant.service';
import { FilesController } from './controllers/files.controller';
import { OrganizationAdminActivationController } from './controllers/activation.controller';
import { OrganizationSetupController } from './controllers/organization-setup.controller';
import { OrganizationProfileController } from './controllers/organization-profile.controller';
import { OrganizationDepartmentsController } from './controllers/organization-departments.controller';
import { EmployeesController } from './controllers/employees.controller';
import { LeaveRequestsController } from './controllers/leave-requests.controller';
import { RecruitmentController } from './controllers/recruitment.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import { AttendanceController } from './controllers/attendance.controller';
import { OrganizationPolicyController } from './controllers/organization-policy.controller';
import { OrganizationModulesController } from './controllers/organization-modules.controller';
import { OrganizationRolesController } from './controllers/organization-roles.controller';
import { OrganizationBillingController } from './controllers/organization-billing.controller';
import { PerformanceController } from './controllers/performance.controller';
import { PayrollController } from './controllers/payroll.controller';
import { PayrollComplianceController } from './controllers/payroll-compliance.controller';
import { PayrollCompensationController } from './controllers/payroll-compensation.controller';
import { EmployeePortalController, EmployeePortalReviewController } from './controllers/employee-portal.controller';
import { WorkspaceController, WorkspaceSelfController } from './controllers/workspace.controller';
import { CompanyDocumentsController } from './controllers/company-documents.controller';
import {
  HrPortalController,
  HrReportsController,
  EmployeeInvitationController,
  EmployeeActivationController,
} from './controllers/hr-portal.controller';
import { ApiGatewayHealthController } from './controllers/health.controller';
import { IpAllowlistGuard } from './guards/ip-allowlist.guard';
import { MaintenanceModeGuard } from './guards/maintenance-mode.guard';
import { ExportPolicyGuard } from './guards/export-policy.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.development', '.env'] }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 100,
      },
    ]),
    TenantContextModule,
    // Raw TCP clients, registered under internal tokens. Controllers never
    // inject these directly — they get the resilient-wrapped versions below,
    // provided under the SERVICES.* tokens instead (see `providers`).
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
        name: 'TENANT_SERVICE_RAW',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: config.get('TENANT_SERVICE_HOST', '127.0.0.1'),
            port: config.get('TENANT_SERVICE_PORT', 3002),
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
  controllers: [
    ApiGatewayHealthController,
    ApiGatewayAuthController,
    SuperAdminController,
    SuperAdminAiController,
    SuperAdminProfileController,
    SuperAdminNotificationsController,
    SessionActivityController,
    FilesController,
    OrganizationAdminActivationController,
    // Declared before OrganizationSetupController so the admin Departments
    // routes are matched ahead of the wizard's `departments/:id` pattern.
    // Their paths are all deeper than it, so this is belt-and-braces rather
    // than load-bearing — but it keeps the intent obvious if either side
    // grows a route later.
    OrganizationDepartmentsController,
    EmployeesController,
    LeaveRequestsController,
    RecruitmentController,
    OnboardingController,
    AttendanceController,
    OrganizationSetupController,
    OrganizationProfileController,
    OrganizationPolicyController,
    OrganizationModulesController,
    OrganizationRolesController,
    OrganizationBillingController,
    PerformanceController,
    PayrollController,
    PayrollComplianceController,
    PayrollCompensationController,
    EmployeePortalController,
    WorkspaceController,
    WorkspaceSelfController,
    CompanyDocumentsController,
    EmployeePortalReviewController,
    HrPortalController,
    HrReportsController,
    EmployeeInvitationController,
    EmployeeActivationController,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
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
          // Signs every outgoing message, so the receiving service can tell
          // a call that came through this gateway from one sent straight to
          // its TCP port. See RpcSignatureGuard.
          signPayload: (data) => signing.signInPlace(data),
        }),
    },
    {
      provide: SERVICES.TENANT_SERVICE,
      inject: ['TENANT_SERVICE_RAW', TenantContextService, MicroserviceSigningService],
      useFactory: (
        client: ClientProxy,
        tenantContext: TenantContextService,
        signing: MicroserviceSigningService,
      ) =>
        new ResilientClientProxy(client, {
          serviceName: 'Tenant service',
          timeoutMs: 60000,
          getCorrelationId: () => tenantContext.getContext()?.requestId,
          // Signs every outgoing message, so the receiving service can tell
          // a call that came through this gateway from one sent straight to
          // its TCP port. See RpcSignatureGuard.
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
          // Signs every outgoing message, so the receiving service can tell
          // a call that came through this gateway from one sent straight to
          // its TCP port. See RpcSignatureGuard.
          signPayload: (data) => signing.signInPlace(data),
        }),
    },
    IpAllowlistGuard,
    AiAssistantService,
    {
      // Global so maintenance mode covers every tenant-facing route at once;
      // the guard itself exempts /superadmin, /profile and /health.
      provide: APP_GUARD,
      useClass: MaintenanceModeGuard,
    },
    {
      // System Management › General › "Allow users to export data".
      provide: APP_GUARD,
      useClass: ExportPolicyGuard,
    },
  ],
})
export class ApiGatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Assigns/propagates the correlation ID (x-correlation-id / x-request-id),
    // logs the request in and out, and threads it through AsyncLocalStorage
    // (tenantStorage) so it's available anywhere in the request lifecycle —
    // including ResilientClientProxy, which stamps it on every downstream
    // microservice call log. This is the actual HTTP entry point of the
    // system, so this is where a correlation ID must originate.
    consumer.apply(TenantResolverMiddleware).forRoutes('*');
  }
}
