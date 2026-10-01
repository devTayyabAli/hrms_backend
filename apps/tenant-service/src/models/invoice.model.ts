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
  Index,
} from 'sequelize-typescript';
import { InvoiceStatus, BillingCycle } from '@app/common';
import { Tenant } from './tenant.model';
import { Subscription } from './subscription.model';
import { Payment } from './payment.model';

@Table({
  tableName: 'invoices',
  indexes: [
    { fields: ['tenantId', 'status'] },
    { fields: ['subscriptionId', 'status'] },
    { fields: ['dueDate'] },
  ],
})
export class Invoice extends Model {
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

  @Index
  @ForeignKey(() => Payment)
  @Column({ type: DataType.UUID, allowNull: true })
  declare paymentId: string;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  declare invoiceNumber: string;

  @Index
  @Default(InvoiceStatus.OPEN)
  @Column({
    type: DataType.ENUM(...Object.values(InvoiceStatus)),
    defaultValue: InvoiceStatus.OPEN,
    allowNull: false,
  })
  declare status: InvoiceStatus;

  @Default(BillingCycle.MONTHLY)
  @Column({
    type: DataType.ENUM(...Object.values(BillingCycle)),
    defaultValue: BillingCycle.MONTHLY,
    allowNull: false,
  })
  declare billingCycle: BillingCycle;

  @Default(DataType.NOW)
  @Column({ type: DataType.DATE, allowNull: false })
  declare issueDate: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare dueDate: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare paidAt: Date;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare subtotal: number;

  @Default(0)
  @Column({ type: DataType.DECIMAL(10, 2), defaultValue: 0, allowNull: false })
  declare taxAmount: number;

  @Default(0)
  @Column({ type: DataType.DECIMAL(10, 2), defaultValue: 0, allowNull: false })
  declare discountAmount: number;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare totalAmount: number;

  @Default('USD')
  @Column({ type: DataType.STRING, defaultValue: 'USD', allowNull: false })
  declare currency: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: any;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Subscription)
  declare subscription: Subscription;

  @BelongsTo(() => Payment)
  declare payment: Payment;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
