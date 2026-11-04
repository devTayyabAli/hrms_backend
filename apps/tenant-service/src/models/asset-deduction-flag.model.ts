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
 * A possible salary deduction for an asset that was lost or came back damaged
 * while an employee had it. Raised automatically, and then does nothing until
 * someone with payroll authority decides: approve it (for an amount and a
 * payroll month, which writes a one-off DEDUCTION that month's payroll picks
 * up) or waive it.
 *
 * `suggestedAmount` is what the asset cost, when that is known; the amount
 * actually approved may differ. Cascades with the asset, and survives the
 * employee being removed only as long as the employee row does.
 */
@Table({
  tableName: 'asset_deduction_flags',
  timestamps: true,
  indexes: [
    { fields: ['status', 'createdAt'], name: 'asset_deduction_status_idx' },
    { fields: ['employeeId'], name: 'asset_deduction_employee_idx' },
    { fields: ['assetId'], name: 'asset_deduction_asset_idx' },
  ],
})
export class AssetDeductionFlag extends Model {
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

  /** LOST or DAMAGED. */
  @Column({ type: DataType.STRING(10), allowNull: false })
  declare reason: string;

  /** PENDING until decided, then APPROVED or WAIVED. */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'PENDING' })
  declare status: string;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare suggestedAmount: string | null;

  /** The amount approved. */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare amount: string | null;

  /** YYYY-MM: the payroll the approved deduction is taken in. */
  @Column({ type: DataType.STRING(7), allowNull: true })
  declare payrollPeriod: string | null;

  /** The payroll adjustment an approval created. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare payrollAdjustmentId: string | null;

  /** What was noted when it was raised (the damage, the circumstances of the loss). */
  @Column({ type: DataType.STRING(500), allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare decisionNote: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare raisedBy: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare decidedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;
}
