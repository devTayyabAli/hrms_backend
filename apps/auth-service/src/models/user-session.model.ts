import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  ForeignKey,
  BelongsTo,
  CreatedAt,
  UpdatedAt,
  Index,
} from 'sequelize-typescript';
import { SuperAdmin } from './super-admin.model';
import { AuthCredential } from './auth-credential.model';

@Table({ tableName: 'user_sessions' })
export class UserSession extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Index
  @ForeignKey(() => SuperAdmin)
  @Column({ allowNull: true })
  declare superAdminId: string;

  @BelongsTo(() => SuperAdmin)
  declare superAdmin: SuperAdmin;

  @Index
  @ForeignKey(() => AuthCredential)
  @Column({ allowNull: true })
  declare authCredentialId: string;

  @BelongsTo(() => AuthCredential)
  declare authCredential: AuthCredential;

  @Column
  declare device: string;

  @Column
  declare browser: string;

  @Column
  declare operatingSystem: string;

  @Column
  declare location: string;

  @Column
  declare ipAddress: string;

  @Column(DataType.DATE)
  declare lastActiveAt: Date;

  @Index
  @Default('active')
  @Column
  declare status: string; // 'active' | 'revoked' | 'logged_out'

  @Column
  declare refreshTokenHash: string;

  @Index
  @Column(DataType.DATE)
  declare expiresAt: Date;

  @Column(DataType.DATE)
  declare revokedAt: Date;

  @Column
  declare revokedReason: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
