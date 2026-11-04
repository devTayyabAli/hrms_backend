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

/**
 * IT / Admin's confirmation that a leaving employee has handed back everything
 * and nothing is left to settle. The final exit (marking the employee Resigned)
 * is refused until there is one that is still current — a confirmation goes
 * stale the moment anything happens to an asset of theirs after it, which is
 * worked out from the asset history rather than stored here.
 *
 * Append-only: re-confirming adds a row; the newest one counts.
 */
@Table({
  tableName: 'asset_clearances',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['employeeId', 'createdAt'], name: 'asset_clearance_employee_idx' }],
})
export class AssetClearance extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare employeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', onDelete: 'CASCADE' })
  declare employee: Employee;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare confirmedBy: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare note: string | null;
}
