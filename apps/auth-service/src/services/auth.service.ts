import {
  Injectable,
  Inject,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Op, col, fn, where } from 'sequelize';
import { PasswordPolicyService } from './password-policy.service';
import { SecuritySettingsService } from './security-settings.service';
import { AccountLockoutService } from './account-lockout.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { SuperAdmin, AuthCredential, UserSession } from '../models';
import {
  RegisterTenantDto,
  LoginDto,
  SuperAdminLoginDto,
  OnboardOrganizationDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  VerifyTwoFactorChallengeDto,
  RefreshTokenDto,
  LogoutDto,
  TotpUtil,
  BCRYPT_SALT_ROUNDS,
  PASSWORD_HISTORY_LIMIT,
  DEFAULT_PASSWORD_EXPIRY_DAYS,
  STRONG_PASSWORD_REGEX,
  STRONG_PASSWORD_MESSAGE,
  parseDurationMs,
  parseUserAgent,
  isAdminTierCredentialRole,
  EffectiveAuthorization,
  MESSAGE_PATTERNS,
  SERVICES,
} from '@app/common';
import { ConfigService } from '@nestjs/config';
import { OtpService } from './otp.service';
import { MailService } from './mail.service';
import { AuditService } from './audit.service';

interface SessionMeta {
  sessionId?: string;
  superAdminId?: string;
  authCredentialId?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    @InjectModel(SuperAdmin) private superAdminModel: typeof SuperAdmin,
    @InjectModel(AuthCredential) private credentialModel: typeof AuthCredential,
    @InjectModel(UserSession) private userSessionModel: typeof UserSession,
    private jwtService: JwtService,
    private otpService: OtpService,
    private mailService: MailService,
    private configService: ConfigService,
    private auditService: AuditService,
    private passwordPolicyService: PasswordPolicyService,
    private securitySettingsService: SecuritySettingsService,
    private accountLockoutService: AccountLockoutService,
  ) { }

  async onModuleInit() {
    // Seed default SuperAdmin if none exists
    const count = await this.superAdminModel.count();
    if (count === 0) {
      const email = this.configService.get<string>('SUPERADMIN_EMAIL', 'superadmin@system.com');
      const password = this.configService.get<string>('SUPERADMIN_PASSWORD', 'SuperAdmin@SecurePass2026!');
      // Allow the built-in seed credentials only in environments explicitly
      // named as local ones. The previous check keyed off `NODE_ENV ===
      // 'production'`, so every other value — 'staging', 'uat', 'demo', or
      // NODE_ENV simply unset — silently accepted the hardcoded password
      // that is committed to this repository. Requiring an explicit opt-in
      // list means an unrecognised environment fails closed instead.
      const env = this.configService.get<string>('NODE_ENV');
      const isLocalEnv = env === 'development' || env === 'test';

      if (!isLocalEnv && (!process.env.SUPERADMIN_EMAIL || !process.env.SUPERADMIN_PASSWORD)) {
        throw new Error(
          `SECURITY CONFIGURATION ERROR: SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD environment variables are required when NODE_ENV is '${env ?? 'unset'}'. The built-in seed credentials are only permitted when NODE_ENV is 'development' or 'test'.`,
        );
      }

      if (!STRONG_PASSWORD_REGEX.test(password)) {
        throw new Error(`SECURITY CONFIGURATION ERROR: SuperAdmin seed password ${STRONG_PASSWORD_MESSAGE}`);
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      await this.superAdminModel.create({
        email,
        name: 'System Super Admin',
        passwordHash,
        status: 'active',
        passwordHistory: [passwordHash],
        passwordLastChangedAt: new Date(),
      });
    }
  }

  /**
   * Resolves effective authorization for a tenant credential from the tenant database
   * (User -> UserRole -> Role -> RolePermission -> Permission).
   *
   * Single source of truth for both login and token refresh.
   */
  private async resolveEffectiveAuthorization(cred: AuthCredential): Promise<EffectiveAuthorization> {
    if (!cred.tenantId) {
      return {
        userId: null,
        isActive: cred.isActive,
        roles: [cred.role],
        roleIds: [],
        permissions: [],
        isFullAccess: false,
        primaryRole: cred.role,
      };
    }

    try {
      const auth = await firstValueFrom(
        this.userClient.send<EffectiveAuthorization>(
          MESSAGE_PATTERNS.ROLE.RESOLVE_EFFECTIVE_AUTHORIZATION,
          {
            tenantId: cred.tenantId,
            email: cred.email,
            credentialRole: cred.role,
          },
        ),
      );
      return (
        auth || {
          userId: null,
          isActive: cred.isActive,
          roles: [cred.role],
          roleIds: [],
          permissions: [],
          isFullAccess: false,
          primaryRole: cred.role,
        }
      );
    } catch (err: any) {
      this.logger.error(
        `Could not resolve effective authorization for ${cred.email} in tenant ${cred.tenantId}: ${err?.message ?? err}`,
      );
      throw new ServiceUnavailableException(
        'Your permissions could not be loaded. Please try again in a moment.',
      );
    }
  }

  private getRefreshExpiry(): string {
    return this.configService.get<string>('JWT_REFRESH_EXPIRY', '7d');
  }

  /**
   * Rejects a new password if it matches the account's current password or any
   * of its last PASSWORD_HISTORY_LIMIT hashes.
   */
  private async assertPasswordNotReused(
    newPassword: string,
    currentHash: string | null | undefined,
    history: string[] | null | undefined,
  ): Promise<void> {
    const candidates = [currentHash, ...(history || [])]
      .filter((hash): hash is string => !!hash)
      .slice(-PASSWORD_HISTORY_LIMIT);

    for (const hash of candidates) {
      if (await bcrypt.compare(newPassword, hash)) {
        throw new BadRequestException(
          `New password must not match any of your last ${PASSWORD_HISTORY_LIMIT} passwords.`,
        );
      }
    }
  }

  private appendPasswordHistory(history: string[] | null | undefined, newHash: string): string[] {
    return [...(history || []), newHash].slice(-PASSWORD_HISTORY_LIMIT);
  }

  private isPasswordExpired(passwordLastChangedAt: Date | null | undefined, createdAt: Date): boolean {
    const expiryDays = parseInt(
      this.configService.get<string>('PASSWORD_EXPIRY_DAYS', String(DEFAULT_PASSWORD_EXPIRY_DAYS)),
      10,
    );
    const referenceDate = passwordLastChangedAt || createdAt;
    if (!referenceDate) return false;
    return Date.now() - new Date(referenceDate).getTime() > expiryDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Issues an access + refresh token pair. If `sessionMeta.sessionId` is provided,
   * the existing session's refresh token is rotated in place (used by refreshToken());
   * otherwise a new session row is created (used at login).
   */
  private async issueTokenPair(
    accessPayload: Record<string, any>,
    sessionMeta: SessionMeta,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const sessionId = sessionMeta.sessionId || randomUUID();
    const refreshExpiry = this.getRefreshExpiry();

    // `sid` rides on the access token too, so the Sessions screen can mark
    // which row is the caller's own session ("Current") without a second
    // lookup — the refresh token alone isn't presented on normal requests.
    const accessToken = this.jwtService.sign({ ...accessPayload, sid: sessionId, type: 'access' });
    const refreshToken = this.jwtService.sign(
      { sub: accessPayload.sub, sid: sessionId, type: 'refresh' },
      { expiresIn: refreshExpiry as any },
    );

    const refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_SALT_ROUNDS);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + parseDurationMs(refreshExpiry));

    if (sessionMeta.sessionId) {
      await this.userSessionModel.update(
        { refreshTokenHash, lastActiveAt: now, expiresAt },
        { where: { id: sessionId } },
      );
    } else {
      // Device/browser/OS are parsed from the User-Agent so the Sessions
      // screen can show "MacBook Pro / Chrome 126" instead of a raw UA blob.
      // `location` is deliberately left unset: deriving a city from an IP
      // needs a geo-IP provider, and none is configured.
      const agent = parseUserAgent(sessionMeta.userAgent);
      await this.userSessionModel.create({
        id: sessionId,
        superAdminId: sessionMeta.superAdminId,
        authCredentialId: sessionMeta.authCredentialId,
        device: agent.device,
        browser: agent.browser,
        operatingSystem: agent.operatingSystem,
        ipAddress: sessionMeta.ipAddress || 'unknown',
        lastActiveAt: now,
        status: 'active',
        refreshTokenHash,
        expiresAt,
      });
    }

    return { accessToken, refreshToken };
  }

  /**
   * Create or update AuthCredential for Organization Admin activation
   */
  /**
   * Whether `email` can become a login in `tenantId`. A login (credential)
   * is unique per email across the platform, so an address already used in
   * another organization — or by the platform super-admin — can't be invited
   * here. A login in this same tenant is fine (re-activation). Compared
   * case-insensitively, so 'Ayesha@x.com' and 'ayesha@x.com' are one person.
   */
  async checkEmailAvailable(email: string, tenantId: string): Promise<{ available: boolean; reason: 'OTHER_ORGANIZATION' | 'PLATFORM_ADMIN' | null }> {
    const normalized = String(email ?? '').trim().toLowerCase();
    const sameEmail = (column = 'email') => where(fn('lower', col(column)), normalized);
    const [credential, superAdmin] = await Promise.all([
      this.credentialModel.findOne({ where: sameEmail(), attributes: ['id', 'tenantId'] }),
      this.superAdminModel.findOne({ where: sameEmail(), attributes: ['id'] }),
    ]);
    if (superAdmin) return { available: false, reason: 'PLATFORM_ADMIN' };
    if (credential?.tenantId && credential.tenantId !== tenantId) return { available: false, reason: 'OTHER_ORGANIZATION' };
    return { available: true, reason: null };
  }

  async createAdminCredential(data: {
    email: string;
    password: string;
    tenantId: string;
    tenantName?: string;
    role?: string;
    firstName?: string;
    lastName?: string;
  }) {
    const existing = await this.credentialModel.findOne({ where: { email: data.email } });
    await this.passwordPolicyService.validate(data.password);

    if (existing) {
      // Never hijack a credential that already belongs to a different tenant.
      // Same-tenant retries (idempotent re-activation) are allowed through.
      if (existing.tenantId && data.tenantId && existing.tenantId !== data.tenantId) {
        throw new ForbiddenException(
          'This email is already registered under a different organization and cannot be re-activated here.',
        );
      }
      await this.assertPasswordNotReused(data.password, existing.passwordHash, existing.passwordHistory);
      const passwordHash = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
      await existing.update({
        passwordHash,
        tenantId: data.tenantId,
        tenantName: data.tenantName || existing.tenantName,
        role: data.role || 'Admin',
        isActive: true,
        // Never clobber a name the admin already has (e.g. edited via My Profile) —
        // only fill it in when the existing record has none, such as a re-activation
        // of a credential created before this field existed.
        firstName: existing.firstName || data.firstName || existing.firstName,
        lastName: existing.lastName || data.lastName || existing.lastName,
        passwordHistory: this.appendPasswordHistory(existing.passwordHistory, passwordHash),
        passwordLastChangedAt: new Date(),
      });
      return { message: 'Admin credential updated successfully', credentialId: existing.id };
    }

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
    const credential = await this.credentialModel.create({
      email: data.email,
      passwordHash,
      tenantId: data.tenantId,
      tenantName: data.tenantName || 'Organization',
      role: data.role || 'Admin',
      isActive: true,
      firstName: data.firstName,
      lastName: data.lastName,
      passwordHistory: [passwordHash],
      passwordLastChangedAt: new Date(),
    });

    return { message: 'Admin credential created successfully', credentialId: credential.id };
  }

  /**
   * Best-effort cleanup called when an Employee/HR record tied to this
   * credential is deleted. Scoped by both email and tenantId, same as
   * `createAdminCredential`'s hijack guard — this must never touch a
   * credential belonging to a different tenant, and a credential simply not
   * existing in this tenant (e.g. activation never completed) is not an
   * error, just nothing to do.
   */
  /**
   * Suspends (or, with `isActive: true`, restores) a tenant login — used when
   * an employee is deactivated, resigns or is reactivated. A suspended
   * credential can't sign in, and its refresh is refused because the user
   * record is suspended alongside it.
   */
  async deactivateTenantCredential(email: string, tenantId: string, isActive = false) {
    const credential = await this.credentialModel.findOne({ where: { email, tenantId } });
    if (!credential) {
      return { message: 'No credential found for this tenant — nothing to change.' };
    }
    await credential.update({ isActive });
    return { message: isActive ? 'Credential reactivated successfully' : 'Credential deactivated successfully' };
  }

  async superAdminLogin(dto: SuperAdminLoginDto, ipAddress?: string, userAgent?: string) {
    const admin = await this.superAdminModel.findOne({ where: { email: dto.email } });

    // Checked before the password comparison so a locked account can't be
    // probed, and only for a known account so this can't be used to tell
    // registered emails apart from unregistered ones.
    if (admin) {
      this.accountLockoutService.assertNotLocked(admin);
    }

    if (!admin || !(await bcrypt.compare(dto.password, admin.passwordHash))) {
      if (admin) {
        await this.accountLockoutService.registerFailedAttempt(admin);
      }
      await this.auditService.log({
        action: 'LOGIN_FAILED',
        actorType: 'superadmin',
        email: dto.email,
        ipAddress,
        userAgent,
        reason: 'invalid_credentials',
      });
      throw new UnauthorizedException('Invalid SuperAdmin credentials.');
    }

    await this.accountLockoutService.registerSuccess(admin);

    // Real enforcement of Security tab's "2FA for Super Admins" toggle: an
    // account that hasn't set up 2FA yet is blocked from logging in (rather
    // than silently allowed through) once platform policy requires it.
    const securitySettings = await this.securitySettingsService.getOrCreate();
    if (securitySettings.require2FASuperAdmins && !admin.twoFactorEnabled) {
      throw new ForbiddenException(
        'Platform policy requires Two-Factor Authentication for SuperAdmin accounts. Please enable 2FA before logging in.',
      );
    }

    // If 2FA is enabled, issue a temporary challenge token instead of full access token
    if (admin.twoFactorEnabled) {
      const challengeToken = this.jwtService.sign(
        {
          sub: admin.id,
          id: admin.id,
          email: admin.email,
          is2faPending: true,
          // Tagged explicitly so JwtStrategy rejects it as an access token.
          // Without this claim the token was indistinguishable from one, and
          // the strategy only rejected tokens whose `type` was present and
          // wrong — so a half-authenticated challenge token passed
          // JwtAuthGuard. It was contained by RolesGuard and TenantGuard
          // (the payload carries no roles and no tenantId), but that was
          // luck rather than design.
          type: '2fa_challenge',
        },
        { expiresIn: '5m' },
      );

      await this.auditService.log({
        action: 'LOGIN_2FA_REQUIRED',
        actorType: 'superadmin',
        userId: admin.id,
        email: admin.email,
        ipAddress,
        userAgent,
      });

      return {
        requiresTwoFactor: true,
        message: 'Two-Factor Authentication code required.',
        challengeToken,
      };
    }

    // Record login activity & session
    const now = new Date();
    await admin.update({
      lastLoginAt: now,
      lastLoginIp: ipAddress || 'unknown',
    });

    const { accessToken, refreshToken } = await this.issueTokenPair(
      {
        sub: admin.id,
        id: admin.id,
        email: admin.email,
        isSuperAdmin: true,
        role: 'SuperAdmin',
        roles: ['superadmin'],
      },
      { superAdminId: admin.id, ipAddress, userAgent },
    );

    await this.auditService.log({
      action: 'LOGIN_SUCCESS',
      actorType: 'superadmin',
      userId: admin.id,
      email: admin.email,
      ipAddress,
      userAgent,
    });

    return {
      message: 'SuperAdmin login successful',
      accessToken,
      refreshToken,
      passwordExpired: this.isPasswordExpired(admin.passwordLastChangedAt, admin.createdAt),
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'SuperAdmin',
      },
    };
  }

  /**
   * Verify 2FA Login Challenge Code
   */
  async verifyTwoFactorLogin(dto: VerifyTwoFactorChallengeDto, ipAddress?: string, userAgent?: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(dto.challengeToken);
    } catch {
      await this.auditService.log({
        action: 'TWO_FA_FAILED',
        actorType: 'superadmin',
        ipAddress,
        userAgent,
        reason: 'invalid_or_expired_challenge_token',
      });
      throw new UnauthorizedException('2FA challenge token is invalid or expired.');
    }

    // Require the challenge tag as well as the pending flag, so an access or
    // refresh token cannot be replayed into the 2FA exchange to mint a fresh
    // session — the reverse of the hole closed in JwtStrategy.
    if (
      !payload ||
      payload.type !== '2fa_challenge' ||
      !payload.is2faPending ||
      (!payload.sub && !payload.id)
    ) {
      await this.auditService.log({
        action: 'TWO_FA_FAILED',
        actorType: 'superadmin',
        ipAddress,
        userAgent,
        reason: 'invalid_challenge_payload',
      });
      throw new UnauthorizedException('Invalid 2FA challenge token payload.');
    }

    const adminId = payload.sub || payload.id;
    const admin = await this.superAdminModel.findByPk(adminId);

    if (!admin || !admin.twoFactorEnabled || !admin.twoFactorSecret) {
      await this.auditService.log({
        action: 'TWO_FA_FAILED',
        actorType: 'superadmin',
        userId: adminId,
        ipAddress,
        userAgent,
        reason: 'two_factor_not_configured',
      });
      throw new BadRequestException('2FA is not enabled or secret is missing for this account.');
    }

    const isValid = TotpUtil.verify(dto.code, admin.twoFactorSecret);
    if (!isValid) {
      await this.auditService.log({
        action: 'TWO_FA_FAILED',
        actorType: 'superadmin',
        userId: admin.id,
        email: admin.email,
        ipAddress,
        userAgent,
        reason: 'invalid_otp_code',
      });
      throw new UnauthorizedException('Invalid 2FA verification code.');
    }

    const now = new Date();
    await admin.update({
      lastLoginAt: now,
      lastLoginIp: ipAddress || 'unknown',
    });

    const { accessToken, refreshToken } = await this.issueTokenPair(
      {
        sub: admin.id,
        id: admin.id,
        email: admin.email,
        isSuperAdmin: true,
        role: 'SuperAdmin',
        roles: ['superadmin'],
      },
      { superAdminId: admin.id, ipAddress, userAgent },
    );

    await this.auditService.log({
      action: 'LOGIN_SUCCESS',
      actorType: 'superadmin',
      userId: admin.id,
      email: admin.email,
      ipAddress,
      userAgent,
      reason: 'via_2fa',
    });

    return {
      message: 'SuperAdmin 2FA login successful',
      accessToken,
      refreshToken,
      passwordExpired: this.isPasswordExpired(admin.passwordLastChangedAt, admin.createdAt),
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'SuperAdmin',
      },
    };
  }

  async onboardOrganization(dto: OnboardOrganizationDto) {
    const existingCred = await this.credentialModel.findOne({ where: { email: dto.adminEmail } });
    if (existingCred) {
      throw new BadRequestException('Admin user email already registered.');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const tenantId = `tenant-${dto.domain.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

    const credential = await this.credentialModel.create({
      email: dto.adminEmail,
      passwordHash,
      tenantId,
      tenantName: dto.companyName,
      role: 'Admin',
      passwordHistory: [passwordHash],
      passwordLastChangedAt: new Date(),
    });

    const { accessToken, refreshToken } = await this.issueTokenPair(
      {
        sub: credential.id,
        id: credential.id,
        email: credential.email,
        tenantId: credential.tenantId,
        role: 'Admin',
        roles: ['Admin'],
      },
      { authCredentialId: credential.id },
    );

    return {
      message: 'Organization onboarded successfully',
      tenantId: credential.tenantId,
      credentialId: credential.id,
      accessToken,
      refreshToken,
    };
  }

  /**
   * Emails a reset OTP.
   *
   * Both branches answer with the identical message, and neither carries the
   * OTP. Returning it made the emailed code redundant: anyone who knew an
   * address could request a reset, read the code straight out of the response
   * and set a new password without ever holding the mailbox — the email step
   * was proof of nothing. A distinct "OTP sent successfully" reply for a real
   * account also confirmed which addresses exist, so the wording is shared too.
   */
  private static readonly RESET_REQUESTED_MESSAGE =
    'If an account exists, OTP reset instructions have been sent.';

  async forgotPassword(dto: ForgotPasswordDto) {
    const cred = await this.credentialModel.findOne({ where: { email: dto.email } });
    const superAdmin = await this.superAdminModel.findOne({ where: { email: dto.email } });

    if (!cred && !superAdmin) {
      return { message: AuthService.RESET_REQUESTED_MESSAGE };
    }

    // `generateOtp()` is async and returns an OtpRecord, not a string. This
    // call site previously did neither: it stored the un-awaited Promise
    // straight into the `resetOtp` string column, which Sequelize coerced to
    // "[object Promise]". Every subsequent comparison against a
    // user-submitted code failed, so password reset was inoperable for every
    // account, and the emailed code rendered as "[object Promise]" too.
    const { code, hashedCode, expiresAt } = await this.otpService.generateOtp();

    // Only the bcrypt hash is persisted. A reset code is a password-equivalent
    // credential for the window it is valid, so a database read (or a leaked
    // backup) must not hand over working codes. OtpService already produced
    // this hash and already knows how to verify it — both were dead code
    // until now.
    if (cred) {
      await cred.update({ resetOtp: hashedCode, resetOtpExpiresAt: expiresAt });
    }
    if (superAdmin) {
      await superAdmin.update({
        resetOtp: hashedCode,
        resetOtpExpiresAt: expiresAt,
      });
    }

    await this.mailService.sendTemplateEmail({
      to: dto.email,
      subject: 'Password Reset OTP Code',
      templateName: 'otp_email',
      variables: {
        firstName: cred?.email || superAdmin?.name || 'User',
        otp: code,
        organizationName: cred?.tenantName || 'HRMS Platform',
      },
    });

    // The code is never returned. Email is the delivery channel and the only
    // proof of address ownership the flow has; echoing it in the response
    // would let anyone who can reach this handler reset any account by
    // reading their own reply. The shared constant is what keeps this
    // identical to the account-not-found branch above, so the endpoint also
    // can't be used to discover which addresses exist.
    return { message: AuthService.RESET_REQUESTED_MESSAGE };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const cred = await this.credentialModel.findOne({ where: { email: dto.email } });
    const superAdmin = await this.superAdminModel.findOne({ where: { email: dto.email } });

    const target = cred || superAdmin;
    // Delegated to OtpService so the stored bcrypt hash is compared with
    // bcrypt.compare and expiry is checked in one place. The previous
    // `target.resetOtp !== dto.otp` was a plaintext equality check against a
    // column that now holds a hash.
    if (!target) {
      throw new BadRequestException('Invalid or expired OTP code.');
    }
    await this.assertOtpValid(target, dto.otp);

    return { message: 'OTP verified successfully.' };
  }

  /**
   * Verify a submitted reset code against the stored hash, or throw.
   *
   * Shared by verifyOtp and resetPassword so the two cannot drift — a
   * verification that accepted a code in one and rejected it in the other
   * would be worse than either behaviour alone. The thrown message is
   * deliberately identical for "no code on file", "wrong code" and "expired",
   * so a caller cannot use the difference to probe account state.
   */
  private async assertOtpValid(
    target: { resetOtp: string; resetOtpExpiresAt: Date },
    submitted: string,
  ): Promise<void> {
    // verifyOtp signals every failure by throwing (it only ever returns
    // true), and its messages distinguish "no code on file" from "wrong code"
    // from "expired". Collapsing them into one message here keeps the three
    // cases indistinguishable to a caller probing account state, while
    // leaving the specific reason available in OtpService for logs.
    try {
      await this.otpService.verifyOtp(
        submitted,
        target.resetOtp,
        target.resetOtpExpiresAt,
      );
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw new BadRequestException('Invalid or expired OTP code.');
      }
      throw err;
    }
  }

  async resetPassword(dto: ResetPasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match.');
    }

    const cred = await this.credentialModel.findOne({ where: { email: dto.email } });
    const superAdmin = await this.superAdminModel.findOne({ where: { email: dto.email } });

    const target = cred || superAdmin;
    if (!target) {
      throw new BadRequestException('Invalid or expired OTP code.');
    }
    await this.assertOtpValid(target, dto.otp);

    await this.assertPasswordNotReused(dto.newPassword, target.passwordHash, target.passwordHistory);
    await this.passwordPolicyService.validate(dto.newPassword);

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_SALT_ROUNDS);

    await target.update({
      passwordHash,
      resetOtp: null,
      resetOtpExpiresAt: null,
      passwordHistory: this.appendPasswordHistory(target.passwordHistory, passwordHash),
      passwordLastChangedAt: new Date(),
    });

    return { message: 'Password reset successfully.' };
  }

  async registerTenant(dto: RegisterTenantDto) {
    const existing = await this.credentialModel.findOne({ where: { email: dto.adminEmail } });
    if (existing) {
      throw new BadRequestException('Email already registered');
    }
    await this.passwordPolicyService.validate(dto.password);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const credential = await this.credentialModel.create({
      email: dto.adminEmail,
      passwordHash,
      tenantId: dto.domain,
      tenantName: dto.companyName,
      role: 'Admin',
      passwordHistory: [passwordHash],
      passwordLastChangedAt: new Date(),
    });

    const { accessToken, refreshToken } = await this.issueTokenPair(
      {
        sub: credential.id,
        id: credential.id,
        email: credential.email,
        tenantId: credential.tenantId,
        role: 'Admin',
        roles: ['Admin'],
      },
      { authCredentialId: credential.id },
    );

    return {
      message: 'Tenant registered successfully',
      accessToken,
      refreshToken,
      tenant: { id: credential.tenantId, name: credential.tenantName },
    };
  }

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string) {
    const cred = await this.credentialModel.findOne({ where: { email: dto.email } });

    if (cred) {
      this.accountLockoutService.assertNotLocked(cred);
    }

    if (!cred || !(await bcrypt.compare(dto.password, cred.passwordHash))) {
      if (cred) {
        await this.accountLockoutService.registerFailedAttempt(cred);
      }
      await this.auditService.log({
        action: 'LOGIN_FAILED',
        actorType: 'tenant',
        email: dto.email,
        ipAddress,
        userAgent,
        reason: 'invalid_credentials',
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.accountLockoutService.registerSuccess(cred);

    const effectiveAuth = await this.resolveEffectiveAuthorization(cred);

    if (effectiveAuth.isActive === false) {
      throw new UnauthorizedException('Account is no longer active.');
    }

    const effectiveRole = effectiveAuth.primaryRole || cred.role;

    const { accessToken, refreshToken } = await this.issueTokenPair(
      {
        sub: cred.id,
        id: cred.id,
        tenantUserId: effectiveAuth.userId,
        email: cred.email,
        tenantId: cred.tenantId,
        role: effectiveRole,
        roles: effectiveAuth.roles.length > 0 ? effectiveAuth.roles : [effectiveRole],
        permissions: effectiveAuth.permissions,
        isFullAccess: effectiveAuth.isFullAccess,
        dataScope: effectiveAuth.dataScope,
      },
      { authCredentialId: cred.id, ipAddress, userAgent },
    );

    await cred.update({
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress || 'unknown',
      ...(effectiveRole && cred.role !== effectiveRole ? { role: effectiveRole } : {}),
    });

    await this.auditService.log({
      action: 'LOGIN_SUCCESS',
      actorType: 'tenant',
      userId: cred.id,
      email: cred.email,
      tenantId: cred.tenantId,
      ipAddress,
      userAgent,
    });

    return {
      message: 'Login successful',
      accessToken,
      refreshToken,
      passwordExpired: this.isPasswordExpired(cred.passwordLastChangedAt, cred.createdAt),
      user: {
        id: cred.id,
        tenantUserId: effectiveAuth.userId,
        email: cred.email,
        tenantId: cred.tenantId,
        role: effectiveRole,
        roles: effectiveAuth.roles.length > 0 ? effectiveAuth.roles : [effectiveRole],
        permissions: effectiveAuth.permissions,
        isFullAccess: effectiveAuth.isFullAccess,
        dataScope: effectiveAuth.dataScope,
      },
    };
  }

  /**
   * Bulk last-login lookup for the platform Clients directory (grouped by
   * tenant since AuthCredential has no reference to a user-service User.id —
   * the caller matches rows by tenantId + email). Only the tenant's Admin
   * account has a row here today; HR/Employee tenant users have no login
   * path implemented anywhere in this codebase yet.
   */
  async getLastLogins(tenantIds: string[]): Promise<Record<string, { email: string; lastLoginAt: Date | null }[]>> {
    const credentials = await this.credentialModel.findAll({
      where: { tenantId: { [Op.in]: tenantIds } },
      attributes: ['tenantId', 'email', 'lastLoginAt'],
    });

    const result: Record<string, { email: string; lastLoginAt: Date | null }[]> = {};
    for (const cred of credentials) {
      if (!result[cred.tenantId]) result[cred.tenantId] = [];
      result[cred.tenantId].push({ email: cred.email, lastLoginAt: cred.lastLoginAt });
    }
    return result;
  }

  /**
   * Rotates a refresh token: verifies it, checks it against the stored hash on its
   * session, and — if valid — issues a new access + refresh token pair while
   * invalidating the old refresh token. A hash mismatch means the presented token
   * was already rotated out (stolen/replayed), so the whole session is revoked.
   */
  async refreshToken(dto: RefreshTokenDto, ipAddress?: string, userAgent?: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(dto.refreshToken);
    } catch {
      await this.auditService.log({
        action: 'TOKEN_REFRESH_FAILED',
        actorType: 'unknown',
        ipAddress,
        userAgent,
        reason: 'invalid_or_expired_token',
      });
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }

    if (!payload || payload.type !== 'refresh' || !payload.sid) {
      await this.auditService.log({
        action: 'TOKEN_REFRESH_FAILED',
        actorType: 'unknown',
        userId: payload?.sub,
        ipAddress,
        userAgent,
        reason: 'invalid_token_payload',
      });
      throw new UnauthorizedException('Invalid refresh token.');
    }

    const session = await this.userSessionModel.findByPk(payload.sid);
    if (!session || session.status !== 'active' || new Date() > session.expiresAt) {
      await this.auditService.log({
        action: 'TOKEN_REFRESH_FAILED',
        actorType: 'unknown',
        userId: payload.sub,
        ipAddress,
        userAgent,
        reason: 'session_invalid_or_expired',
      });
      throw new UnauthorizedException('Session is no longer valid. Please log in again.');
    }

    const isValidToken = await bcrypt.compare(dto.refreshToken, session.refreshTokenHash);
    if (!isValidToken) {
      await session.update({
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: 'Refresh token reuse detected',
      });
      await this.auditService.log({
        action: 'TOKEN_REFRESH_FAILED',
        actorType: session.superAdminId ? 'superadmin' : 'tenant',
        userId: session.superAdminId || session.authCredentialId,
        ipAddress,
        userAgent,
        reason: 'reuse_detected_session_revoked',
      });
      throw new UnauthorizedException('Refresh token has already been used. Please log in again.');
    }

    let accessPayload: Record<string, any>;
    const actorType: 'superadmin' | 'tenant' = session.superAdminId ? 'superadmin' : 'tenant';

    if (session.superAdminId) {
      const admin = await this.superAdminModel.findByPk(session.superAdminId);
      if (!admin || admin.status !== 'active') {
        await session.update({ status: 'revoked', revokedAt: new Date(), revokedReason: 'Account inactive' });
        await this.auditService.log({
          action: 'TOKEN_REFRESH_FAILED',
          actorType: 'superadmin',
          userId: session.superAdminId,
          ipAddress,
          userAgent,
          reason: 'account_inactive',
        });
        throw new UnauthorizedException('Account is no longer active.');
      }
      accessPayload = {
        sub: admin.id,
        id: admin.id,
        email: admin.email,
        isSuperAdmin: true,
        role: 'SuperAdmin',
        roles: ['superadmin'],
      };
    } else if (session.authCredentialId) {
      const cred = await this.credentialModel.findByPk(session.authCredentialId);
      if (!cred || !cred.isActive) {
        await session.update({ status: 'revoked', revokedAt: new Date(), revokedReason: 'Account inactive' });
        await this.auditService.log({
          action: 'TOKEN_REFRESH_FAILED',
          actorType: 'tenant',
          userId: session.authCredentialId,
          ipAddress,
          userAgent,
          reason: 'account_inactive',
        });
        throw new UnauthorizedException('Account is no longer active.');
      }

      const effectiveAuth = await this.resolveEffectiveAuthorization(cred);
      if (effectiveAuth.isActive === false) {
        await session.update({ status: 'revoked', revokedAt: new Date(), revokedReason: 'Account inactive' });
        await this.auditService.log({
          action: 'TOKEN_REFRESH_FAILED',
          actorType: 'tenant',
          userId: session.authCredentialId,
          ipAddress,
          userAgent,
          reason: 'account_inactive',
        });
        throw new UnauthorizedException('Account is no longer active.');
      }

      const effectiveRole = effectiveAuth.primaryRole || cred.role;

      accessPayload = {
        sub: cred.id,
        id: cred.id,
        tenantUserId: effectiveAuth.userId,
        email: cred.email,
        tenantId: cred.tenantId,
        role: effectiveRole,
        roles: effectiveAuth.roles.length > 0 ? effectiveAuth.roles : [effectiveRole],
        // Re-resolved on every rotation, so a change in user_roles or
        // permissions reaches the user on their next refresh.
        permissions: effectiveAuth.permissions,
        isFullAccess: effectiveAuth.isFullAccess,
        dataScope: effectiveAuth.dataScope,
      };
    } else {
      throw new UnauthorizedException('Session is not linked to a valid account.');
    }

    const tokens = await this.issueTokenPair(accessPayload, { sessionId: session.id });

    await this.auditService.log({
      action: 'TOKEN_REFRESH',
      actorType,
      userId: accessPayload.sub,
      email: accessPayload.email,
      tenantId: accessPayload.tenantId,
      ipAddress,
      userAgent,
    });

    return tokens;
  }

  /**
   * Revokes the session tied to the given refresh token, if any. Always
   * succeeds from the caller's perspective (idempotent, no information leak).
   */
  async logout(dto: LogoutDto, ipAddress?: string, userAgent?: string) {
    if (dto.refreshToken) {
      try {
        const payload: any = this.jwtService.verify(dto.refreshToken);
        if (payload?.sid) {
          const session = await this.userSessionModel.findByPk(payload.sid);
          if (session && session.status === 'active') {
            await session.update({
              status: 'logged_out',
              revokedAt: new Date(),
              revokedReason: 'User logout',
            });

            await this.auditService.log({
              action: 'LOGOUT',
              actorType: session.superAdminId ? 'superadmin' : 'tenant',
              userId: session.superAdminId || session.authCredentialId,
              ipAddress,
              userAgent,
            });
          }
        }
      } catch {
        // Invalid/expired token — nothing to revoke.
      }
    }

    return { message: 'Logged out successfully.' };
  }
}
