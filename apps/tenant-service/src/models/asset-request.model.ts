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
 * An employee asking IT / Admin for something about an asset they have: a
 * repair, a replacement, or reporting damage. A ticket, not a status change:
 * the asset only moves (to maintenance, damaged…) when IT / Admin acts on it.
 *
 * Both foreign keys cascade, so a request does not outlive its asset or its
 * employee. `type` and `status` are plain strings validated by the service.
 */
@Table({
  tableName: 'asset_requests',
  timestamps: true,
  indexes: [
    { fields: ['employeeId', 'createdAt'], name: 'asset_request_employee_idx' },
    { fields: ['assetId'], name: 'asset_request_asset_idx' },
    { fields: ['status', 'createdAt'], name: 'asset_request_status_idx' },
  ],
})
export class AssetRequest extends Model {
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

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare employeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', onDelete: 'CASCADE' })
  declare employee: Employee;

  /** REPAIR, REPLACEMENT or DAMAGE_REPORT. */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare type: string;

  /** OPEN, IN_PROGRESS, RESOLVED or REJECTED. */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'OPEN' })
  declare status: string;

  @Column({ type: DataType.STRING(1000), allowNull: false })
  declare description: string;

  /** What IT / Admin did, or why the request was turned down. */
  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare resolutionNote: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare handledBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare resolvedAt: Date | null;
}
