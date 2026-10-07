import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { SuperAdmin, NotificationPreferences, UserSession } from '../models';
import {
  UpdateProfileDto,
  ChangePasswordDto,
  UpdateRecoveryDto,
  ToggleTwoFactorDto,
  UpdateNotificationsDto,
  TotpUtil,
  BCRYPT_SALT_ROUNDS,
  PASSWORD_HISTORY_LIMIT,
} from '@app/common';
import { PasswordPolicyService } from './password-policy.service';

@Injectable()
export class ProfileService {
  constructor(
    @InjectModel(SuperAdmin) private readonly superAdminModel: typeof SuperAdmin,
    @InjectModel(NotificationPreferences)
    private readonly notificationPrefModel: typeof NotificationPreferences,
    @InjectModel(UserSession) private readonly userSessionModel: typeof UserSession,
    private readonly passwordPolicyService: PasswordPolicyService,
  ) {}

  /**
   * Fetch Super Admin Profile
   */
  async getProfile(superAdminId: string, currentSessionId?: string) {
    const [admin, previous, current] = await Promise.all([
      this.superAdminModel.findByPk(superAdminId),
      this.previousLogin(superAdminId, currentSessionId),
      currentSessionId
        ? this.userSessionModel.findOne({
            where: { id: currentSessionId, superAdminId },
            attributes: ['createdAt', 'ipAddress'],
          })
        : null,
    ]);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    const {
      passwordHash,
      twoFactorSecret,
      resetOtp,
      resetOtpExpiresAt,
      passwordHistory,
      ...safeProfile
    } = admin.get({ plain: true });

    return {
      success: true,
      data: {
        ...safeProfile,
        // The sign-in before this one — `lastLoginAt` is overwritten by the
        // login that opened the current session, so it always read "now".
        previousLoginAt: previous?.createdAt ?? null,
        previousLoginIp: previous?.ipAddress ?? null,
        previousLoginBrowser: previous?.browser ?? null,
        previousLoginOs: previous?.operatingSystem ?? null,
        // When this session began, so the card can tell the two apart.
        currentSessionStartedAt: current?.createdAt ?? null,
        currentSessionIp: current?.ipAddress ?? null,
      },
    };
  }

  /**
   * Every sign-in opens its own session (a token refresh keeps the same one),
   * so the newest session other than the caller's is the previous sign-in.
   * Without the caller's session id, the current sign-in is the newest one
   * and the second newest is the previous.
   */
  private async previousLogin(superAdminId: string, currentSessionId?: string) {
    const sessions = await this.userSessionModel.findAll({
      where: {
        superAdminId,
        ...(currentSessionId ? { id: { [Op.ne]: currentSessionId } } : {}),
      },
      attributes: ['id', 'createdAt', 'ipAddress', 'browser', 'operatingSystem'],
      order: [['createdAt', 'DESC']],
      limit: currentSessionId ? 1 : 2,
    });
    return currentSessionId ? sessions[0] : sessions[1];
  }

  /**
   * Update Profile Details
   */
  async updateProfile(superAdminId: string, dto: UpdateProfileDto) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    await admin.update({
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle }),
      ...(dto.department !== undefined && { department: dto.department }),
      ...(dto.language !== undefined && { language: dto.language }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.location !== undefined && { location: dto.location }),
      ...(dto.firstName || dto.lastName
        ? { name: `${dto.firstName || ''} ${dto.lastName || ''}`.trim() }
        : {}),
    });

    return this.getProfile(superAdminId);
  }

  /**
   * Update Avatar URL
   */
  async updateAvatar(superAdminId: string, avatarUrl: string) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    await admin.update({ avatarUrl });
    return {
      success: true,
      message: 'Avatar updated successfully',
      avatarUrl,
    };
  }

  /**
   * Get Security Settings Summary
   */
  async getSecuritySettings(superAdminId: string) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    // The Security tab renders "Last changed N days ago", "N active sessions"
    // and the Login Alerts state, so those are computed here rather than
    // making the client derive them from three separate calls.
    const passwordChangedAt = admin.passwordLastChangedAt || admin.updatedAt;
    const passwordAgeDays = passwordChangedAt
      ? Math.floor((Date.now() - new Date(passwordChangedAt).getTime()) / 86400000)
      : null;

    const [activeSessionsCount, preferences] = await Promise.all([
      this.userSessionModel.count({ where: { superAdminId, status: 'active' } }),
      this.notificationPrefModel.findOne({ where: { superAdminId } }),
    ]);

    return {
      success: true,
      data: {
        passwordLastChangedAt: passwordChangedAt,
        passwordAgeDays,
        twoFactorEnabled: admin.twoFactorEnabled || false,
        loginAlertsEnabled: preferences ? preferences.loginAlerts : true,
        activeSessionsCount,
        recoveryEmail: admin.recoveryEmail || null,
        recoveryPhone: admin.recoveryPhone || null,
        lastLoginAt: admin.lastLoginAt || null,
        lastLoginIp: admin.lastLoginIp || null,
        accountStatus: admin.status || 'active',
        memberSince: admin.createdAt,
      },
    };
  }

  /**
   * Change Password
   */
  async changePassword(superAdminId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('New password and confirmation password do not match.');
    }

    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    const isValidCurrent = await bcrypt.compare(dto.currentPassword, admin.passwordHash);
    if (!isValidCurrent) {
      throw new UnauthorizedException('Current password provided is incorrect.');
    }

    const reusedCandidates = [admin.passwordHash, ...(admin.passwordHistory || [])].slice(
      -PASSWORD_HISTORY_LIMIT,
    );
    for (const hash of reusedCandidates) {
      if (await bcrypt.compare(dto.newPassword, hash)) {
        throw new BadRequestException(
          `New password must not match any of your last ${PASSWORD_HISTORY_LIMIT} passwords.`,
        );
      }
    }
    await this.passwordPolicyService.validate(dto.newPassword);

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_SALT_ROUNDS);
    const history = [...(admin.passwordHistory || []), newHash].slice(-PASSWORD_HISTORY_LIMIT);

    await admin.update({
      passwordHash: newHash,
      passwordLastChangedAt: new Date(),
      passwordHistory: history,
    });

    return {
      success: true,
      message: 'Password changed successfully.',
    };
  }

  /**
   * Update Recovery Email / Phone
   */
  async updateRecoveryDetails(superAdminId: string, dto: UpdateRecoveryDto) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    await admin.update({
      ...(dto.recoveryEmail !== undefined && { recoveryEmail: dto.recoveryEmail }),
      ...(dto.recoveryPhone !== undefined && { recoveryPhone: dto.recoveryPhone }),
    });

    return {
      success: true,
      message: 'Recovery information updated successfully.',
      data: {
        recoveryEmail: admin.recoveryEmail,
        recoveryPhone: admin.recoveryPhone,
      },
    };
  }

  /**
   * Generate 2FA Secret and QR Code
   */
  async generateTwoFactor(superAdminId: string, code?: string) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    // Rotating the secret of an account that already has 2FA switched on is
    // a credential change, so it has to be proved with the current factor.
    //
    // Without this check the endpoint was a 2FA takeover: it overwrote
    // `twoFactorSecret` with a freshly generated one and returned that secret
    // in the response, with nothing but a session cookie required. Anyone
    // holding a hijacked session could call it, enrol their own authenticator
    // and simultaneously lock the real owner's out — turning 2FA from a
    // second factor into a thing the first factor alone can replace, which is
    // precisely what it exists to prevent.
    //
    // While 2FA is off there is no second factor to prove and nothing to take
    // over, so first-time setup is unaffected.
    if (admin.twoFactorEnabled) {
      if (!code) {
        throw new BadRequestException(
          'Two-factor authentication is already enabled. Provide a current authenticator code to generate a new secret.',
        );
      }
      if (!admin.twoFactorSecret || !TotpUtil.verify(code, admin.twoFactorSecret)) {
        throw new BadRequestException('Invalid 2FA verification code.');
      }
    }

    const secret = TotpUtil.generateSecret();
    const otpAuthUrl = TotpUtil.generateURI('HRMS Platform', admin.email, secret);
    const qrCodeUrl = await QRCode.toDataURL(otpAuthUrl);

    await admin.update({ twoFactorSecret: secret });

    return {
      success: true,
      // Returned so an authenticator that cannot scan the QR code can be set
      // up by manual entry — the QR image encodes the same secret, so
      // withholding this field would not keep it off the wire, only make the
      // flow unusable without a camera. It is returned here and nowhere else:
      // getProfile() strips `twoFactorSecret` from every read.
      secret,
      qrCodeUrl,
    };
  }

  /**
   * Enable 2FA after code verification
   */
  async enableTwoFactor(superAdminId: string, dto: ToggleTwoFactorDto) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    if (!admin.twoFactorSecret) {
      throw new BadRequestException('Please generate 2FA secret first before enabling.');
    }

    if (!dto.code) {
      throw new BadRequestException('Verification code is required to enable 2FA.');
    }

    const isValid = TotpUtil.verify(dto.code, admin.twoFactorSecret);
    if (!isValid) {
      throw new BadRequestException('Invalid 2FA verification code.');
    }

    await admin.update({ twoFactorEnabled: true });

    return {
      success: true,
      message: 'Two-Factor Authentication has been enabled successfully.',
    };
  }

  /**
   * Disable 2FA
   */
  async disableTwoFactor(superAdminId: string, dto: ToggleTwoFactorDto) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    if (dto.password) {
      const isValidPassword = await bcrypt.compare(dto.password, admin.passwordHash);
      if (!isValidPassword) {
        throw new UnauthorizedException('Incorrect password provided.');
      }
    } else if (dto.code && admin.twoFactorSecret) {
      const isValidCode = TotpUtil.verify(dto.code, admin.twoFactorSecret);
      if (!isValidCode) {
        throw new BadRequestException('Invalid 2FA verification code.');
      }
    } else {
      throw new BadRequestException('Password or 2FA verification code required to disable 2FA.');
    }

    await admin.update({
      twoFactorEnabled: false,
      twoFactorSecret: null,
    });

    return {
      success: true,
      message: 'Two-Factor Authentication has been disabled.',
    };
  }

  /**
   * Get Notification Preferences
   */
  async getNotificationPreferences(superAdminId: string) {
    let [pref] = await this.notificationPrefModel.findOrCreate({
      where: { superAdminId },
      defaults: {
        superAdminId,
        accountUpdates: true,
        securityAlerts: true,
        systemAnnouncements: true,
        reportsAnalytics: true,
        pushNotifications: true,
        notificationFrequency: 'realtime',
        quietHoursEnabled: false,
        quietHoursStartTime: '22:00',
        quietHoursEndTime: '07:00',
      },
    });

    return {
      success: true,
      data: pref,
    };
  }

  /**
   * Update Notification Preferences
   */
  async updateNotificationPreferences(superAdminId: string, dto: UpdateNotificationsDto) {
    let pref = await this.notificationPrefModel.findOne({ where: { superAdminId } });
    if (!pref) {
      pref = await this.notificationPrefModel.create({
        superAdminId,
        ...dto,
      });
    } else {
      await pref.update(dto);
    }

    return {
      success: true,
      message: 'Notification preferences updated successfully.',
      data: pref,
    };
  }

  /**
   * Get User Sessions
   */
  async getActiveSessions(superAdminId: string, currentSessionId?: string) {
    const sessions = await this.userSessionModel.findAll({
      where: { superAdminId },
      order: [['lastActiveAt', 'DESC']],
    });

    /**
     * Shapes a row the way the Sessions table reads it: a combined
     * "MacBook Pro / Chrome 126" label, plus the flag that decides whether the
     * row shows "Current" or an "End Session" button. `location` stays null
     * unless a geo-IP provider is wired up — see the session-creation comment
     * in AuthService.
     */
    const toRow = (s: UserSession) => ({
      id: s.id,
      deviceBrowser: `${s.device || 'Unknown Device'} / ${s.browser || 'Unknown Browser'}`,
      device: s.device || null,
      browser: s.browser || null,
      operatingSystem: s.operatingSystem || null,
      location: s.location || null,
      ipAddress: s.ipAddress || null,
      lastActiveAt: s.lastActiveAt || s.createdAt,
      status: s.status,
      isCurrent: !!currentSessionId && s.id === currentSessionId,
      loggedOutAt: s.status === 'active' ? null : s.revokedAt || s.updatedAt,
    });

    const activeSessions = sessions.filter((s) => s.status === 'active').map(toRow);
    const loggedOutSessions = sessions.filter((s) => s.status !== 'active').map(toRow);

    return {
      success: true,
      data: {
        activeSessions,
        loggedOutSessions,
        activeCount: activeSessions.length,
      },
    };
  }

  /**
   * Revoke Specific Session
   */
  async revokeSession(superAdminId: string, sessionId: string) {
    const session = await this.userSessionModel.findOne({
      where: { id: sessionId, superAdminId },
    });

    if (!session) {
      throw new NotFoundException('Session not found.');
    }

    await session.update({
      status: 'revoked',
      revokedAt: new Date(),
      revokedReason: 'User initiated session revocation',
    });

    return {
      success: true,
      message: `Session ${sessionId} revoked successfully.`,
    };
  }

  /**
   * Revoke All Other Sessions
   */
  async revokeAllOtherSessions(superAdminId: string, currentSessionId?: string) {
    const whereCondition: any = {
      superAdminId,
      status: 'active',
    };

    if (currentSessionId) {
      whereCondition.id = { [require('sequelize').Op.ne]: currentSessionId };
    }

    const [updatedCount] = await this.userSessionModel.update(
      {
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: 'Revoked all other active sessions',
      },
      { where: whereCondition },
    );

    return {
      success: true,
      message: `${updatedCount} active session(s) revoked successfully.`,
    };
  }

  /**
   * Get Recent Login Activity
   */
  async getLoginActivity(superAdminId: string, currentSessionId?: string) {
    const sessions = await this.userSessionModel.findAll({
      where: { superAdminId },
      order: [['lastActiveAt', 'DESC']],
      limit: 20,
    });

    const activity = sessions.map((s) => ({
      id: s.id,
      // Missing values stay null — the screen says so — rather than being
      // filled with placeholders that read like real data.
      location: s.location || null,
      timestamp: s.lastActiveAt || s.createdAt,
      ipAddress: s.ipAddress && s.ipAddress !== 'unknown' ? s.ipAddress : null,
      device: s.device || null,
      browser: s.browser || null,
      operatingSystem: s.operatingSystem || null,
      status: s.status,
      isCurrent: Boolean(currentSessionId) && s.id === currentSessionId,
    }));

    return {
      success: true,
      data: activity,
    };
  }

  /**
   * Get Recovery Details
   */
  async getRecoveryInfo(superAdminId: string) {
    const admin = await this.superAdminModel.findByPk(superAdminId);
    if (!admin) {
      throw new NotFoundException('Super Admin profile not found.');
    }

    return {
      success: true,
      data: {
        recoveryEmail: admin.recoveryEmail || null,
        recoveryPhone: admin.recoveryPhone || null,
      },
    };
  }
}
