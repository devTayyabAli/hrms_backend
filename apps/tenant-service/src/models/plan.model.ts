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
  HasMany,
  Index,
} from 'sequelize-typescript';
import { SupportType, SecurityLevel } from '@app/common';
import { Subscription } from './subscription.model';

@Table({
  tableName: 'plans',
})
export class Plan extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare monthlyPrice: number;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare yearlyPrice: number;

  @Default('USD')
  @Column({ allowNull: false })
  declare currency: string;

  @Column({ allowNull: false })
  declare maxEmployees: number;

  @Column({ allowNull: false })
  declare maxHrUsers: number;

  @Column({ allowNull: false })
  declare maxAdminUsers: number;

  @Column({ allowNull: false })
  declare storageGb: number;

  @Column({ allowNull: false })
  declare apiCallsPerMonth: number;

  @Column({ allowNull: false })
  declare dataRetentionDays: number;

  @Column({ allowNull: false })
  declare customReportsLimit: number;

  @Column({
    type: DataType.ENUM(...Object.values(SupportType)),
    allowNull: false,
  })
  declare supportType: SupportType;

  @Column({
    type: DataType.ENUM(...Object.values(SecurityLevel)),
    allowNull: false,
  })
  declare securityLevel: SecurityLevel;

  @Default(false)
  @Column({ allowNull: false })
  declare hasDedicatedAccountManager: boolean;

  @Index
  @Default(false)
  @Column({ allowNull: false })
  declare isCustom: boolean;

  @Index
  @Default(true)
  @Column({ allowNull: false })
  declare isActive: boolean;

  @HasMany(() => Subscription)
  declare subscriptions: Subscription[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
