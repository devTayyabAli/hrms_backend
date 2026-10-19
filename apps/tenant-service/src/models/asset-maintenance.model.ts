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
import { Asset } from './asset.model';

/**
 * One maintenance or repair job on an asset: what was wrong, who is fixing it,
 * what it was expected and actually cost, and when it started and finished.
 * The asset's status says it is under maintenance; this says why and for how
 * long. An asset has at most one OPEN job at a time.
 *
 * Deleted with its asset.
 */
@Table({
  tableName: 'asset_maintenance_records',
  timestamps: true,
  indexes: [
    { fields: ['assetId', 'startedOn'], name: 'asset_maintenance_asset_idx' },
    { fields: ['status'], name: 'asset_maintenance_status_idx' },
  ],
})
export class AssetMaintenance extends Model {
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

  /** MAINTENANCE (routine service) or REPAIR (something broke). */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'REPAIR' })
  declare type: string;

  /** OPEN while the asset is away, COMPLETED when it came back, CANCELLED if it was disposed of meanwhile. */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'OPEN' })
  declare status: string;

  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare issue: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare vendor: string | null;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare estimatedCost: string | null;

  /** What it actually cost, filled in when the job is completed. */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare cost: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare startedOn: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare expectedOn: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare completedOn: string | null;

  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare resolution: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare startedBy: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare completedBy: string | null;
}
