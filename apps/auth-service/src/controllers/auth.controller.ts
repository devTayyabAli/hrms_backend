import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  MESSAGE_PATTERNS,
  RegisterTenantDto,
  OnboardOrganizationDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  AuditLogQueryDto,
  SendEmailDto,
  SendTemplateEmailDto,
  CreateAdminCredentialDto,
  DeactivateTenantCredentialDto,
  LoginPayloadDto,
  GetLastLoginsDto,
  SuperAdminLoginPayloadDto,
  VerifyTwoFactorChallengePayloadDto,
  RefreshTokenPayloadDto,
  LogoutPayloadDto,
  SuperAdminIdPayloadDto,
  GenerateTwoFactorPayloadDto,
  GetSessionsPayloadDto,
  UpdateProfilePayloadDto,
  UpdateAvatarPayloadDto,
  ChangePasswordPayloadDto,
  UpdateRecoveryPayloadDto,
  ToggleTwoFactorPayloadDto,
  UpdateNotificationsPayloadDto,
  RevokeSessionPayloadDto,
  RevokeOtherSessionsPayloadDto,
  TenantProfileActorDto,
  UpdateTenantProfilePayloadDto,
  ChangeTenantPasswordPayloadDto,
  UploadFilePayloadDto,
  FileIdPayloadDto,
  FileQueryDto,
  UpdateGeneralSettingsDto,
  UpdateSecuritySettingsDto,
  AddAllowedIpDto,
  RemoveAllowedIpMessageDto,
  CheckIpAllowedDto,
  AddDomainDto,
  UpdateDomainMessageDto,
  RemoveDomainMessageDto,
  UpdateMaintenanceSettingsDto,
  GetRecentActivityQueryDto,
  HelpIdDto,
  GetArticlesQueryDto,
  CreateArticleDto,
  UpdateArticleMessageDto,
  GetVideosQueryDto,
  CreateVideoTutorialDto,
  UpdateVideoMessageDto,
  GetSupportTicketsQueryDto,
  CreateSupportTicketMessageDto,
  UpdateSupportTicketMessageDto,
} from '@app/common';
import { AllowUnsignedRpc } from '@app/tenant-context';
import { AuthService } from '../services/auth.service';
import { ProfileService } from '../services/profile.service';
import { TenantProfileService } from '../services/tenant-profile.service';
import { MailService } from '../services/mail.service';
import { FileStorageService } from '../services/file-storage.service';
import { AuditService } from '../services/audit.service';
import { PlatformSettingsService } from '../services/platform-settings.service';
import { GeneralSettingsService } from '../services/general-settings.service';
import { SecuritySettingsService } from '../services/security-settings.service';
import { CustomDomainsService } from '../services/custom-domains.service';
import { MaintenanceSettingsService } from '../services/maintenance-settings.service';
import { HelpSupportService } from '../services/help-support.service';

@Controller()
export class AuthMicroserviceController {
  constructor(
    private readonly authService: AuthService,
    private readonly profileService: ProfileService,
    private readonly tenantProfileService: TenantProfileService,
    private readonly mailService: MailService,
    private readonly fileStorageService: FileStorageService,
    private readonly auditService: AuditService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly generalSettingsService: GeneralSettingsService,
    private readonly securitySettingsService: SecuritySettingsService,
    private readonly customDomainsService: CustomDomainsService,
    private readonly maintenanceSettingsService: MaintenanceSettingsService,
    private readonly helpSupportService: HelpSupportService,
  ) { }

  // The former `wrapRpcError` helper lived here and re-implemented, per call
  // site, exactly what HttpToRpcExceptionFilter already does for every
  // handler in this service (registered globally in main.ts): map an
  // HttpException onto an RpcException carrying {statusCode, message, error}.
  //
  // Two copies of one mapping is worse than a duplicate — it is a rule that
  // can drift. Only nine of this controller's ~80 handlers were wrapped, so
  // the other seventy-odd already relied on the filter; had the two ever
  // disagreed, the behaviour of an endpoint would have depended on whether
  // someone remembered the try/catch. The filter is the one that cannot be
  // forgotten, so it is the one that stays.

  @MessagePattern(MESSAGE_PATTERNS.HEALTH.CHECK)
  // Liveness probes are run by orchestration, which has no reason to
  // hold MICROSERVICE_SIGNING_SECRET. Safe to exempt: it takes no
  // parameters, reads no tenant data and changes nothing.
  @AllowUnsignedRpc()
  healthCheck() {
    return {
      service: 'auth-service',
      status: 'up',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    };
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.CREATE_ADMIN_CREDENTIAL)
  createAdminCredential(@Payload() data: CreateAdminCredentialDto) {
    return this.authService.createAdminCredential(data);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.DEACTIVATE_TENANT_CREDENTIAL)
  deactivateTenantCredential(@Payload() data: DeactivateTenantCredentialDto) {
    return this.authService.deactivateTenantCredential(data.email, data.tenantId, data.isActive ?? false);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.SUPERADMIN_LOGIN)
  async superAdminLogin(@Payload() payload: SuperAdminLoginPayloadDto) {
    return await this.authService.superAdminLogin(payload.dto, payload.ipAddress, payload.userAgent);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.VERIFY_2FA)
  async verifyTwoFactorLogin(@Payload() payload: VerifyTwoFactorChallengePayloadDto) {
    return await this.authService.verifyTwoFactorLogin(payload.dto, payload.ipAddress, payload.userAgent);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.REFRESH_TOKEN)
  async refreshToken(@Payload() payload: RefreshTokenPayloadDto) {
    return await this.authService.refreshToken(payload.dto, payload.ipAddress, payload.userAgent);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.LOGOUT)
  async logout(@Payload() payload: LogoutPayloadDto) {
    return await this.authService.logout(payload.dto, payload.ipAddress, payload.userAgent);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_SETTINGS.GET)
  getPlatformSettings(@Payload() payload: { category: string }) {
    return this.platformSettingsService.get(payload.category);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_SETTINGS.UPDATE)
  updatePlatformSettings(
    @Payload() payload: { category: string; values: Record<string, any>; updatedBy?: string },
  ) {
    return this.platformSettingsService.update(payload.category, payload.values, payload.updatedBy);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUDIT.QUERY_LOGS)
  queryAuditLogs(@Payload() filter: AuditLogQueryDto) {
    return this.auditService.query(filter);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUDIT.GET_LOG_BY_ID)
  getAuditLogById(@Payload() payload: { id: string } | string) {
    const id = typeof payload === 'string' ? payload : payload?.id;
    return this.auditService.getById(id);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUDIT.GET_STATS)
  getAuditStats() {
    return this.auditService.getStats();
  }

  @MessagePattern(MESSAGE_PATTERNS.AUDIT.EXPORT_LOGS)
  exportAuditLogs(@Payload() filter: AuditLogQueryDto) {
    return this.auditService.exportLogs(filter);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.ONBOARD_ORGANIZATION)
  onboardOrganization(@Payload() dto: OnboardOrganizationDto) {
    return this.authService.onboardOrganization(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.FORGOT_PASSWORD)
  forgotPassword(@Payload() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.VERIFY_OTP)
  verifyOtp(@Payload() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.RESET_PASSWORD)
  resetPassword(@Payload() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.REGISTER_TENANT)
  registerTenant(@Payload() dto: RegisterTenantDto) {
    return this.authService.registerTenant(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.LOGIN)
  async login(@Payload() payload: LoginPayloadDto) {
    return await this.authService.login(payload.dto, payload.ipAddress, payload.userAgent);
  }

  @MessagePattern(MESSAGE_PATTERNS.AUTH.GET_LAST_LOGINS)
  getLastLogins(@Payload() dto: GetLastLoginsDto) {
    return this.authService.getLastLogins(dto.tenantIds);
  }

  // ==========================================
  // PROFILE & ACCOUNT SETTINGS HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GET_PROFILE)
  getProfile(@Payload() payload: SuperAdminIdPayloadDto) {
    return this.profileService.getProfile(payload.superAdminId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.UPDATE_PROFILE)
  updateProfile(@Payload() payload: UpdateProfilePayloadDto) {
    return this.profileService.updateProfile(payload.superAdminId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.UPDATE_AVATAR)
  updateAvatar(@Payload() payload: UpdateAvatarPayloadDto) {
    return this.profileService.updateAvatar(payload.superAdminId, payload.avatarUrl);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GET_SECURITY)
  getSecuritySettings(@Payload() payload: SuperAdminIdPayloadDto) {
    return this.profileService.getSecuritySettings(payload.superAdminId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GET_LOGIN_ACTIVITY)
  getLoginActivity(@Payload() payload: SuperAdminIdPayloadDto) {
    return this.profileService.getLoginActivity(payload.superAdminId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GET_RECOVERY)
  getRecoveryInfo(@Payload() payload: SuperAdminIdPayloadDto) {
    return this.profileService.getRecoveryInfo(payload.superAdminId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.CHANGE_PASSWORD)
  async changePassword(@Payload() payload: ChangePasswordPayloadDto) {
    return await this.profileService.changePassword(payload.superAdminId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.UPDATE_RECOVERY)
  async updateRecoveryDetails(@Payload() payload: UpdateRecoveryPayloadDto) {
    return await this.profileService.updateRecoveryDetails(payload.superAdminId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GENERATE_2FA)
  generateTwoFactor(@Payload() payload: GenerateTwoFactorPayloadDto) {
    return this.profileService.generateTwoFactor(payload.superAdminId, payload.code);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.ENABLE_2FA)
  async enableTwoFactor(@Payload() payload: ToggleTwoFactorPayloadDto) {
    return await this.profileService.enableTwoFactor(payload.superAdminId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.DISABLE_2FA)
  async disableTwoFactor(@Payload() payload: ToggleTwoFactorPayloadDto) {
    return await this.profileService.disableTwoFactor(payload.superAdminId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GET_NOTIFICATIONS)
  getNotificationPreferences(@Payload() payload: SuperAdminIdPayloadDto) {
    return this.profileService.getNotificationPreferences(payload.superAdminId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.UPDATE_NOTIFICATIONS)
  updateNotificationPreferences(@Payload() payload: UpdateNotificationsPayloadDto) {
    return this.profileService.updateNotificationPreferences(payload.superAdminId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.GET_SESSIONS)
  getActiveSessions(@Payload() payload: GetSessionsPayloadDto) {
    return this.profileService.getActiveSessions(payload.superAdminId, payload.currentSessionId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.REVOKE_SESSION)
  revokeSession(@Payload() payload: RevokeSessionPayloadDto) {
    return this.profileService.revokeSession(payload.superAdminId, payload.sessionId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PROFILE.REVOKE_OTHER_SESSIONS)
  revokeAllOtherSessions(@Payload() payload: RevokeOtherSessionsPayloadDto) {
    return this.profileService.revokeAllOtherSessions(payload.superAdminId, payload.currentSessionId);
  }

  // ==========================================
  // TENANT PROFILE HANDLERS (org admin, HR, employee — a signed-in tenant
  // user's own account, distinct from PROFILE above which is superadmin-only)
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.TENANT_PROFILE.GET_PROFILE)
  getTenantProfile(@Payload() payload: TenantProfileActorDto) {
    return this.tenantProfileService.getProfile(payload.authCredentialId, payload.tenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.TENANT_PROFILE.UPDATE_PROFILE)
  updateTenantProfile(@Payload() payload: UpdateTenantProfilePayloadDto) {
    return this.tenantProfileService.updateProfile(payload.authCredentialId, payload.tenantId, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.TENANT_PROFILE.CHANGE_PASSWORD)
  async changeTenantPassword(@Payload() payload: ChangeTenantPasswordPayloadDto) {
    return await this.tenantProfileService.changePassword(
      payload.authCredentialId,
      payload.tenantId,
      payload.dto,
    );
  }

  // ==========================================
  // MAIL SERVICE HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.MAIL.SEND_EMAIL)
  sendEmail(@Payload() dto: SendEmailDto) {
    return this.mailService.sendEmail(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.MAIL.SEND_TEMPLATE_EMAIL)
  sendTemplateEmail(@Payload() dto: SendTemplateEmailDto) {
    return this.mailService.sendTemplateEmail(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.MAIL.VERIFY_CONNECTION)
  verifyMailConnection() {
    return this.mailService.verifyConnection();
  }

  // ==========================================
  // FILE STORAGE SERVICE HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.FILE.UPLOAD_FILE)
  uploadFile(@Payload() payload: UploadFilePayloadDto) {
    const fileBuffer = Buffer.isBuffer(payload.file.buffer)
      ? payload.file.buffer
      : Buffer.from((payload.file.buffer as any).data || payload.file.buffer);

    return this.fileStorageService.uploadFile(
      { ...payload.file, buffer: fileBuffer },
      payload,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.GET_METADATA)
  getFileMetadata(@Payload() payload: FileIdPayloadDto) {
    return this.fileStorageService.getFileMetadata(payload.fileId, payload.userTenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE)
  downloadFile(@Payload() payload: FileIdPayloadDto) {
    return this.fileStorageService.downloadFile(payload.fileId, payload.userTenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.DOWNLOAD_PUBLIC_FILE)
  downloadPublicFile(@Payload() payload: { fileId: string }) {
    return this.fileStorageService.downloadPublicFile(payload.fileId);
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.DELETE_FILE)
  deleteFile(@Payload() payload: FileIdPayloadDto) {
    return this.fileStorageService.deleteFile(payload.fileId, payload.userTenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.GET_ACCESS_URL)
  getFileAccessUrl(@Payload() payload: FileIdPayloadDto) {
    return this.fileStorageService.getFileAccessUrl(payload.fileId, payload.userTenantId);
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.QUERY_FILES)
  queryFiles(@Payload() payload: FileQueryDto) {
    return this.fileStorageService.queryFiles(payload);
  }

  // ==========================================
  // GENERAL SETTINGS HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.GET_GENERAL)
  getGeneralSettings() {
    return this.generalSettingsService.getGeneral();
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.UPDATE_GENERAL)
  updateGeneralSettings(@Payload() dto: UpdateGeneralSettingsDto) {
    return this.generalSettingsService.updateGeneral(dto);
  }

  // ==========================================
  // SECURITY SETTINGS HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.GET_SECURITY)
  getPlatformSecuritySettings() {
    return this.securitySettingsService.getSecurity();
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.UPDATE_SECURITY)
  updateSecuritySettings(@Payload() dto: UpdateSecuritySettingsDto) {
    return this.securitySettingsService.updateSecurity(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.LIST_ALLOWED_IPS)
  listAllowedIps() {
    return this.securitySettingsService.listAllowedIps();
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.ADD_ALLOWED_IP)
  addAllowedIp(@Payload() dto: AddAllowedIpDto) {
    return this.securitySettingsService.addAllowedIp(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.REMOVE_ALLOWED_IP)
  removeAllowedIp(@Payload() dto: RemoveAllowedIpMessageDto) {
    return this.securitySettingsService.removeAllowedIp(dto.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.CHECK_IP_ALLOWED)
  async checkIpAllowed(@Payload() dto: CheckIpAllowedDto) {
    // Returns `enforcing` alongside `allowed` so IpAllowlistGuard can fail
    // closed when the allowlist is actually switched on and this service
    // later becomes unreachable. `allowed` is kept for older callers.
    return this.securitySettingsService.evaluateIp(dto.ip);
  }

  // ==========================================
  // CUSTOM DOMAINS HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.LIST_DOMAINS)
  listDomains() {
    return this.customDomainsService.list();
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.ADD_DOMAIN)
  addDomain(@Payload() dto: AddDomainDto) {
    return this.customDomainsService.add(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.UPDATE_DOMAIN)
  updateDomain(@Payload() payload: UpdateDomainMessageDto) {
    return this.customDomainsService.update(payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.REMOVE_DOMAIN)
  removeDomain(@Payload() dto: RemoveDomainMessageDto) {
    return this.customDomainsService.remove(dto.id);
  }

  // ==========================================
  // MAINTENANCE HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.GET_MAINTENANCE)
  getMaintenanceSettings() {
    return this.maintenanceSettingsService.getMaintenance();
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.UPDATE_MAINTENANCE)
  updateMaintenanceSettings(@Payload() dto: UpdateMaintenanceSettingsDto) {
    return this.maintenanceSettingsService.updateMaintenance(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.SETTINGS.GET_MAINTENANCE_STATE)
  getMaintenanceState() {
    return this.maintenanceSettingsService.getMaintenanceState();
  }

  // ==========================================
  // OVERVIEW TAB SUPPORT HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.AUDIT.GET_RECENT_ACTIVITY)
  getRecentActivity(@Payload() query: GetRecentActivityQueryDto) {
    return this.auditService.getRecentActivity(query?.limit || 10);
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.GET_STORAGE_BREAKDOWN)
  getStorageBreakdown() {
    return this.fileStorageService.getStorageBreakdown();
  }

  @MessagePattern(MESSAGE_PATTERNS.FILE.CHECK_HEALTH)
  checkFileStorageHealth() {
    return this.fileStorageService.checkHealth();
  }

  // ==========================================
  // HELP & SUPPORT HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.HELP.GET_OVERVIEW)
  getHelpOverview() {
    return this.helpSupportService.getOverview();
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.GET_CATEGORIES)
  getHelpCategories() {
    return this.helpSupportService.getCategories();
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.GET_RESOURCE_LINKS)
  getHelpResourceLinks() {
    return this.helpSupportService.getResourceLinks();
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.LIST_ARTICLES)
  listArticles(@Payload() query: GetArticlesQueryDto) {
    return this.helpSupportService.listArticles(query || {});
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.GET_ARTICLE)
  getArticle(@Payload() payload: HelpIdDto) {
    return this.helpSupportService.getArticle(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.CREATE_ARTICLE)
  createArticle(@Payload() dto: CreateArticleDto) {
    return this.helpSupportService.createArticle(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.UPDATE_ARTICLE)
  updateArticle(@Payload() payload: UpdateArticleMessageDto) {
    return this.helpSupportService.updateArticle(payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.DELETE_ARTICLE)
  deleteArticle(@Payload() payload: HelpIdDto) {
    return this.helpSupportService.deleteArticle(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.LIST_VIDEOS)
  listVideos(@Payload() query: GetVideosQueryDto) {
    return this.helpSupportService.listVideos(query || {});
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.GET_VIDEO)
  getVideo(@Payload() payload: HelpIdDto) {
    return this.helpSupportService.getVideo(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.CREATE_VIDEO)
  createVideo(@Payload() dto: CreateVideoTutorialDto) {
    return this.helpSupportService.createVideo(dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.UPDATE_VIDEO)
  updateVideo(@Payload() payload: UpdateVideoMessageDto) {
    return this.helpSupportService.updateVideo(payload.id, payload.dto);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.DELETE_VIDEO)
  deleteVideo(@Payload() payload: HelpIdDto) {
    return this.helpSupportService.deleteVideo(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.LIST_TICKETS)
  listTickets(@Payload() query: GetSupportTicketsQueryDto) {
    return this.helpSupportService.listTickets(query || {});
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.GET_TICKET)
  getTicket(@Payload() payload: HelpIdDto) {
    return this.helpSupportService.getTicket(payload.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.CREATE_TICKET)
  createTicket(@Payload() payload: CreateSupportTicketMessageDto) {
    return this.helpSupportService.createTicket(payload.dto, payload.createdBy, payload.createdByName);
  }

  @MessagePattern(MESSAGE_PATTERNS.HELP.UPDATE_TICKET)
  updateTicket(@Payload() payload: UpdateSupportTicketMessageDto) {
    return this.helpSupportService.updateTicket(payload.id, payload.dto);
  }
}
