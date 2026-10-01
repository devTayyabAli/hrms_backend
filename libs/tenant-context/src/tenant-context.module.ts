import { Module, Global } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TenantContextService } from './context/tenant-context.service';
import { TenantRequestContextService } from './context/tenant-request-context.service';
import { TenantConnectionManager } from './context/tenant-connection.manager';
import { TenantResolverMiddleware } from './middleware/tenant-resolver.middleware';
import { TenantGuard } from './guards/tenant.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { OrganizationModuleGuard } from './guards/organization-module.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { SignedPayloadGuard } from './guards/signed-payload.guard';
import { RpcSignatureGuard } from './guards/rpc-signature.guard';
import { ServiceRolesGuard } from './guards/service-roles.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { requireJwtSecret } from './config/require-jwt-secret';
import { MicroserviceSigningService } from './services/microservice-signing.service';

@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: requireJwtSecret(config),
        signOptions: { expiresIn: '24h' },
      }),
    }),
  ],
  providers: [
    TenantContextService,
    TenantRequestContextService,
    TenantConnectionManager,
    TenantResolverMiddleware,
    TenantGuard,
    RolesGuard,
    PermissionsGuard,
    OrganizationModuleGuard,
    JwtAuthGuard,
    SuperAdminGuard,
    SignedPayloadGuard,
    RpcSignatureGuard,
    ServiceRolesGuard,
    JwtStrategy,
    MicroserviceSigningService,
  ],
  exports: [
    PassportModule,
    JwtModule,
    TenantContextService,
    TenantRequestContextService,
    TenantConnectionManager,
    TenantResolverMiddleware,
    TenantGuard,
    RolesGuard,
    PermissionsGuard,
    OrganizationModuleGuard,
    JwtAuthGuard,
    SuperAdminGuard,
    SignedPayloadGuard,
    RpcSignatureGuard,
    ServiceRolesGuard,
    JwtStrategy,
    MicroserviceSigningService,
  ],
})
export class TenantContextModule {}
