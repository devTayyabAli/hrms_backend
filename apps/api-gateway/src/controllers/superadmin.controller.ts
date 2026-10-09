import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Inject,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  SuperAdminLoginDto,
  OnboardOrganizationDto,
  CreateOrganizationDto,
  CreateOrganizationOnboardingDto,
  ValidateOrganizationOnboardingDto,
  UpdateOrganizationModuleAccessDto,
  CreateAdminInvitationDto,
  GetPlatformClientsQueryDto,
  GetRecentPlatformClientsQueryDto,
  UpdatePlatformClientStatusDto,
  GetPlatformOrganizationsQueryDto,
  UpdateOrganizationStatusDto,
  UpdateOrganizationDto,
  DeleteOrganizationDto,
  CreatePlanDto,
  UpdatePlanDto,
  PlanFilterDto,
  SubscriptionQueryDto,
  AuditLogQueryDto,
  GenerateReportDto,
  PlatformGrowthQueryDto,
  TopOrganizationsQueryDto,
  CustomReportQueryDto,
  CreateCustomReportDto,
  UpdateCustomReportDto,
  InitialOrganizationOnboardingDto,
  UpdateGeneralSettingsDto,
  UpdateSecuritySettingsDto,
  AddAllowedIpDto,
  AddDomainDto,
  UpdateDomainDto,
  UpdateBackupSettingsDto,
  GetBackupsQueryDto,
  UpdateMaintenanceSettingsDto,
  GetRecentActivityQueryDto,
  GetArticlesQueryDto,
  CreateArticleDto,
  UpdateArticleDto,
  GetVideosQueryDto,
  CreateVideoTutorialDto,
  UpdateVideoTutorialDto,
  GetSupportTicketsQueryDto,
  CreateSupportTicketDto,
  UpdateSupportTicketDto,
  PlatformRoute,
  Public,
  ResilientClientProxy,
} from '@app/common';
import {
  setRefreshCookie,
  withoutRefreshToken,
} from '../auth/refresh-token-cookie';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  Roles,
  SuperAdminGuard,
  CurrentUser,
} from '@app/tenant-context';
import { IpAllowlistGuard } from '../guards/ip-allowlist.guard';
import { MaintenanceModeGuard } from '../guards/maintenance-mode.guard';
import { ExportPolicyGuard } from '../guards/export-policy.guard';
import { sendFileResponse } from '../utils/file-response.helper';
import { requestLocation } from '../utils/request-location';
import { Audited } from '../audit/audited.decorator';
import { AuditTrailInterceptor } from '../audit/audit-trail.interceptor';

@Controller('superadmin')
@PlatformRoute()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  SuperAdminGuard,
  IpAllowlistGuard,
)
@Roles('superadmin')
@UseInterceptors(AuditTrailInterceptor)
export class SuperAdminController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE)
    private readonly tenantClient: ResilientClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    private readonly ipAllowlist: IpAllowlistGuard,
  ) {}

  /** The address this request came from, as the allowlist sees it. */
  private callerIp(req: Request): string {
    return String(req.ip || req.socket?.remoteAddress || '').replace(
      /^::ffff:(?=\d)/i,
      '',
    );
  }

  @ApiTags(TAGS.SA_AUTH)
  @Post('login')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'SuperAdmin System Login' })
  async superAdminLogin(
    @Body() dto: SuperAdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.SUPERADMIN_LOGIN, {
        dto,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        location: requestLocation(req),
      }),
    );

    // The refresh token leaves as an httpOnly cookie, never in the body — see
    // auth/refresh-token-cookie.ts. A 2FA challenge carries no tokens yet.
    if (!result?.refreshToken) return result;
    setRefreshCookie(res, result.refreshToken);
    return withoutRefreshToken(result);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/onboard')
  @ApiOperation({
    summary: 'Onboard a new organization tenant with isolated database setup',
  })
  @Audited({
    action: 'ORGANIZATION_CREATED',
    module: 'Organizations',
    subject: ({ body }) => body?.organizationName || body?.name,
  })
  onboardOrganization(@Body() dto: OnboardOrganizationDto) {
    return this.authClient.send(
      MESSAGE_PATTERNS.AUTH.ONBOARD_ORGANIZATION,
      dto,
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/validate')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin Step Validation: Validate Organization Onboarding Payload',
  })
  validateOrganizationOnboarding(
    @Body() dto: ValidateOrganizationOnboardingDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.VALIDATE_ONBOARDING,
      dto,
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/review')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin Step 4: Review & Confirm Organization Setup Summary',
  })
  reviewOrganizationOnboarding(@Body() dto: CreateOrganizationOnboardingDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.REVIEW_ONBOARDING,
      dto,
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Create Organization & Provision Isolated Database',
  })
  @Audited({
    action: 'ORGANIZATION_CREATED',
    module: 'Organizations',
    subject: ({ body }) => body?.organizationName || body?.name,
  })
  createOrganization(@Body() dto: CreateOrganizationDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.CREATE_ORGANIZATION,
      dto,
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/create-full')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin Flow: Full Multi-Step Organization Onboarding Creation',
  })
  @Audited({
    action: 'ORGANIZATION_CREATED',
    module: 'Organizations',
    subject: ({ body }) =>
      body?.organizationInfo?.organizationName || body?.organizationName,
  })
  createFullOrganization(@Body() dto: CreateOrganizationOnboardingDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.CREATE_ORGANIZATION,
      dto,
    );
  }

  // ==========================================
  // 3-STEP ORGANIZATION INITIAL CREATION & ONBOARDING
  // ==========================================

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/initial/create')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: 3-Step Organization Creation & Isolated DB Auto-Provisioning',
  })
  @Audited({
    action: 'ORGANIZATION_CREATED',
    module: 'Organizations',
    subject: ({ body }) =>
      body?.organizationInfo?.organizationName || body?.organizationName,
  })
  createInitialOrganization(@Body() dto: InitialOrganizationOnboardingDto) {
    // Returns once the tenant row exists; the database is provisioned in the
    // background (a full schema sync outlives the proxy's 60s timeout).
    // Follow it with GET organizations/:tenantId/creation-status.
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.CREATE_INITIAL,
      dto,
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/:tenantId/creation-status')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Progress of an organization being created (running, done or failed)',
  })
  getOrganizationCreationStatus(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.GET_CREATION_STATUS,
      { tenantId },
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/:tenantId/modules')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Get Organization Module Entitlements & Permissions',
  })
  getOrganizationModules(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.GET_MODULE_ACCESS,
      { tenantId },
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Put('organizations/:tenantId/modules')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update Organization Module Entitlements & Permissions',
  })
  @Audited({
    action: 'ORGANIZATION_MODULES_UPDATED',
    module: 'Organizations',
    tenantParam: 'tenantId',
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
  })
  updateOrganizationModules(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationModuleAccessDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION.UPDATE_MODULE_ACCESS,
      {
        tenantId,
        modules: dto.modules,
      },
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/:tenantId/provision/retry')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Retry Failed Tenant Database Provisioning',
  })
  @Audited({
    action: 'ORGANIZATION_PROVISIONING_RETRIED',
    module: 'Organizations',
    tenantParam: 'tenantId',
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
  })
  retryProvisioning(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.TENANT.RETRY_PROVISION, {
      tenantId,
    });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/:tenantId/invitation')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Generate Organization Admin Invitation',
  })
  @Audited({
    action: 'ADMIN_INVITATION_SENT',
    module: 'Organizations',
    tenantParam: 'tenantId',
    subject: ({ body }) => body?.adminEmail,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
  })
  createAdminInvitation(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateAdminInvitationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INVITATION.CREATE, {
      tenantId,
      dto,
    });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/:tenantId/invitation/resend')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Resend / Replace Organization Admin Invitation',
  })
  @Audited({
    action: 'ADMIN_INVITATION_RESENT',
    module: 'Organizations',
    tenantParam: 'tenantId',
    subject: ({ before }) => before?.primaryAdmin?.email,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
  })
  resendAdminInvitation(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INVITATION.RESEND, {
      tenantId,
    });
  }

  // ==========================================
  // ORGANIZATIONS (platform-wide organization list)
  // NOTE: order matters — 'organizations/stats' must be declared before the
  // dynamic 'organizations/:tenantId' route below so Express doesn't treat
  // "stats" as a tenantId.
  // ==========================================

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Organizations KPI Cards (Total / Active / Trial / Pending / Deactivated)',
  })
  getOrganizationsStats() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_STATS,
      {},
    );
  }

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('organizations/overview')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin Dashboard: organizations registered per month, split by current status',
  })
  @ApiQuery({
    name: 'months',
    required: false,
    description: 'Window in months (1–24, default 6)',
  })
  getOrganizationsOverview(@Query('months') months?: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_OVERVIEW,
      {
        months: Number(months) || 6,
      },
    );
  }

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('organizations/by-plan')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin Dashboard: organization count per plan',
  })
  getOrganizationsByPlan() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_PLAN_BREAKDOWN,
      {},
    );
  }

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('organizations/alerts')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin Dashboard: organization and billing alerts that need action',
  })
  getOrganizationsAlerts() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALERTS,
      {},
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Paginated, filterable list of all Organizations',
  })
  getOrganizations(@Query() query: GetPlatformOrganizationsQueryDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALL,
      query,
    );
  }

  // Declared before 'organizations/:tenantId' so "export" isn't read as an id.
  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/export')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Every organization matching the list filters, as a CSV download',
  })
  @Audited({
    action: 'ORGANIZATIONS_EXPORTED',
    module: 'Organizations',
    subject: ({ result }) =>
      result?.total != null ? `${result.total} organizations` : undefined,
  })
  async exportOrganizations(
    @Query() query: GetPlatformOrganizationsQueryDto,
    @Res() res: Response,
  ) {
    const file: any = await firstValueFrom(
      this.tenantClient.send(
        MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.EXPORT,
        query,
      ),
    );
    res.setHeader(
      'Content-Type',
      file.contentType || 'text/csv; charset=utf-8',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(file.filename).replace(/[^\w.-]+/g, '-')}"`,
    );
    res.send(file.csv);
    return { total: file.total };
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/:tenantId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a single Organization detail' })
  getOrganization(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      { tenantId },
    );
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Patch('organizations/:tenantId/status')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Activate / Deactivate an Organization',
  })
  @Audited({
    action: ({ body }) =>
      body?.status === 'ACTIVE'
        ? 'ORGANIZATION_ACTIVATED'
        : 'ORGANIZATION_DEACTIVATED',
    module: 'Organizations',
    tenantParam: 'tenantId',
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
  })
  async updateOrganizationStatus(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationStatusDto,
  ) {
    const result = await firstValueFrom(
      this.tenantClient.send(
        MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.UPDATE_STATUS,
        {
          tenantId,
          status: dto.status,
        },
      ),
    );
    // Deactivation locks the organization's users out now, not after the guard's cache expires.
    TenantGuard.forgetTenant(tenantId);
    return result;
  }

  // Declared after ':tenantId/status' so the more specific route is matched
  // first, matching how 'organizations/stats' is ordered above.
  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Patch('organizations/:tenantId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update an Organization profile' })
  @Audited({
    action: 'ORGANIZATION_UPDATED',
    module: 'Organizations',
    tenantParam: 'tenantId',
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
    diff: true,
  })
  updateOrganization(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.UPDATE,
      {
        tenantId,
        dto,
      },
    );
  }

  // Declared after the other ':tenantId' routes for the same ordering reason.
  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Delete('organizations/:tenantId')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Permanently delete an Organization — its billing history and its isolated tenant database. Irreversible; requires the organization name as confirmation.',
  })
  @Audited({
    action: 'ORGANIZATION_DELETED',
    module: 'Organizations',
    tenantParam: 'tenantId',
    subject: ({ before, body }) =>
      before?.organizationName || body?.confirmName,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE,
      payload: ({ params }) => ({ tenantId: params.tenantId }),
      pick: (raw) => ({ ...raw, ...(raw?.profile ?? {}) }),
    },
  })
  async deleteOrganization(
    @Param('tenantId') tenantId: string,
    @Body() dto: DeleteOrganizationDto,
  ) {
    // The tenant DB drop routinely takes longer than the default 60s budget
    // other tenant-service calls use — same reasoning as CREATE_INITIAL above.
    const result = await firstValueFrom(
      this.tenantClient.send(
        MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.DELETE,
        { tenantId, dto },
        90000,
      ),
    );
    TenantGuard.forgetTenant(tenantId);
    return result;
  }

  // ==========================================
  // PLATFORM STATUS (dashboard widget: system health, storage)
  // ==========================================

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('platform-status')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Platform Status Widget (system health, live storage usage). ' +
      'activeIntegrations/lastBackupAt/uptimePercentage are null — no backing subsystem exists yet; see the `notes` field.',
  })
  getPlatformStatus() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_STATUS.GET_STATUS,
      {},
    );
  }

  // ==========================================
  // SYSTEM MANAGEMENT — GENERAL SETTINGS
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('system/directory-projection')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Health of the Clients directory read model — rows held, tenants behind, and how far behind. `healthy: false` means a tenant has unapplied events',
  })
  getDirectoryProjectionHealth() {
    return this.tenantClient.send(MESSAGE_PATTERNS.PROJECTION.GET_HEALTH, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/general')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get General Settings (branding, formats, feature toggles)',
  })
  getGeneralSettings() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.GET_GENERAL, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Put('settings/general')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update General Settings' })
  @Audited({
    action: 'GENERAL_SETTINGS_UPDATED',
    module: 'System Settings',
    snapshot: {
      service: 'auth',
      pattern: MESSAGE_PATTERNS.SETTINGS.GET_GENERAL,
    },
    diff: true,
  })
  async updateGeneralSettings(@Body() dto: UpdateGeneralSettingsDto) {
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_GENERAL, dto),
    );
    // The export switch applies on the next request.
    ExportPolicyGuard.invalidateAll();
    return result;
  }

  // ==========================================
  // SYSTEM MANAGEMENT — SECURITY SETTINGS
  // NOTE: 'settings/security/allowed-ips' must be declared before any
  // dynamic sibling route, same Express ordering caveat as organizations/stats.
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/security/allowed-ips')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: List IP addresses/CIDRs on the access allowlist',
  })
  listAllowedIps() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.LIST_ALLOWED_IPS, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Post('settings/security/allowed-ips')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Add an IP address/CIDR to the access allowlist',
  })
  @Audited({
    action: 'ALLOWED_IP_ADDED',
    module: 'Security',
    subject: ({ body }) => body?.ipOrCidr,
  })
  async addAllowedIp(@Body() dto: AddAllowedIpDto) {
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.SETTINGS.ADD_ALLOWED_IP, dto),
    );
    this.ipAllowlist.invalidate();
    return result;
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Delete('settings/security/allowed-ips/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Remove an IP address/CIDR from the access allowlist',
  })
  @Audited({
    action: 'ALLOWED_IP_REMOVED',
    module: 'Security',
    subject: ({ before }) => before?.ipOrCidr,
    snapshot: {
      service: 'auth',
      pattern: MESSAGE_PATTERNS.SETTINGS.LIST_ALLOWED_IPS,
      pick: (raw, { params }) =>
        (Array.isArray(raw) ? raw : (raw?.data ?? [])).find(
          (x: any) => x?.id === params.id,
        ),
    },
  })
  async removeAllowedIp(@Param('id') id: string, @Req() req: Request) {
    // The caller's address goes along so removing their own entry is refused.
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.SETTINGS.REMOVE_ALLOWED_IP, {
        id,
        callerIp: this.callerIp(req),
      }),
    );
    this.ipAllowlist.invalidate();
    return result;
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/security')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get Security Settings (password policy, per-role 2FA flags, 2FA method, IP allowlist toggle)',
  })
  async getSecuritySettings(@Req() req: Request) {
    const settings: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.SETTINGS.GET_SECURITY, {}),
    );
    // So the screen can show "your IP" and offer to add it before the allowlist goes on.
    return { ...settings, callerIp: this.callerIp(req) };
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Put('settings/security')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update Security Settings — password policy and expiry, Super Admin 2FA, lockout, session idle timeout, IP allowlist. Turning the allowlist on is refused if it would shut out the caller.',
  })
  @Audited({
    action: 'SECURITY_SETTINGS_UPDATED',
    module: 'Security',
    snapshot: {
      service: 'auth',
      pattern: MESSAGE_PATTERNS.SETTINGS.GET_SECURITY,
    },
    diff: true,
  })
  async updateSecuritySettings(
    @Body() dto: UpdateSecuritySettingsDto,
    @Req() req: Request,
  ) {
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_SECURITY, {
        dto,
        callerIp: this.callerIp(req),
      }),
    );
    this.ipAllowlist.invalidate();
    return result;
  }

  // ==========================================
  // SYSTEM MANAGEMENT — CUSTOM DOMAINS
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/domains')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: List configured platform domains' })
  listDomains() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.LIST_DOMAINS, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Post('settings/domains')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Add a custom domain. SSL/redirect fields are stored preferences only — no certificate is issued and no DNS/reverse-proxy change is made.',
  })
  @Audited({
    action: 'DOMAIN_ADDED',
    module: 'System Settings',
    subject: ({ body }) => body?.domain,
  })
  addDomain(@Body() dto: AddDomainDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.ADD_DOMAIN, dto);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Patch('settings/domains/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update a configured domain (status / SSL preferences)',
  })
  @Audited({
    action: 'DOMAIN_UPDATED',
    module: 'System Settings',
    subject: ({ before }) => before?.domain,
    snapshot: {
      service: 'auth',
      pattern: MESSAGE_PATTERNS.SETTINGS.LIST_DOMAINS,
      pick: (raw, { params }) =>
        (raw?.domains ?? (Array.isArray(raw) ? raw : [])).find(
          (x: any) => x?.id === params.id,
        ),
    },
    diff: true,
  })
  updateDomain(@Param('id') id: string, @Body() dto: UpdateDomainDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_DOMAIN, {
      id,
      dto,
    });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Post('settings/domains/:id/verify')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "SuperAdmin: Re-check a domain's DNS record and HTTPS certificate now",
  })
  verifyDomain(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.VERIFY_DOMAIN, {
      id,
    });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Delete('settings/domains/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Remove a configured domain' })
  @Audited({
    action: 'DOMAIN_REMOVED',
    module: 'System Settings',
    subject: ({ before }) => before?.domain,
    snapshot: {
      service: 'auth',
      pattern: MESSAGE_PATTERNS.SETTINGS.LIST_DOMAINS,
      pick: (raw, { params }) =>
        (raw?.domains ?? (Array.isArray(raw) ? raw : [])).find(
          (x: any) => x?.id === params.id,
        ),
    },
  })
  removeDomain(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.REMOVE_DOMAIN, {
      id,
    });
  }

  // ==========================================
  // SYSTEM MANAGEMENT — MAINTENANCE
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/maintenance')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Get Maintenance Mode and System Update settings',
  })
  getMaintenanceSettings() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.GET_MAINTENANCE, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Put('settings/maintenance')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update Maintenance settings. Maintenance Mode is enforced for real (503 for non-SuperAdmin traffic); the System Update fields are stored preferences only.',
  })
  @Audited({
    action: ({ body, before }) =>
      body?.maintenanceModeEnabled === true && !before?.maintenanceModeEnabled
        ? 'MAINTENANCE_MODE_TURNED_ON'
        : body?.maintenanceModeEnabled === false &&
            before?.maintenanceModeEnabled
          ? 'MAINTENANCE_MODE_TURNED_OFF'
          : 'MAINTENANCE_SETTINGS_UPDATED',
    module: 'System Settings',
    snapshot: {
      service: 'auth',
      pattern: MESSAGE_PATTERNS.SETTINGS.GET_MAINTENANCE,
    },
    diff: true,
  })
  async updateMaintenanceSettings(@Body() dto: UpdateMaintenanceSettingsDto) {
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_MAINTENANCE, dto),
    );
    // On or off takes effect on the next request, not after the guard's cache expires.
    MaintenanceModeGuard.invalidateAll();
    return result;
  }

  // ==========================================
  // SYSTEM MANAGEMENT — OVERVIEW: RECENT ACTIVITY
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('activity/recent')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Recent Activity feed for the System Management Overview tab',
  })
  getRecentActivity(@Query() query: GetRecentActivityQueryDto) {
    return this.authClient.send(
      MESSAGE_PATTERNS.AUDIT.GET_RECENT_ACTIVITY,
      query,
    );
  }

  // ==========================================
  // SYSTEM MANAGEMENT — BACKUPS
  // NOTE: 'backups/settings' must be declared before 'backups/:id'.
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('backups/settings')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get Backup Settings (frequency, time, retention, location)',
  })
  getBackupSettings() {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.GET_SETTINGS, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Put('backups/settings')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update Backup Settings. Stored preferences — no scheduler exists in this codebase, so automatic backups are not triggered on a timer yet.',
  })
  @Audited({
    action: 'BACKUP_SCHEDULE_UPDATED',
    module: 'Backups',
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.BACKUP.GET_SETTINGS,
    },
    diff: true,
  })
  updateBackupSettings(@Body() dto: UpdateBackupSettingsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.UPDATE_SETTINGS, dto);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Post('backups')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Start a backup of the platform DB and every tenant DB. Returns at once with the in-progress record; poll the list for the result.',
  })
  @Audited({ action: 'BACKUP_STARTED', module: 'Backups' })
  createBackupNow(@Req() req: any) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.CREATE_NOW, {
      triggeredBy: req?.user?.id || req?.user?.sub || 'superadmin',
    });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('backups')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Recent Backups table (paginated)' })
  listBackups(@Query() query: GetBackupsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.LIST, query);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('backups/:id/download')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Download a completed backup (gzipped JSON of every database)',
  })
  @Audited({
    action: 'BACKUP_DOWNLOADED',
    module: 'Backups',
    subject: ({ before }) =>
      before?.startedAt
        ? `Backup of ${new Date(before.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : undefined,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.BACKUP.GET_ONE,
      payload: ({ params }) => ({ id: params.id }),
    },
  })
  async downloadBackup(@Param('id') id: string, @Res() res: Response) {
    const backup: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.GET_ONE, { id }),
    );
    if (!backup?.fileId || backup.status !== 'SUCCESS') {
      return res.status(404).json({
        statusCode: 404,
        message: 'This backup has no file to download.',
      });
    }
    const file: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, {
        fileId: backup.fileId,
        userTenantId: 'platform',
      }),
    );
    if (!file?.buffer) {
      return res.status(404).json({
        statusCode: 404,
        message: 'The backup file is no longer in storage.',
      });
    }
    return sendFileResponse(res, file, false);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('backups/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a single backup record' })
  getBackup(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.GET_ONE, { id });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Delete('backups/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Delete a backup (removes both the record and the stored dump file)',
  })
  @Audited({
    action: 'BACKUP_DELETED',
    module: 'Backups',
    subject: ({ before }) =>
      before?.startedAt
        ? `Backup of ${new Date(before.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : undefined,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.BACKUP.GET_ONE,
      payload: ({ params }) => ({ id: params.id }),
    },
  })
  deleteBackup(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.DELETE, { id });
  }

  // ==========================================
  // HELP & SUPPORT
  // NOTE: static sub-routes are declared before their ':id' siblings so
  // Express doesn't match e.g. "categories" as an id.
  // ==========================================

  @ApiTags(TAGS.SA_HELP)
  @Get('help/overview')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Help & Support landing page (categories, trending, videos, recent tickets)',
  })
  getHelpOverview() {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_OVERVIEW, {});
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/categories')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Help categories with live article counts',
  })
  getHelpCategories() {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_CATEGORIES, {});
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/resources')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: "Other Ways to Get Help" links (System Status, Release Notes, Community, Feature Requests). URLs come from environment config; unset ones return null.',
  })
  getHelpResourceLinks() {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_RESOURCE_LINKS, {});
  }

  // --- Knowledge base articles ---

  @ApiTags(TAGS.SA_HELP)
  @Get('help/articles')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Knowledge base articles (All Topics / Trending / New tabs)',
  })
  listArticles(@Query() query: GetArticlesQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_ARTICLES, query);
  }

  @ApiTags(TAGS.SA_HELP)
  @Post('help/articles')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Publish a knowledge base article' })
  @Audited({
    action: 'HELP_ARTICLE_PUBLISHED',
    module: 'Help & Support',
    subject: ({ body }) => body?.title,
  })
  createArticle(@Body() dto: CreateArticleDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_ARTICLE, dto);
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/articles/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Read an article (increments its view count)',
  })
  @ApiQuery({
    name: 'countView',
    required: false,
    description: "'false' when opening for editing",
  })
  getArticle(@Param('id') id: string, @Query('countView') countView?: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_ARTICLE, {
      id,
      countView: countView !== 'false',
    });
  }

  @ApiTags(TAGS.SA_HELP)
  @Patch('help/articles/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update a knowledge base article' })
  @Audited({
    action: 'HELP_ARTICLE_UPDATED',
    module: 'Help & Support',
    subject: ({ body, result }) => body?.title || result?.title,
  })
  updateArticle(@Param('id') id: string, @Body() dto: UpdateArticleDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.UPDATE_ARTICLE, {
      id,
      dto,
    });
  }

  @ApiTags(TAGS.SA_HELP)
  @Delete('help/articles/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete a knowledge base article' })
  @Audited({ action: 'HELP_ARTICLE_DELETED', module: 'Help & Support' })
  deleteArticle(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.DELETE_ARTICLE, { id });
  }

  // --- Video tutorials ---

  @ApiTags(TAGS.SA_HELP)
  @Get('help/videos')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Video tutorials (duration and view counts pre-formatted)',
  })
  listVideos(@Query() query: GetVideosQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_VIDEOS, query);
  }

  @ApiTags(TAGS.SA_HELP)
  @Post('help/videos')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Publish a video tutorial' })
  @Audited({
    action: 'HELP_VIDEO_PUBLISHED',
    module: 'Help & Support',
    subject: ({ body }) => body?.title,
  })
  createVideo(@Body() dto: CreateVideoTutorialDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_VIDEO, dto);
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/videos/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Get a video tutorial (increments its view count)',
  })
  @ApiQuery({
    name: 'countView',
    required: false,
    description: "'false' when opening for editing",
  })
  getVideo(@Param('id') id: string, @Query('countView') countView?: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_VIDEO, {
      id,
      countView: countView !== 'false',
    });
  }

  @ApiTags(TAGS.SA_HELP)
  @Patch('help/videos/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update a video tutorial' })
  @Audited({
    action: 'HELP_VIDEO_UPDATED',
    module: 'Help & Support',
    subject: ({ body, result }) => body?.title || result?.title,
  })
  updateVideo(@Param('id') id: string, @Body() dto: UpdateVideoTutorialDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.UPDATE_VIDEO, {
      id,
      dto,
    });
  }

  @ApiTags(TAGS.SA_HELP)
  @Delete('help/videos/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete a video tutorial' })
  @Audited({ action: 'HELP_VIDEO_DELETED', module: 'Help & Support' })
  deleteVideo(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.DELETE_VIDEO, { id });
  }

  // --- Support tickets ---

  @ApiTags(TAGS.SA_HELP)
  @Get('help/tickets')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Support tickets (paginated, filterable by status, with status tallies)',
  })
  listTickets(@Query() query: GetSupportTicketsQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_TICKETS, query);
  }

  @ApiTags(TAGS.SA_HELP)
  @Post('help/tickets')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Create a support ticket' })
  @Audited({
    action: 'SUPPORT_TICKET_CREATED',
    module: 'Help & Support',
    subject: ({ body }) => body?.subject,
  })
  createTicket(@Body() dto: CreateSupportTicketDto, @Req() req: any) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_TICKET, {
      dto,
      createdBy: req?.user?.id || req?.user?.sub || undefined,
      createdByEmail: req?.user?.email || undefined,
      createdByRole: 'Super Admin',
    });
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/tickets/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a support ticket' })
  getTicket(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_TICKET, { id });
  }

  @ApiTags(TAGS.SA_HELP)
  @Patch('help/tickets/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update a support ticket (status, priority, resolution note)',
  })
  @Audited({
    action: 'SUPPORT_TICKET_UPDATED',
    module: 'Help & Support',
    subject: ({ result }) => result?.subject,
  })
  updateTicket(@Param('id') id: string, @Body() dto: UpdateSupportTicketDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.UPDATE_TICKET, {
      id,
      dto,
    });
  }

  // ==========================================
  // CLIENTS (cross-tenant Admin / HR contacts)
  // ==========================================

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/contacts')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "SuperAdmin: Client contacts — every organization's admins and HR, pending admin invitations, last sign-in and status",
  })
  getClientContacts() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_CLIENT_CONTACTS,
      {},
    );
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Clients KPI Cards (Total / Admins / HRs / Employees)',
  })
  getClientsStats() {
    return this.userClient.send(
      MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_STATS,
      {},
    );
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/by-role')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Client headcount breakdown by role' })
  getClientsByRole() {
    return this.userClient.send(
      MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_BY_ROLE,
      {},
    );
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/recent')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Recently added clients across all organizations',
  })
  getRecentClients(@Query() query: GetRecentPlatformClientsQueryDto) {
    return this.userClient.send(
      MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_RECENT,
      query,
    );
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Paginated, filterable Clients (Admins/HRs) directory across organizations',
  })
  getClients(@Query() query: GetPlatformClientsQueryDto) {
    return this.userClient.send(
      MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ALL,
      query,
    );
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/:tenantId/:userId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Get a single client (Admin/HR) detail',
  })
  getClient(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
  ) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ONE, {
      tenantId,
      userId,
    });
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Patch('clients/:tenantId/:userId/status')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "SuperAdmin: Allow or block a client's (Admin/HR) sign-in; blocking ends their sessions",
  })
  @Audited({
    action: ({ body }) =>
      body?.isActive ? 'CLIENT_ACCESS_ALLOWED' : 'CLIENT_ACCESS_BLOCKED',
    module: 'Clients',
    tenantParam: 'tenantId',
    subject: ({ before }) => before?.name || before?.fullName || before?.email,
    snapshot: {
      service: 'user',
      pattern: MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ONE,
      payload: ({ params }) => ({
        tenantId: params.tenantId,
        userId: params.userId,
      }),
    },
  })
  async updateClientStatus(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdatePlatformClientStatusDto,
  ) {
    const result = await firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.UPDATE_STATUS, {
        tenantId,
        userId,
        isActive: dto.isActive,
      }),
    );
    // Their sessions were revoked in auth-service; drop this gateway's cached
    // "still valid" answers so the block takes effect on the next request.
    if (!dto.isActive) JwtAuthGuard.forgetAllSessions();
    return result;
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Delete('clients/:tenantId/:userId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Remove a client (Admin/HR) from an organization',
  })
  @Audited({
    action: 'CLIENT_REMOVED',
    module: 'Clients',
    tenantParam: 'tenantId',
    subject: ({ before }) => before?.name || before?.fullName || before?.email,
    snapshot: {
      service: 'user',
      pattern: MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ONE,
      payload: ({ params }) => ({
        tenantId: params.tenantId,
        userId: params.userId,
      }),
    },
  })
  deleteClient(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
  ) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.DELETE, {
      tenantId,
      userId,
    });
  }

  // ==========================================
  // SUPER ADMIN BILLING & PLAN APIS
  // ==========================================

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/plans')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Available Billing Plans' })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiQuery({ name: 'isCustom', required: false, type: Boolean })
  getPlans(@Query() filter: PlanFilterDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_PLANS, filter);
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/plans')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Create a New Billing Plan' })
  @Audited({
    action: 'PLAN_CREATED',
    module: 'Subscriptions',
    subject: ({ body }) => body?.name,
  })
  createPlan(@Body() dto: CreatePlanDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.CREATE_PLAN, dto);
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Put('billing/plans/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update Existing Billing Plan (Subscriptions remain unchanged)',
  })
  @Audited({
    action: 'PLAN_UPDATED',
    module: 'Subscriptions',
    subject: ({ before, body }) => before?.name || body?.name,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.BILLING.GET_PLANS,
      pick: (raw, { params }) =>
        (Array.isArray(raw) ? raw : (raw?.data ?? raw?.plans ?? [])).find(
          (x: any) => x?.id === params.id,
        ),
    },
    diff: true,
  })
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.UPDATE_PLAN, {
      id,
      dto,
    });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/metrics')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get Platform Billing Metrics (totalPlans, orgsSubscribed, activeSubscriptions, mrr, totalRevenue, etc.)',
  })
  getBillingMetrics() {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_METRICS, {});
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Subscriptions Across Tenants' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getSuperAdminSubscriptions(@Query() query: SubscriptionQueryDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTIONS,
      query,
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Subscription Details By ID' })
  getSuperAdminSubscriptionById(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_BY_ID,
      { id },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions/:id/invoices')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Invoices For A Subscription' })
  getSuperAdminSubscriptionInvoices(@Param('id') subscriptionId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_INVOICES,
      { subscriptionId },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions/:id/payments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Payments For A Subscription' })
  getSuperAdminSubscriptionPayments(@Param('id') subscriptionId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_PAYMENTS,
      { subscriptionId },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/suspend')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Suspend An Organization Subscription' })
  @Audited({
    action: 'SUBSCRIPTION_SUSPENDED',
    module: 'Subscriptions',
    subject: ({ result }) => result?.plan?.name,
  })
  suspendSuperAdminSubscription(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_SUSPEND_SUBSCRIPTION,
      { id },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/reactivate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Reactivate A Suspended Subscription' })
  @Audited({
    action: 'SUBSCRIPTION_REACTIVATED',
    module: 'Subscriptions',
    subject: ({ result }) => result?.plan?.name,
  })
  reactivateSuperAdminSubscription(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION,
      { id },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/renewals/upcoming')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Upcoming Subscription Renewals' })
  @ApiQuery({ name: 'thresholdDays', required: false, type: Number })
  getUpcomingRenewals(@Query('thresholdDays') thresholdDays?: number) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.UPCOMING_RENEWALS, {
      thresholdDays,
    });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/overdue')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Overdue Subscriptions' })
  getOverdueSubscriptions() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.OVERDUE_SUBSCRIPTIONS,
      {},
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/suspended')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Suspended Subscriptions' })
  getSuspendedSubscriptions() {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUSPENDED_SUBSCRIPTIONS,
      {},
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/events')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Get All Platform Billing Audit Events',
  })
  getBillingEvents(@Query() query: any) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_EVENTS, {
      query,
    });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/mark-past-due')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Manually Mark Subscription As PAST_DUE',
  })
  @Audited({
    action: 'SUBSCRIPTION_MARKED_PAST_DUE',
    module: 'Subscriptions',
    subject: ({ result }) => result?.plan?.name,
  })
  markPastDue(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.MARK_PAST_DUE, {
      id,
    });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/extend-grace-period')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Safely Extend Subscription Grace Period',
  })
  @Audited({
    action: 'SUBSCRIPTION_GRACE_EXTENDED',
    module: 'Subscriptions',
    subject: ({ body }) => `+${body?.additionalDays || 7} days`,
  })
  extendGracePeriod(
    @Param('id') id: string,
    @Body() body: { additionalDays?: number },
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.EXTEND_GRACE_PERIOD,
      {
        id,
        additionalDays: body?.additionalDays || 7,
      },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/activate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Manually Activate Subscription' })
  @Audited({
    action: 'SUBSCRIPTION_ACTIVATED',
    module: 'Subscriptions',
    subject: ({ result }) => result?.plan?.name,
  })
  activateSubscription(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION,
      { id },
    );
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/invoices/:id/void')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Void An Unpaid Invoice (Rejects if invoice is PAID)',
  })
  @Audited({ action: 'INVOICE_VOIDED', module: 'Subscriptions' })
  voidInvoice(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION,
      { id },
    );
  }

  // ==========================================
  // SECURITY & PLATFORM AUDIT LOG
  // ==========================================

  // ==========================================
  // PLATFORM SYSTEM SETTINGS
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('system/settings/:category')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Read a platform settings category (general, security, maintenance)',
  })
  @ApiParam({ name: 'category', enum: ['general', 'security', 'maintenance'] })
  getPlatformSettings(@Param('category') category: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_SETTINGS.GET, {
      category,
    });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Patch('system/settings/:category')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Save a platform settings category' })
  @ApiParam({ name: 'category', enum: ['general', 'security', 'maintenance'] })
  @Audited({
    action: 'PLATFORM_SETTINGS_UPDATED',
    module: 'System Settings',
    subject: ({ params }) => params.category,
  })
  updatePlatformSettings(
    @Param('category') category: string,
    @Body() values: Record<string, any>,
    @CurrentUser('id') superAdminId: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_SETTINGS.UPDATE, {
      category,
      values,
      updatedBy: superAdminId,
    });
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs/stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get Audit Log KPI Statistics (Total Activities, Today, Security Events, Failed Actions)',
  })
  getAuditLogStats() {
    return this.authClient.send(MESSAGE_PATTERNS.AUDIT.GET_STATS, {});
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs/export')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Export Filtered Audit Logs to CSV' })
  @ApiQuery({ name: 'search', required: false, description: 'Search keyword' })
  @ApiQuery({
    name: 'module',
    required: false,
    description: 'Filter by module',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    description: 'Filter by tenant ID',
  })
  @ApiQuery({ name: 'from', required: false, description: 'From date (ISO)' })
  @ApiQuery({ name: 'to', required: false, description: 'To date (ISO)' })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'json'] })
  @Audited({ action: 'AUDIT_LOGS_EXPORTED', module: 'Audit Logs' })
  async exportAuditLogs(
    @Query() query: AuditLogQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUDIT.EXPORT_LOGS, query),
    );
    if (query.format === 'json') {
      return result;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result?.filename || 'audit-logs.csv'}"`,
    );
    return result?.csv || '';
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get Single Audit Log Details by ID with Before/After Changes',
  })
  @ApiParam({ name: 'id', description: 'Audit log UUID' })
  getAuditLogById(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.AUDIT.GET_LOG_BY_ID, { id });
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Query Platform Audit Trail with search, filters, and pagination',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search across organization, user, action, email, IP',
  })
  @ApiQuery({
    name: 'module',
    required: false,
    description:
      'Filter by module: Subscriptions, Users, Roles & Permissions, Authentication, Reports',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status: Active, Success, Failed, Warning',
  })
  @ApiQuery({ name: 'email', required: false })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'e.g. LOGIN_SUCCESS, LOGIN_FAILED, TOKEN_REFRESH, LOGOUT',
  })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    description: 'Filter by tenant ID',
  })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getAuditLogs(@Query() query: AuditLogQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.AUDIT.QUERY_LOGS, query);
  }

  // ==========================================
  // REPORTS & ANALYTICS (Platform Overview & Custom Reports)
  // ==========================================

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Reports Top 4 KPI Cards (Total Orgs, Total Users, Active Users, Reports Generated)',
  })
  getReportsStats() {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_STATS, {});
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/platform-growth')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Platform Growth 6-Month Timeline Chart Data (Orgs, Users, Reports)',
  })
  getPlatformGrowth(@Query() query: PlatformGrowthQueryDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.GET_PLATFORM_GROWTH,
      query,
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/top-organizations')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: Top Organizations by Employees Leaderboard',
  })
  getTopOrganizations(@Query() query: TopOrganizationsQueryDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.GET_TOP_ORGANIZATIONS,
      query,
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/templates')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin: 6 Popular Predefined Report Templates Catalog',
  })
  getPopularTemplates() {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_TEMPLATES, {});
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/generate')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Run a platform report on live data. Returns the preview and a run id whose CSV can be downloaded.',
  })
  @Audited({
    action: 'REPORT_GENERATED',
    module: 'Reports',
    subject: ({ result, body }) => result?.title || body?.reportType,
  })
  generateReport(@Body() dto: GenerateReportDto, @Req() req: any) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GENERATE, {
      dto,
      actor: this.reportActor(req),
    });
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/runs/:id/download')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Download the CSV a report run produced (exactly what was previewed)',
  })
  @Audited({
    action: 'REPORT_DOWNLOADED',
    module: 'Reports',
    subject: ({ result }) => result?.title,
  })
  async downloadReportRun(@Param('id') id: string, @Res() res: Response) {
    const file: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_RUN_FILE, { id }),
    );
    return this.sendCsv(res, file);
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/custom')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Saved custom reports (paginated, searchable, filterable by category)',
  })
  getCustomReports(@Query() query: CustomReportQueryDto) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORTS,
      query,
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/custom/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: One saved custom report' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  getCustomReportById(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORT_BY_ID,
      { id },
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/custom')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Save a custom report (a platform report with chosen filters and columns)',
  })
  @Audited({
    action: 'CUSTOM_REPORT_CREATED',
    module: 'Reports',
    subject: ({ body }) => body?.name,
  })
  createCustomReport(@Body() dto: CreateCustomReportDto, @Req() req: any) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.CREATE_CUSTOM_REPORT,
      { dto, actor: this.reportActor(req) },
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Put('reports/custom/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Edit a saved custom report' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  @Audited({
    action: 'CUSTOM_REPORT_UPDATED',
    module: 'Reports',
    subject: ({ before, body }) => before?.name || body?.name,
    snapshot: {
      service: 'tenant',
      pattern: MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORT_BY_ID,
      payload: ({ params }) => ({ id: params.id }),
    },
    diff: true,
  })
  updateCustomReport(
    @Param('id') id: string,
    @Body() dto: UpdateCustomReportDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.UPDATE_CUSTOM_REPORT,
      { id, dto },
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/custom/:id/duplicate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Copy a saved custom report' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  @Audited({
    action: 'CUSTOM_REPORT_DUPLICATED',
    module: 'Reports',
    subject: ({ result }) => result?.name,
  })
  duplicateCustomReport(@Param('id') id: string, @Req() req: any) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.DUPLICATE_CUSTOM_REPORT,
      { id, actor: this.reportActor(req) },
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Delete('reports/custom/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete a saved custom report' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  @Audited({
    action: 'CUSTOM_REPORT_DELETED',
    module: 'Reports',
    subject: ({ result }) => result?.name,
  })
  deleteCustomReport(@Param('id') id: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.REPORTS.DELETE_CUSTOM_REPORT,
      { id },
    );
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/custom/:id/run')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Run a saved custom report with its filters and columns',
  })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  @Audited({
    action: 'CUSTOM_REPORT_RUN',
    module: 'Reports',
    subject: ({ result }) => result?.title,
  })
  runCustomReport(@Param('id') id: string, @Req() req: any) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.RUN_CUSTOM_REPORT, {
      id,
      actor: this.reportActor(req),
    });
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/custom/:id/last-run/download')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "SuperAdmin: Download the CSV of a custom report's most recent run",
  })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  @Audited({
    action: 'REPORT_DOWNLOADED',
    module: 'Reports',
    subject: ({ result }) => result?.title,
  })
  async downloadCustomReportLastRun(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const file: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_LAST_RUN_FILE, {
        id,
      }),
    );
    return this.sendCsv(res, file);
  }

  /** Who is running or saving a report, for "Generated by" / "Created by". */
  private reportActor(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      email: req?.user?.email || null,
    };
  }

  /** Writes a stored CSV as a download; returns its title for the audit trail. */
  private sendCsv(
    res: Response,
    file: { filename: string; contentType: string; csv: string; title: string },
  ) {
    res.setHeader(
      'Content-Type',
      file.contentType || 'text/csv; charset=utf-8',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(file.filename).replace(/[^\w.-]+/g, '-')}"`,
    );
    res.send(file.csv);
    return { title: file.title };
  }
}
