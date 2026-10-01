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
  ForeignKey,
  BelongsTo,
  HasMany,
  Index,
} from 'sequelize-typescript';
import {
  SubscriptionStatus,
  BillingCycle,
  SupportType,
  SecurityLevel,
} from '@app/common';
import { Tenant } from './tenant.model';
import { Plan } from './plan.model';
import { Payment } from './payment.model';
import { Invoice } from './invoice.model';

export interface SubscriptionSnapshotLimits {
  maxEmployees: number;
  maxHrUsers: number;
  maxAdminUsers: number;
  storageGb: number;
  apiCallsPerMonth: number;
  dataRetentionDays: number;
  customReportsLimit: number;
  supportType: SupportType;
  securityLevel: SecurityLevel;
}

@Table({
  tableName: 'subscriptions',
  indexes: [
    { fields: ['tenantId', 'status'] },
    { fields: ['status', 'nextBillingDate'] },
    { fields: ['status', 'gracePeriodEndsAt'] },
  ],
})
export class Subscription extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Index
  @ForeignKey(() => Tenant)
  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Index
  @ForeignKey(() => Plan)
  @Column({ type: DataType.UUID, allowNull: false })
  declare planId: string;

  @Index
  @Default(SubscriptionStatus.PENDING_PAYMENT)
  @Column({
    type: DataType.ENUM(...Object.values(SubscriptionStatus)),
    defaultValue: SubscriptionStatus.PENDING_PAYMENT,
    allowNull: false,
  })
  declare status: SubscriptionStatus;

  @Default(BillingCycle.MONTHLY)
  @Column({
    type: DataType.ENUM(...Object.values(BillingCycle)),
    defaultValue: BillingCycle.MONTHLY,
    allowNull: false,
  })
  declare billingCycle: BillingCycle;

  @Default(DataType.NOW)
  @Column({ type: DataType.DATE, allowNull: false })
  declare startDate: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare nextBillingDate: Date;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare snapshotMonthlyPrice: number;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare snapshotYearlyPrice: number;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare snapshotLimits: SubscriptionSnapshotLimits;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelledAt: Date;

  @Column({ type: DataType.STRING, allowNull: true })
  declare cancellationReason: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare pastDueAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare gracePeriodEndsAt: Date;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Plan)
  declare plan: Plan;

  @HasMany(() => Payment)
  declare payments: Payment[];

  @HasMany(() => Invoice)
  declare invoices: Invoice[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
