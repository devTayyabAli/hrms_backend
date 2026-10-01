import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
} from 'sequelize-typescript';

/**
 * Which tenants have projection work waiting.
 *
 * Without this the relay would have to poll every tenant's outbox on every
 * tick — reintroducing, on a timer, exactly the fan-out the read model exists
 * to remove. A tenant appears here only when a synchronous apply failed, so
 * in steady state the relay's query returns nothing and it opens no tenant
 * connections at all.
 */
@Table({
  tableName: 'platform_projection_signal',
  timestamps: true,
  indexes: [{ name: 'projection_signal_pending_idx', fields: ['pendingSince'] }],
})
export class PlatformProjectionSignal extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Column(DataType.UUID)
  declare tenantId: string;

  /** Non-null means "this tenant has unapplied events". Cleared on a clean drain. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare pendingSince: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastDrainedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare consecutiveFailures: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;
}
