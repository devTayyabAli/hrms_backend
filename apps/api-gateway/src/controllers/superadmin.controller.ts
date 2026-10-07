import { Controller, Post, Get, Put, Patch, Delete, Body, Inject, Param, Query, UseGuards, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam } from '@nestjs/swagger';
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
import { setRefreshCookie, withoutRefreshToken } from '../auth/refresh-token-cookie';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  Roles,
  SuperAdminGuard,
  CurrentUser,
} from '@app/tenant-context';
import { IpAllowlistGuard } from '../guards/ip-allowlist.guard';
import { requestLocation } from '../utils/request-location';

@Controller('superadmin')
@PlatformRoute()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, SuperAdminGuard, IpAllowlistGuard)
@Roles('superadmin')
export class SuperAdminController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ResilientClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
  ) { }

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
  @ApiOperation({ summary: 'Onboard a new organization tenant with isolated database setup' })
  onboardOrganization(@Body() dto: OnboardOrganizationDto) {
    return this.authClient.send(MESSAGE_PATTERNS.AUTH.ONBOARD_ORGANIZATION, dto);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/validate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin Step Validation: Validate Organization Onboarding Payload' })
  validateOrganizationOnboarding(@Body() dto: ValidateOrganizationOnboardingDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.VALIDATE_ONBOARDING, dto);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/review')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin Step 4: Review & Confirm Organization Setup Summary' })
  reviewOrganizationOnboarding(@Body() dto: CreateOrganizationOnboardingDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.REVIEW_ONBOARDING, dto);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Create Organization & Provision Isolated Database' })
  createOrganization(@Body() dto: CreateOrganizationDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.CREATE_ORGANIZATION, dto);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/create-full')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin Flow: Full Multi-Step Organization Onboarding Creation' })
  createFullOrganization(@Body() dto: CreateOrganizationOnboardingDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.CREATE_ORGANIZATION, dto);
  }

  // ==========================================
  // 3-STEP ORGANIZATION INITIAL CREATION & ONBOARDING
  // ==========================================

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/initial/create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: 3-Step Organization Creation & Isolated DB Auto-Provisioning' })
  createInitialOrganization(@Body() dto: InitialOrganizationOnboardingDto) {
    // Returns once the tenant row exists; the database is provisioned in the
    // background (a full schema sync outlives the proxy's 60s timeout).
    // Follow it with GET organizations/:tenantId/creation-status.
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.CREATE_INITIAL, dto);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/:tenantId/creation-status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Progress of an organization being created (running, done or failed)' })
  getOrganizationCreationStatus(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.GET_CREATION_STATUS, { tenantId });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/:tenantId/modules')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Organization Module Entitlements & Permissions' })
  getOrganizationModules(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.GET_MODULE_ACCESS, { tenantId });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Put('organizations/:tenantId/modules')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update Organization Module Entitlements & Permissions' })
  updateOrganizationModules(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationModuleAccessDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.UPDATE_MODULE_ACCESS, {
      tenantId,
      modules: dto.modules,
    });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/:tenantId/provision/retry')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Retry Failed Tenant Database Provisioning' })
  retryProvisioning(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.TENANT.RETRY_PROVISION, { tenantId });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/:tenantId/invitation')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Generate Organization Admin Invitation' })
  createAdminInvitation(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateAdminInvitationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INVITATION.CREATE, { tenantId, dto });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Post('organizations/:tenantId/invitation/resend')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Resend / Replace Organization Admin Invitation' })
  resendAdminInvitation(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INVITATION.RESEND, { tenantId });
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
  @ApiOperation({ summary: 'SuperAdmin: Organizations KPI Cards (Total / Active / Trial / Pending / Deactivated)' })
  getOrganizationsStats() {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_STATS, {});
  }

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('organizations/overview')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SuperAdmin Dashboard: organizations registered per month, split by current status',
  })
  @ApiQuery({ name: 'months', required: false, description: 'Window in months (1–24, default 6)' })
  getOrganizationsOverview(@Query('months') months?: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_OVERVIEW, {
      months: Number(months) || 6,
    });
  }

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('organizations/by-plan')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin Dashboard: organization count per plan' })
  getOrganizationsByPlan() {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_PLAN_BREAKDOWN, {});
  }

  @ApiTags(TAGS.SA_DASHBOARD)
  @Get('organizations/alerts')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin Dashboard: organization and billing alerts that need action' })
  getOrganizationsAlerts() {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALERTS, {});
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Paginated, filterable list of all Organizations' })
  getOrganizations(@Query() query: GetPlatformOrganizationsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALL, query);
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Get('organizations/:tenantId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a single Organization detail' })
  getOrganization(@Param('tenantId') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE, { tenantId });
  }

  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Patch('organizations/:tenantId/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Activate / Deactivate an Organization' })
  async updateOrganizationStatus(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationStatusDto,
  ) {
    const result = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.UPDATE_STATUS, {
        tenantId,
        status: dto.status,
      }),
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
  updateOrganization(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.UPDATE, {
      tenantId,
      dto,
    });
  }

  // Declared after the other ':tenantId' routes for the same ordering reason.
  @ApiTags(TAGS.SA_ORGANIZATIONS)
  @Delete('organizations/:tenantId')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Permanently delete an Organization — its billing history and its isolated tenant database. Irreversible; requires the organization name as confirmation.',
  })
  async deleteOrganization(
    @Param('tenantId') tenantId: string,
    @Body() dto: DeleteOrganizationDto,
  ) {
    // The tenant DB drop routinely takes longer than the default 60s budget
    // other tenant-service calls use — same reasoning as CREATE_INITIAL above.
    const result = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.DELETE, { tenantId, dto }, 90000),
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
    return this.tenantClient.send(MESSAGE_PATTERNS.PLATFORM_STATUS.GET_STATUS, {});
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
  @ApiOperation({ summary: 'SuperAdmin: Get General Settings (branding, formats, feature toggles)' })
  getGeneralSettings() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.GET_GENERAL, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Put('settings/general')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update General Settings' })
  updateGeneralSettings(@Body() dto: UpdateGeneralSettingsDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_GENERAL, dto);
  }

  // ==========================================
  // SYSTEM MANAGEMENT — SECURITY SETTINGS
  // NOTE: 'settings/security/allowed-ips' must be declared before any
  // dynamic sibling route, same Express ordering caveat as organizations/stats.
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/security/allowed-ips')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: List IP addresses/CIDRs on the access allowlist' })
  listAllowedIps() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.LIST_ALLOWED_IPS, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Post('settings/security/allowed-ips')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Add an IP address/CIDR to the access allowlist' })
  addAllowedIp(@Body() dto: AddAllowedIpDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.ADD_ALLOWED_IP, dto);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Delete('settings/security/allowed-ips/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Remove an IP address/CIDR from the access allowlist' })
  removeAllowedIp(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.REMOVE_ALLOWED_IP, { id });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/security')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Get Security Settings (password policy, per-role 2FA flags, 2FA method, IP allowlist toggle)',
  })
  getSecuritySettings() {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.GET_SECURITY, {});
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Put('settings/security')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'SuperAdmin: Update Security Settings. Password policy + SuperAdmin 2FA requirement + IP allowlist are enforced for real; the other per-role 2FA flags are stored only (those login paths do not exist yet).',
  })
  updateSecuritySettings(@Body() dto: UpdateSecuritySettingsDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_SECURITY, dto);
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
  addDomain(@Body() dto: AddDomainDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.ADD_DOMAIN, dto);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Patch('settings/domains/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update a configured domain (status / SSL preferences)' })
  updateDomain(@Param('id') id: string, @Body() dto: UpdateDomainDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_DOMAIN, { id, dto });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Delete('settings/domains/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Remove a configured domain' })
  removeDomain(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.REMOVE_DOMAIN, { id });
  }

  // ==========================================
  // SYSTEM MANAGEMENT — MAINTENANCE
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('settings/maintenance')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Maintenance Mode and System Update settings' })
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
  updateMaintenanceSettings(@Body() dto: UpdateMaintenanceSettingsDto) {
    return this.authClient.send(MESSAGE_PATTERNS.SETTINGS.UPDATE_MAINTENANCE, dto);
  }

  // ==========================================
  // SYSTEM MANAGEMENT — OVERVIEW: RECENT ACTIVITY
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('activity/recent')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Recent Activity feed for the System Management Overview tab' })
  getRecentActivity(@Query() query: GetRecentActivityQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.AUDIT.GET_RECENT_ACTIVITY, query);
  }

  // ==========================================
  // SYSTEM MANAGEMENT — BACKUPS
  // NOTE: 'backups/settings' must be declared before 'backups/:id'.
  // ==========================================

  @ApiTags(TAGS.SA_SYSTEM)
  @Get('backups/settings')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Backup Settings (frequency, time, retention, location)' })
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
  updateBackupSettings(@Body() dto: UpdateBackupSettingsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.UPDATE_SETTINGS, dto);
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Post('backups')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Create Backup Now (real dump of the platform DB + every tenant DB)' })
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
  @Get('backups/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a single backup record' })
  getBackup(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BACKUP.GET_ONE, { id });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Delete('backups/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete a backup (removes both the record and the stored dump file)' })
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
  @ApiOperation({ summary: 'SuperAdmin: Help & Support landing page (categories, trending, videos, recent tickets)' })
  getHelpOverview() {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_OVERVIEW, {});
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/categories')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Help categories with live article counts' })
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
  @ApiOperation({ summary: 'SuperAdmin: Knowledge base articles (All Topics / Trending / New tabs)' })
  listArticles(@Query() query: GetArticlesQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_ARTICLES, query);
  }

  @ApiTags(TAGS.SA_HELP)
  @Post('help/articles')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Publish a knowledge base article' })
  createArticle(@Body() dto: CreateArticleDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_ARTICLE, dto);
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/articles/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Read an article (increments its view count)' })
  getArticle(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_ARTICLE, { id });
  }

  @ApiTags(TAGS.SA_HELP)
  @Patch('help/articles/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update a knowledge base article' })
  updateArticle(@Param('id') id: string, @Body() dto: UpdateArticleDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.UPDATE_ARTICLE, { id, dto });
  }

  @ApiTags(TAGS.SA_HELP)
  @Delete('help/articles/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete a knowledge base article' })
  deleteArticle(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.DELETE_ARTICLE, { id });
  }

  // --- Video tutorials ---

  @ApiTags(TAGS.SA_HELP)
  @Get('help/videos')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Video tutorials (duration and view counts pre-formatted)' })
  listVideos(@Query() query: GetVideosQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_VIDEOS, query);
  }

  @ApiTags(TAGS.SA_HELP)
  @Post('help/videos')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Publish a video tutorial' })
  createVideo(@Body() dto: CreateVideoTutorialDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_VIDEO, dto);
  }

  @ApiTags(TAGS.SA_HELP)
  @Get('help/videos/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a video tutorial (increments its view count)' })
  getVideo(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_VIDEO, { id });
  }

  @ApiTags(TAGS.SA_HELP)
  @Patch('help/videos/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update a video tutorial' })
  updateVideo(@Param('id') id: string, @Body() dto: UpdateVideoTutorialDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.UPDATE_VIDEO, { id, dto });
  }

  @ApiTags(TAGS.SA_HELP)
  @Delete('help/videos/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete a video tutorial' })
  deleteVideo(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.DELETE_VIDEO, { id });
  }

  // --- Support tickets ---

  @ApiTags(TAGS.SA_HELP)
  @Get('help/tickets')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Support tickets (paginated, filterable by status, with status tallies)' })
  listTickets(@Query() query: GetSupportTicketsQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_TICKETS, query);
  }

  @ApiTags(TAGS.SA_HELP)
  @Post('help/tickets')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Create a support ticket' })
  createTicket(@Body() dto: CreateSupportTicketDto, @Req() req: any) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_TICKET, {
      dto,
      createdBy: req?.user?.id || req?.user?.sub || null,
      createdByName: req?.user?.name || req?.user?.email || null,
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
  @ApiOperation({ summary: 'SuperAdmin: Update a support ticket (status, priority, resolution note)' })
  updateTicket(@Param('id') id: string, @Body() dto: UpdateSupportTicketDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.UPDATE_TICKET, { id, dto });
  }

  // ==========================================
  // CLIENTS (cross-tenant Admin / HR contacts)
  // ==========================================

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/stats')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Clients KPI Cards (Total / Admins / HRs / Employees)' })
  getClientsStats() {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_STATS, {});
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/by-role')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Client headcount breakdown by role' })
  getClientsByRole() {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_BY_ROLE, {});
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/recent')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Recently added clients across all organizations' })
  getRecentClients(@Query() query: GetRecentPlatformClientsQueryDto) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_RECENT, query);
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Paginated, filterable Clients (Admins/HRs) directory across organizations' })
  getClients(@Query() query: GetPlatformClientsQueryDto) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ALL, query);
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Get('clients/:tenantId/:userId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get a single client (Admin/HR) detail' })
  getClient(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ONE, { tenantId, userId });
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Patch('clients/:tenantId/:userId/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Activate / Deactivate a client (Admin/HR)' })
  updateClientStatus(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdatePlatformClientStatusDto,
  ) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.UPDATE_STATUS, {
      tenantId,
      userId,
      isActive: dto.isActive,
    });
  }

  @ApiTags(TAGS.SA_CLIENTS)
  @Delete('clients/:tenantId/:userId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Remove a client (Admin/HR) from an organization' })
  deleteClient(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    return this.userClient.send(MESSAGE_PATTERNS.PLATFORM_CLIENTS.DELETE, { tenantId, userId });
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
  createPlan(@Body() dto: CreatePlanDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.CREATE_PLAN, dto);
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Put('billing/plans/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update Existing Billing Plan (Subscriptions remain unchanged)' })
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.UPDATE_PLAN, { id, dto });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/metrics')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Platform Billing Metrics (totalPlans, orgsSubscribed, activeSubscriptions, mrr, totalRevenue, etc.)' })
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
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTIONS, query);
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Subscription Details By ID' })
  getSuperAdminSubscriptionById(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_BY_ID, { id });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions/:id/invoices')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Invoices For A Subscription' })
  getSuperAdminSubscriptionInvoices(@Param('id') subscriptionId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_INVOICES, { subscriptionId });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/subscriptions/:id/payments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Payments For A Subscription' })
  getSuperAdminSubscriptionPayments(@Param('id') subscriptionId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTION_PAYMENTS, { subscriptionId });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/suspend')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Suspend An Organization Subscription' })
  suspendSuperAdminSubscription(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_SUSPEND_SUBSCRIPTION, { id });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/reactivate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Reactivate A Suspended Subscription' })
  reactivateSuperAdminSubscription(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION, { id });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/renewals/upcoming')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Upcoming Subscription Renewals' })
  @ApiQuery({ name: 'thresholdDays', required: false, type: Number })
  getUpcomingRenewals(@Query('thresholdDays') thresholdDays?: number) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.UPCOMING_RENEWALS, { thresholdDays });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/overdue')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Overdue Subscriptions' })
  getOverdueSubscriptions() {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.OVERDUE_SUBSCRIPTIONS, {});
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/suspended')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Suspended Subscriptions' })
  getSuspendedSubscriptions() {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUSPENDED_SUBSCRIPTIONS, {});
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Get('billing/events')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get All Platform Billing Audit Events' })
  getBillingEvents(@Query() query: any) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_EVENTS, { query });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/mark-past-due')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Manually Mark Subscription As PAST_DUE' })
  markPastDue(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.MARK_PAST_DUE, { id });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/extend-grace-period')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Safely Extend Subscription Grace Period' })
  extendGracePeriod(@Param('id') id: string, @Body() body: { additionalDays?: number }) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.EXTEND_GRACE_PERIOD, {
      id,
      additionalDays: body?.additionalDays || 7,
    });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/subscriptions/:id/activate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Manually Activate Subscription' })
  activateSubscription(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION, { id });
  }

  @ApiTags(TAGS.SA_SUBSCRIPTIONS)
  @Post('billing/invoices/:id/void')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Void An Unpaid Invoice (Rejects if invoice is PAID)' })
  voidInvoice(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SUPERADMIN_REACTIVATE_SUBSCRIPTION, { id });
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
    summary: 'SuperAdmin: Read a platform settings category (general, security, maintenance)',
  })
  @ApiParam({ name: 'category', enum: ['general', 'security', 'maintenance'] })
  getPlatformSettings(@Param('category') category: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_SETTINGS.GET, { category });
  }

  @ApiTags(TAGS.SA_SYSTEM)
  @Patch('system/settings/:category')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Save a platform settings category' })
  @ApiParam({ name: 'category', enum: ['general', 'security', 'maintenance'] })
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
  @ApiOperation({ summary: 'SuperAdmin: Get Audit Log KPI Statistics (Total Activities, Today, Security Events, Failed Actions)' })
  getAuditLogStats() {
    return this.authClient.send(MESSAGE_PATTERNS.AUDIT.GET_STATS, {});
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs/export')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Export Filtered Audit Logs to CSV' })
  @ApiQuery({ name: 'search', required: false, description: 'Search keyword' })
  @ApiQuery({ name: 'module', required: false, description: 'Filter by module' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Filter by tenant ID' })
  @ApiQuery({ name: 'from', required: false, description: 'From date (ISO)' })
  @ApiQuery({ name: 'to', required: false, description: 'To date (ISO)' })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'json'] })
  async exportAuditLogs(@Query() query: AuditLogQueryDto, @Res({ passthrough: true }) res: Response) {
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUDIT.EXPORT_LOGS, query),
    );
    if (query.format === 'json') {
      return result;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${result?.filename || 'audit-logs.csv'}"`);
    return result?.csv || '';
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Single Audit Log Details by ID with Before/After Changes' })
  @ApiParam({ name: 'id', description: 'Audit log UUID' })
  getAuditLogById(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.AUDIT.GET_LOG_BY_ID, { id });
  }

  @ApiTags(TAGS.SA_AUDIT_LOGS)
  @Get('audit-logs')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Query Platform Audit Trail with search, filters, and pagination' })
  @ApiQuery({ name: 'search', required: false, description: 'Search across organization, user, action, email, IP' })
  @ApiQuery({ name: 'module', required: false, description: 'Filter by module: Subscriptions, Users, Roles & Permissions, Authentication, Reports' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status: Active, Success, Failed, Warning' })
  @ApiQuery({ name: 'email', required: false })
  @ApiQuery({ name: 'action', required: false, description: 'e.g. LOGIN_SUCCESS, LOGIN_FAILED, TOKEN_REFRESH, LOGOUT' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Filter by tenant ID' })
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
  @ApiOperation({ summary: 'SuperAdmin: Reports Top 4 KPI Cards (Total Orgs, Total Users, Active Users, Reports Generated)' })
  getReportsStats() {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_STATS, {});
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/platform-growth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Platform Growth 6-Month Timeline Chart Data (Orgs, Users, Reports)' })
  getPlatformGrowth(@Query() query: PlatformGrowthQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_PLATFORM_GROWTH, query);
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/top-organizations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Top Organizations by Employees Leaderboard' })
  getTopOrganizations(@Query() query: TopOrganizationsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_TOP_ORGANIZATIONS, query);
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/templates')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: 6 Popular Predefined Report Templates Catalog' })
  getPopularTemplates() {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_TEMPLATES, {});
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/generate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Generate Report Data from Template or Custom Report' })
  generateReport(@Body() dto: GenerateReportDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GENERATE, dto);
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/export')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Export Report as Downloadable CSV' })
  async exportReport(@Query() query: GenerateReportDto, @Res({ passthrough: true }) res: Response) {
    const result: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.EXPORT, query),
    );
    if (query.format === 'json') {
      return result;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${result?.filename || 'report.csv'}"`);
    return result?.csv || '';
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/custom/export')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Export Custom Reports Table as CSV' })
  async exportCustomReports(@Query() query: CustomReportQueryDto, @Res({ passthrough: true }) res: Response) {
    const result: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORTS, { ...query, limit: 1000 }),
    );
    const items = result?.data || [];
    const headers = ['ID', 'Report Name', 'Category', 'Created By', 'Last Generated', 'Status'];
    const csvRows = [
      headers.join(','),
      ...items.map((r: any) =>
        [
          `"${r.id}"`,
          `"${(r.name || '').replace(/"/g, '""')}"`,
          `"${r.category || ''}"`,
          `"${(r.createdBy || '').replace(/"/g, '""')}"`,
          `"${r.lastGeneratedAt ? new Date(r.lastGeneratedAt).toISOString() : 'Never'}"`,
          `"${r.status || 'Active'}"`,
        ].join(','),
      ),
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="custom-reports.csv"');
    return csvRows.join('\n');
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/custom')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Custom Reports Table (Paginated, Searchable, Filterable by Category)' })
  getCustomReports(@Query() query: CustomReportQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORTS, query);
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Get('reports/custom/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Get Single Custom Report Detail by ID' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  getCustomReportById(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.GET_CUSTOM_REPORT_BY_ID, { id });
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/custom')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Create New Custom Report (+ Create New Report button)' })
  createCustomReport(@Body() dto: CreateCustomReportDto, @Req() req: any) {
    const creatorName = req?.user?.name || 'Aasma Abbas';
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.CREATE_CUSTOM_REPORT, { dto, creatorName });
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Put('reports/custom/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Update / Edit Custom Report' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  updateCustomReport(@Param('id') id: string, @Body() dto: UpdateCustomReportDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.UPDATE_CUSTOM_REPORT, { id, dto });
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Delete('reports/custom/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Delete Custom Report' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  deleteCustomReport(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.DELETE_CUSTOM_REPORT, { id });
  }

  @ApiTags(TAGS.SA_REPORTS)
  @Post('reports/custom/:id/run')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'SuperAdmin: Run / Execute Custom Report (Play action icon)' })
  @ApiParam({ name: 'id', description: 'Custom report UUID' })
  runCustomReport(@Param('id') id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.REPORTS.RUN_CUSTOM_REPORT, { id });
  }
}
