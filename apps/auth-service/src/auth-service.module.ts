import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClientsModule, ClientProxy, Transport } from '@nestjs/microservices';

import { DatabaseModule } from '@app/database';
import { SERVICES, ResilientClientProxy } from '@app/common';
import {
  TenantContextModule,
  TenantContextService,
  MicroserviceSigningService,
  RpcSignatureGuard,
  requireJwtSecret,
} from '@app/tenant-context';

import { AuthService } from './services/auth.service';
import { OtpService } from './services/otp.service';
import { ProfileService } from './services/profile.service';
import { TenantProfileService } from './services/tenant-profile.service';
import { MailService } from './services/mail.service';
import { FileStorageService } from './services/file-storage.service';
import { AuditService } from './services/audit.service';
import { PlatformSettingsService } from './services/platform-settings.service';
import { GeneralSettingsService } from './services/general-settings.service';
import { SecuritySettingsService } from './services/security-settings.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { CustomDomainsService } from './services/custom-domains.service';
import { MaintenanceSettingsService } from './services/maintenance-settings.service';
import { AccountLockoutService } from './services/account-lockout.service';
import { HelpSupportService } from './services/help-support.service';
import { AiConversationService } from './services/ai-conversation.service';
import { PlatformNotificationService } from './services/platform-notification.service';
import { PlatformSchemaService } from './services/platform-schema.service';

import { AuthMicroserviceController } from './controllers/auth.controller';

import {
  SuperAdmin,
  AuthCredential,
  NotificationPreferences,
  UserSession,
  FileMetadata,
  AuditLog,
  PlatformSetting,
  PlatformSettings,
  SecuritySettings,
  AllowedIpAddress,
  PlatformDomain,
  MaintenanceSettings,
  SupportTicket,
  KnowledgeBaseArticle,
  VideoTutorial,
  AiConversation,
  PlatformNotification,
  PushSubscription,
} from './models';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
    }),

    DatabaseModule.forRoot({
      isPlatform: true,
    }),

    SequelizeModule.forFeature([
      SuperAdmin,
      AuthCredential,
      NotificationPreferences,
      UserSession,
      FileMetadata,
      AuditLog,
      PlatformSetting,
      PlatformSettings,
      SecuritySettings,
      AllowedIpAddress,
      PlatformDomain,
      MaintenanceSettings,
      SupportTicket,
      KnowledgeBaseArticle,
      VideoTutorial,
      AiConversation,
      PlatformNotification,
      PushSubscription,
    ]),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: requireJwtSecret(config),

        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRY', '15m') as any,
        },
      }),
    }),

    TenantContextModule,

    ClientsModule.registerAsync([
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
      provide: APP_GUARD,
      useClass: RpcSignatureGuard,
    },
    {
      // Resolves a tenant user's role permissions into their access token.
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

    AuthService,
    OtpService,
    ProfileService,
    TenantProfileService,
    MailService,
    FileStorageService,
    AuditService,
    PlatformSettingsService,
    GeneralSettingsService,
    SecuritySettingsService,
    PasswordPolicyService,
    CustomDomainsService,
    MaintenanceSettingsService,
    AccountLockoutService,
    HelpSupportService,
    AiConversationService,
    PlatformNotificationService,
    PlatformSchemaService,
  ],

  controllers: [AuthMicroserviceController],

  exports: [
    AuthService,
    OtpService,
    ProfileService,
    TenantProfileService,
    MailService,
    FileStorageService,
    AuditService,
    PlatformSettingsService,
    GeneralSettingsService,
    SecuritySettingsService,
    PasswordPolicyService,
    CustomDomainsService,
    MaintenanceSettingsService,
    AccountLockoutService,
    HelpSupportService,
    JwtModule,
  ],
})
export class AuthServiceModule {}