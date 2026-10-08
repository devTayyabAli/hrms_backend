import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';
import { Logger } from '@nestjs/common';
import { CryptoUtils } from '@app/common';

@Table({ tableName: 'super_admins' })
export class SuperAdmin extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false, unique: true })
  declare email: string;

  @Column({ allowNull: false })
  declare passwordHash: string;

  @Column
  declare name: string;

  @Column
  declare resetOtp: string;

  @Column(DataType.DATE)
  declare resetOtpExpiresAt: Date;

  @Column(DataType.ARRAY(DataType.STRING))
  declare passwordHistory: string[];

  @Default('active')
  @Column
  declare status: string;

  @Column
  declare firstName: string;

  @Column
  declare lastName: string;

  @Column
  declare phone: string;

  @Column
  declare jobTitle: string;

  @Column
  declare department: string;

  /** Free-text location shown on the profile card, e.g. 'Lahore, Pakistan'. */
  @Column
  declare location: string;

  @Default('English')
  @Column
  declare language: string;

  @Default('UTC+05:00 (Asia/Karachi)')
  @Column
  declare timezone: string;

  @Column
  declare avatarUrl: string;

  @Column
  declare recoveryEmail: string;

  @Column
  declare recoveryPhone: string;

  @Default(false)
  @Column
  declare twoFactorEnabled: boolean;

  // Encrypted at rest (AES-256-GCM) — a leaked DB row alone must not be
  // enough to generate valid TOTP codes for this account. Never queried by
  // value (always looked up by admin id/email first), so encryption's
  // ciphertext-is-nondeterministic tradeoff doesn't affect any lookup.
  @Column({
    type: DataType.STRING,
    set(value: string | null) {
      this.setDataValue('twoFactorSecret', value ? CryptoUtils.encrypt(value) : value);
    },
    get(): string | null {
      const raw = this.getDataValue('twoFactorSecret');
      if (!raw) return raw;
      try {
        return CryptoUtils.decrypt(raw);
      } catch (error: any) {
        // Encrypted under a different ENCRYPTION_KEY than the one running
        // now. Read as "no secret" rather than throwing: every caller already
        // treats a missing secret as 2FA unavailable (login is refused, setup
        // issues a new one), whereas throwing here broke anything that reads
        // the whole row — the profile page included.
        new Logger('SuperAdmin').warn(
          `twoFactorSecret for super admin ${this.getDataValue('id')} could not be decrypted with the current ENCRYPTION_KEY (${error?.message ?? error}). Treating 2FA as not set up.`,
        );
        return null;
      }
    },
  })
  declare twoFactorSecret: string;

  @Column(DataType.DATE)
  declare passwordLastChangedAt: Date;

  @Column(DataType.DATE)
  declare lastLoginAt: Date;

  @Column
  declare lastLoginIp: string;

  // Failed-login lockout state (thresholds live in SecuritySettings).
  @Default(0)
  @Column
  declare failedLoginAttempts: number;

  @Column(DataType.DATE)
  declare lockedUntil: Date;
}
