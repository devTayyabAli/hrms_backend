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
} from 'sequelize-typescript';
import { Employee } from './employee.model';
import { Asset } from './asset.model';

/**
 * One thing that happened to an asset: added, given to someone, returned, sent
 * for maintenance, disposed. The asset's history on its detail view, and what
 * "how many were in use at the start of the month" is worked out from (the
 * latest `toStatus` before a date is the status on that date).
 *
 * Append-only. The employee's name is copied in so the history still reads
 * correctly after that employee is removed.
 */
@Table({
  tableName: 'asset_events',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['assetId', 'createdAt'], name: 'asset_event_asset_idx' },
    { fields: ['createdAt'], name: 'asset_event_created_idx' },
  ],
})
export class AssetEvent extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Asset)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare assetId: string;

  @BelongsTo(() => Asset, { foreignKey: 'assetId', onDelete: 'CASCADE' })
  declare asset: Asset;

  /** CREATED, ASSIGNED, RETURNED, DAMAGED, LOST, MAINTENANCE_STARTED, MAINTENANCE_COMPLETED, DISPOSED. */
  @Column({ type: DataType.STRING(30), allowNull: false })
  declare type: string;

  @Column({ type: DataType.STRING(20), allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.STRING(20), allowNull: true })
  declare toStatus: string | null;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'SET NULL' })
  declare employeeId: string | null;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', onDelete: 'SET NULL' })
  declare employee: Employee | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare employeeName: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare note: string | null;

  /** What was recorded with it: the handover checklist and date, or the condition on return. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare details: Record<string, unknown> | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare actorUserId: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare actorEmail: string | null;
}
