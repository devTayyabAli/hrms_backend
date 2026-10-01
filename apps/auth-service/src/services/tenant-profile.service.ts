import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as bcrypt from 'bcrypt';
import { AuthCredential } from '../models';
import {
  UpdateTenantProfileDto,
  ChangePasswordDto,
  BCRYPT_SALT_ROUNDS,
  PASSWORD_HISTORY_LIMIT,
} from '@app/common';
import { PasswordPolicyService } from './password-policy.service';

/**
 * Self-service account for a signed-in tenant user — the org-admin (and,
 * once their own login exists, HR/Employee) equivalent of `ProfileService`,
 * scoped to `AuthCredential` rather than `SuperAdmin`. Every lookup is scoped
 * by both id and `tenantId`: the id alone is unambiguous, but every other
 * tenant-facing query in this codebase keeps the tenant check as
 * defense-in-depth, and this is no exception.
 */
@Injectable()
export class TenantProfileService {
  constructor(
    @InjectModel(AuthCredential) private readonly authCredentialModel: typeof AuthCredential,
    private readonly passwordPolicyService: PasswordPolicyService,
  ) {}

  private async findOwn(authCredentialId: string, tenantId: string): Promise<AuthCredential> {
    const credential = await this.authCredentialModel.findOne({
      where: { id: authCredentialId, tenantId },
    });
    if (!credential) {
      throw new NotFoundException('Account not found.');
    }
    return credential;
  }

  async getProfile(authCredentialId: string, tenantId: string) {
    const credential = await this.findOwn(authCredentialId, tenantId);

    return {
      id: credential.id,
      email: credential.email,
      firstName: credential.firstName || null,
      lastName: credential.lastName || null,
      phone: credential.phone || null,
      role: credential.role,
      isActive: credential.isActive,
      passwordLastChangedAt: credential.passwordLastChangedAt || credential.createdAt,
      lastLoginAt: credential.lastLoginAt || null,
      lastLoginIp: credential.lastLoginIp || null,
      createdAt: credential.createdAt,
    };
  }

  async updateProfile(authCredentialId: string, tenantId: string, dto: UpdateTenantProfileDto) {
    const credential = await this.findOwn(authCredentialId, tenantId);

    await credential.update({
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
    });

    return this.getProfile(authCredentialId, tenantId);
  }

  async changePassword(authCredentialId: string, tenantId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('New password and confirmation password do not match.');
    }

    const credential = await this.findOwn(authCredentialId, tenantId);

    const isValidCurrent = await bcrypt.compare(dto.currentPassword, credential.passwordHash);
    if (!isValidCurrent) {
      throw new UnauthorizedException('Current password provided is incorrect.');
    }

    const reusedCandidates = [credential.passwordHash, ...(credential.passwordHistory || [])].slice(
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
    const history = [...(credential.passwordHistory || []), newHash].slice(-PASSWORD_HISTORY_LIMIT);

    await credential.update({
      passwordHash: newHash,
      passwordLastChangedAt: new Date(),
      passwordHistory: history,
    });

    return { success: true, message: 'Password changed successfully.' };
  }
}
