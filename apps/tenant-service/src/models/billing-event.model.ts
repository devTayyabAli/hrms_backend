import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
  ForeignKey,
  BelongsTo,
  Index,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';
import { Subscription } from './subscription.model';
import { Invoice } from './invoice.model';
import { Payment } from './payment.model';

@Table({
  tableName: 'billing_events',
  updatedAt: false, // Append-only audit events table
  indexes: [
    { fields: ['tenantId', 'createdAt'] },
    { fields: ['subscriptionId', 'createdAt'] },
    { fields: ['eventType'] },
  ],
})
export class BillingEvent extends Model {
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
  @ForeignKey(() => Invoice)
  @Column({ type: DataType.UUID, allowNull: true })
  declare invoiceId: string;

  @Index
  @ForeignKey(() => Payment)
  @Column({ type: DataType.UUID, allowNull: true })
  declare paymentId: string;

  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare eventType: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: any;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Subscription)
  declare subscription: Subscription;

  @BelongsTo(() => Invoice)
  declare invoice: Invoice;

  @BelongsTo(() => Payment)
  declare payment: Payment;

  @CreatedAt
  declare createdAt: Date;
}
