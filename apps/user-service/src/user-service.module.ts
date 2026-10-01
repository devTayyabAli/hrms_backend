import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, ClientProxy, Transport } from '@nestjs/microservices';
import {
  TenantContextModule,
  TenantContextService,
  MicroserviceSigningService,
  RpcSignatureGuard,
} from '@app/tenant-context';
import { SERVICES, ResilientClientProxy } from '@app/common';
import { UserServiceController } from './user-service.controller';
import { UserService } from './services/user.service';
import { RoleService } from './services/role.service';
import { TenantModelProviderService } from './services/tenant-model-provider.service';
import { PermissionRegistryService } from './services/permission-registry.service';
import { PlatformClientsService } from './services/platform-clients.service';
import { DirectoryEmitterService } from './services/directory-emitter.service';

// Note: this service is TCP-only (see main.ts — createMicroservice, no HTTP
// adapter), so Express-style NestMiddleware (consumer.apply(...).forRoutes())
// never runs here — there used to be a TenantResolverMiddleware wired in via
// configure(), but it was dead code. Correlation-id + request logging now
// happens at the API gateway (the actual HTTP entry point); see
// api-gateway.module.ts and MicroserviceLoggingInterceptor for this
// service's own per-message-pattern logging.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.development', '.env'] }),
    TenantContextModule,
    ClientsModule.registerAsync([
      {
        name: 'TENANT_SERVICE_RAW',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: config.get('TENANT_SERVICE_HOST', 'localhost'),
            port: config.get('TENANT_SERVICE_PORT', 3002),
          },
        }),
      },
      {
        name: 'AUTH_SERVICE_RAW',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: config.get('AUTH_SERVICE_HOST', 'localhost'),
            port: config.get('AUTH_SERVICE_PORT', 3001),
          },
        }),
      },
    ]),
  ],
  controllers: [UserServiceController],
  providers: [
    {
      // Global so every @MessagePattern in this service requires a valid
      // signature. The point of the guard is that it cannot be forgotten on
      // a new handler — per-handler signing had reached 13 of ~260 patterns,
      // which is why this port was effectively an unauthenticated admin API.
      provide: APP_GUARD,
      useClass: RpcSignatureGuard,
    },
    {
      // Wrapped rather than injected raw, for two reasons the audit raised
      // separately: service-to-service calls had no timeout, retry or
      // circuit breaker of their own, and they were unsigned — so every
      // internal hop was both unbounded and indistinguishable from a
      // stranger connecting to the port.
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
          signPayload: (data) => signing.signInPlace(data),
        }),
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
          signPayload: (data) => signing.signInPlace(data),
        }),
    },
    TenantModelProviderService,
    PermissionRegistryService,
    UserService,
    RoleService,
    PlatformClientsService,
    DirectoryEmitterService,
  ],
  exports: [
    TenantModelProviderService,
    PermissionRegistryService,
    UserService,
    RoleService,
    PlatformClientsService,
  ],
})
export class UserServiceModule {}
