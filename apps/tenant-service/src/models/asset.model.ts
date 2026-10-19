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
import { AssetCategory } from './asset-category.model';

/**
 * A company asset: a laptop, a chair, a phone. Where it is (`status`) and who
 * has it (`assignedEmployeeId`) are kept on the row so the list is one query;
 * how it got there is `asset_events`.
 *
 * `status` is a plain string validated by the service (AVAILABLE, IN_USE,
 * MAINTENANCE, DISPOSED) rather than a database enum, so adding a status later
 * does not need an ALTER TYPE on every organization's database.
 *
 * The category cannot be deleted while assets use it (no cascade); the
 * assignee going away just leaves the asset unassigned.
 */
@Table({
  tableName: 'assets',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['assetCode'], name: 'unique_asset_code' },
    { unique: true, fields: ['serialNumber'], name: 'unique_asset_serial' },
    { fields: ['status'], name: 'asset_status_idx' },
    { fields: ['categoryId'], name: 'asset_category_idx' },
    { fields: ['assignedEmployeeId'], name: 'asset_assignee_idx' },
  ],
})
export class Asset extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** "AST-0001": what is written on the sticker. */
  @Column({ type: DataType.STRING(30), allowNull: false })
  declare assetCode: string;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare name: string;

  @ForeignKey(() => AssetCategory)
  @Column({ type: DataType.UUID, allowNull: false })
  declare categoryId: string;

  @BelongsTo(() => AssetCategory, { foreignKey: 'categoryId' })
  declare category: AssetCategory;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare brand: string | null;

  /** Unique when given (several assets without one are fine). */
  @Column({ type: DataType.STRING(100), allowNull: true })
  declare serialNumber: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'AVAILABLE' })
  declare status: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'SET NULL' })
  declare assignedEmployeeId: string | null;

  @BelongsTo(() => Employee, { foreignKey: 'assignedEmployeeId', onDelete: 'SET NULL' })
  declare assignee: Employee | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare assignedAt: Date | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare purchaseDate: string | null;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare purchaseCost: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare warrantyExpiry: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare vendor: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare location: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare disposedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare disposalReason: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare createdBy: string | null;
}
