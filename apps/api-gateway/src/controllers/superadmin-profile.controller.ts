import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Inject,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  PlatformRoute,
  UpdateProfileDto,
  UpdateAvatarDto,
  ChangePasswordDto,
  UpdateRecoveryDto,
  ToggleTwoFactorDto,
  GenerateTwoFactorDto,
  UpdateNotificationsDto,
} from '@app/common';
import { JwtAuthGuard, TenantGuard, RolesGuard, Roles, CurrentUser, SuperAdminGuard } from '@app/tenant-context';

@Controller(['profile', 'superadmin/profile'])
@PlatformRoute()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, SuperAdminGuard)
@Roles('superadmin')
@ApiBearerAuth()
export class SuperAdminProfileController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  // ==========================================
  // 1. PERSONAL INFORMATION & PROFILE
  // ==========================================

  @ApiTags(TAGS.SA_PROFILE)
  @Get()
  @ApiOperation({ summary: 'Get SuperAdmin Profile Details' })
  getProfile(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GET_PROFILE, {
      superAdminId: superAdminId || 'default-superadmin-id',
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Patch()
  @ApiOperation({ summary: 'Update SuperAdmin Profile Information' })
  updateProfile(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.UPDATE_PROFILE, {
      superAdminId: superAdminId || 'default-superadmin-id',
      dto,
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Post('avatar')
  @Patch('avatar')
  @ApiOperation({ summary: 'Update SuperAdmin Profile Avatar (Supports File Upload or Avatar URL)' })
  @UseInterceptors(FileInterceptor('file'))
  async updateAvatar(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: UpdateAvatarDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    let finalAvatarUrl = dto.avatarUrl;

    if (file) {
      const uploadRes: any = await this.authClient
        .send(MESSAGE_PATTERNS.FILE.UPLOAD_FILE, {
          file: {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          },
          tenantId: 'platform',
          uploadedBy: superAdminId || 'default-superadmin-id',
          category: 'avatar',
          entityType: 'SuperAdmin',
          entityId: superAdminId || 'default-superadmin-id',
          isPublic: true,
        })
        .toPromise();

      if (uploadRes && uploadRes.data && uploadRes.data.accessUrl) {
        finalAvatarUrl = uploadRes.data.accessUrl;
      }
    }

    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.UPDATE_AVATAR, {
      superAdminId: superAdminId || 'default-superadmin-id',
      avatarUrl: finalAvatarUrl,
    });
  }

  // ==========================================
  // 2. SECURITY, PASSWORD & 2FA
  // ==========================================

  @ApiTags(TAGS.SA_PROFILE)
  @Get('security')
  @ApiOperation({ summary: 'Get SuperAdmin Security Overview' })
  getSecuritySettings(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GET_SECURITY, {
      superAdminId: superAdminId || 'default-superadmin-id',
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Get('security/login-activity')
  @ApiOperation({ summary: 'Get SuperAdmin Recent Login Activity History' })
  getLoginActivity(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GET_LOGIN_ACTIVITY, {
      superAdminId: superAdminId || 'default-superadmin-id',
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Get('security/recovery-info')
  @ApiOperation({ summary: 'Get Account Recovery Email and Phone' })
  getRecoveryInfo(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GET_RECOVERY, {
      superAdminId: superAdminId || 'default-superadmin-id',
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Patch('security/recovery-info')
  @Patch('recovery')
  @ApiOperation({ summary: 'Update Account Recovery Email and Phone' })
  updateRecovery(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: UpdateRecoveryDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.UPDATE_RECOVERY, {
      superAdminId: superAdminId || 'default-superadmin-id',
      dto,
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Post('security/change-password')
  @Patch('security/change-password')
  @Patch('password')
  @ApiOperation({ summary: 'Change SuperAdmin Password' })
  changePassword(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.CHANGE_PASSWORD, {
      superAdminId: superAdminId || 'default-superadmin-id',
      dto,
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Post('2fa/generate')
  @ApiOperation({
    summary: 'Generate TOTP Secret & QR Code for 2FA Setup',
    description:
      'When 2FA is already enabled, a current authenticator code must be supplied to rotate the secret.',
  })
  generateTwoFactor(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: GenerateTwoFactorDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GENERATE_2FA, {
      superAdminId: superAdminId || 'default-superadmin-id',
      code: dto?.code,
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Post('2fa/enable')
  @ApiOperation({ summary: 'Verify OTP & Enable Two-Factor Authentication' })
  enableTwoFactor(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: ToggleTwoFactorDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.ENABLE_2FA, {
      superAdminId: superAdminId || 'default-superadmin-id',
      dto,
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Post('2fa/disable')
  @ApiOperation({ summary: 'Disable Two-Factor Authentication' })
  disableTwoFactor(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: ToggleTwoFactorDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.DISABLE_2FA, {
      superAdminId: superAdminId || 'default-superadmin-id',
      dto,
    });
  }

  // ==========================================
  // 3. NOTIFICATION PREFERENCES
  // ==========================================

  @ApiTags(TAGS.SA_PROFILE)
  @Get('notifications')
  @ApiOperation({ summary: 'Get SuperAdmin Notification Preferences & Quiet Hours' })
  getNotificationPreferences(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GET_NOTIFICATIONS, {
      superAdminId: superAdminId || 'default-superadmin-id',
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Patch('notifications')
  @ApiOperation({ summary: 'Update SuperAdmin Notification Preferences & Quiet Hours' })
  updateNotificationPreferences(
    @CurrentUser('id') superAdminId: string,
    @Body() dto: UpdateNotificationsDto,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.UPDATE_NOTIFICATIONS, {
      superAdminId: superAdminId || 'default-superadmin-id',
      dto,
    });
  }

  // ==========================================
  // 4. SESSION MANAGEMENT
  // ==========================================

  @ApiTags(TAGS.SA_PROFILE)
  @Get('sessions')
  @ApiOperation({ summary: 'Get Active & Logged-out User Sessions' })
  getActiveSessions(@CurrentUser('id') superAdminId: string, @CurrentUser('sid') currentSessionId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.GET_SESSIONS, {
      superAdminId: superAdminId || 'default-superadmin-id',
      // From the access token, so the caller's own row renders as "Current".
      currentSessionId,
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Delete(['sessions/revoke-others', 'sessions/others'])
  @ApiOperation({ summary: 'Revoke All Other Active Sessions' })
  revokeAllOtherSessions(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.REVOKE_OTHER_SESSIONS, {
      superAdminId: superAdminId || 'default-superadmin-id',
    });
  }

  @ApiTags(TAGS.SA_PROFILE)
  @Delete('sessions/:sessionId')
  @ApiOperation({ summary: 'Revoke a Specific Active Session' })
  revokeSession(
    @CurrentUser('id') superAdminId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PROFILE.REVOKE_SESSION, {
      superAdminId: superAdminId || 'default-superadmin-id',
      sessionId,
    });
  }
}
