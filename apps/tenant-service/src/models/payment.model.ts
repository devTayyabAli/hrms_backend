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
  HasOne,
  Index,
} from 'sequelize-typescript';
import { PaymentStatus, PaymentMethod, BillingCycle } from '@app/common';
import { Tenant } from './tenant.model';
import { Subscription } from './subscription.model';
import { Invoice } from './invoice.model';

@Table({
  tableName: 'payments',
  indexes: [
    { fields: ['tenantId', 'status'] },
    { fields: ['subscriptionId', 'status'] },
    { fields: ['providerTransactionId'] },
  ],
})
export class Payment extends Model {
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
  @ForeignKey(() => Subscription)
  @Column({ type: DataType.UUID, allowNull: false })
  declare subscriptionId: string;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare amount: number;

  @Default('USD')
  @Column({ type: DataType.STRING, allowNull: false })
  declare currency: string;

  @Default(BillingCycle.MONTHLY)
  @Column({
    type: DataType.ENUM(...Object.values(BillingCycle)),
    defaultValue: BillingCycle.MONTHLY,
    allowNull: false,
  })
  declare billingCycle: BillingCycle;

  @Index
  @Default(PaymentStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(PaymentStatus)),
    defaultValue: PaymentStatus.PENDING,
    allowNull: false,
  })
  declare status: PaymentStatus;

  @Default(PaymentMethod.CARD)
  @Column({
    type: DataType.ENUM(...Object.values(PaymentMethod)),
    defaultValue: PaymentMethod.CARD,
    allowNull: false,
  })
  declare paymentMethod: PaymentMethod;

  @Column({ type: DataType.STRING, allowNull: true })
  declare provider: string;

  @Index
  @Column({ type: DataType.STRING, allowNull: true })
  declare providerTransactionId: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare invoiceReference: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare failureReason: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare paidAt: Date;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: any;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Subscription)
  declare subscription: Subscription;

  @HasOne(() => Invoice)
  declare invoice: Invoice;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
