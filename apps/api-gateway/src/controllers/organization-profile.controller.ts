import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Inject,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  UpdateTenantProfileDto,
  ChangePasswordDto,
  UpdateAvatarDto,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  CurrentUser,
} from '@app/tenant-context';

/**
 * A signed-in tenant user's own account — org admin today, HR and Employee
 * once their own login exists. Deliberately carries no
 * `@RequirePermissions`/`@RequireModule` on any route (unlike every other
 * controller under `organization/*`): this is self-service on your own
 * record, not a permissioned resource, so every tenant role should reach it.
 * `RolesGuard`/`PermissionsGuard` stay in the stack for consistency with the
 * rest of this controller group — they pass every request through when no
 * decorator supplies requirements, same as `OrganizationSetupController`'s
 * `GET organization/branding`.
 */
@Controller('organization/profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard)
export class OrganizationProfileController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  /**
   * Where "my avatar" lives depends on the role: an Admin has no `Employee`
   * row (that flow only creates a `User` + `AuthCredential`), so its photo
   * lives on `Tenant.adminAvatarUrl` — the same field the SuperAdmin's
   * Organizations list reads for this admin's photo. HR and Employee accounts
   * DO have an `Employee` row (that's what the Employees list itself reads),
   * so their photo has to write there instead — writing the tenant-wide
   * admin field for every role was the bug: any signed-in user's upload
   * clobbered the one Admin's photo, and never reached the Employees list.
   */
  private isAdminRole(role: string | undefined): boolean {
    return (role || '').toUpperCase().includes('ADMIN');
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Get()
  @ApiOperation({
    summary: 'Get my own account — name, email, phone, security status, avatar',
  })
  async getProfile(
    @CurrentUser('id') authCredentialId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('email') email: string,
    @CurrentUser('role') role: string,
  ) {
    const avatarPattern = this.isAdminRole(role)
      ? MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_ADMIN_AVATAR
      : MESSAGE_PATTERNS.EMPLOYEE.GET_MY_AVATAR;
    const avatarPayload = this.isAdminRole(role)
      ? { tenantId }
      : { tenantId, email };

    const [profile, avatar] = await Promise.all([
      firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.TENANT_PROFILE.GET_PROFILE, {
          authCredentialId,
          tenantId,
        }),
      ),
      firstValueFrom(this.tenantClient.send(avatarPattern, avatarPayload)),
    ]);

    return { ...profile, avatarUrl: avatar?.avatarUrl ?? null };
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Patch('avatar')
  @ApiOperation({
    summary:
      'Update my own profile photo (upload via files/upload first, then pass its accessUrl)',
  })
  updateAvatar(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('email') email: string,
    @CurrentUser('role') role: string,
    @Body() dto: UpdateAvatarDto,
  ) {
    if (this.isAdminRole(role)) {
      return this.tenantClient.send(
        MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_ADMIN_AVATAR,
        {
          tenantId,
          avatarUrl: dto.avatarUrl,
        },
      );
    }
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.UPDATE_MY_AVATAR, {
      tenantId,
      email,
      avatarUrl: dto.avatarUrl,
    });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Patch()
  @ApiOperation({ summary: 'Update my own name and phone' })
  updateProfile(
    @CurrentUser('id') authCredentialId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: UpdateTenantProfileDto,
  ) {
    return this.authClient.send(
      MESSAGE_PATTERNS.TENANT_PROFILE.UPDATE_PROFILE,
      {
        authCredentialId,
        tenantId,
        dto,
      },
    );
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Post('change-password')
  @ApiOperation({ summary: 'Change my own password' })
  changePassword(
    @CurrentUser('id') authCredentialId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authClient.send(
      MESSAGE_PATTERNS.TENANT_PROFILE.CHANGE_PASSWORD,
      {
        authCredentialId,
        tenantId,
        dto,
      },
    );
  }
}
