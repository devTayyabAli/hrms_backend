import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';

@Table({ tableName: 'auth_credentials' })
export class AuthCredential extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false, unique: true })
  declare email: string;

  @Column({ allowNull: false })
  declare passwordHash: string;

  @Column({ allowNull: true })
  declare firstName: string;

  @Column({ allowNull: true })
  declare lastName: string;

  @Column({ allowNull: true })
  declare phone: string;

  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: true })
  declare tenantName: string;

  @Default('Admin')
  @Column({ allowNull: false })
  declare role: string;

  @Default(true)
  @Column
  declare isActive: boolean;

  @Column
  declare resetOtp: string;

  @Column(DataType.DATE)
  declare resetOtpExpiresAt: Date;

  @Column(DataType.ARRAY(DataType.STRING))
  declare passwordHistory: string[];

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

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
