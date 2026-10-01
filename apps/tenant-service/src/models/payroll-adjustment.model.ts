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
import { PayrollAdjustmentType } from '@app/common';
import { PayrollRecord } from './payroll-record.model';

export { PayrollAdjustmentType };

/**
 * A manual change to one payroll line, made in Review. Lines are never edited
 * directly: every change is a row here with its reason and author, so the
 * calculated figure and what was changed on top of it both stay visible.
 */
@Table({
  tableName: 'payroll_adjustments',
  timestamps: true,
  indexes: [
    { fields: ['payrollRecordId'], name: 'payroll_adjustment_record_idx' },
    { fields: ['payrollRunId'], name: 'payroll_adjustment_run_idx' },
  ],
})
export class PayrollAdjustment extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /**
   * The run and line it is on. Null for an entry made ahead of its payroll
   * (Phase 4) — the run for its period picks it up when it is calculated.
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare payrollRunId: string | null;

  @ForeignKey(() => PayrollRecord)
  @Column({ type: DataType.UUID, allowNull: true })
  declare payrollRecordId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare employeeId: string | null;

  /** YYYY-MM — the payroll it belongs to. */
  @Column({ type: DataType.STRING(7), allowNull: true })
  declare payrollPeriod: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare effectiveDate: string | null;

  @BelongsTo(() => PayrollRecord, { foreignKey: 'payrollRecordId', onDelete: 'CASCADE' })
  declare payrollRecord: PayrollRecord;

  @Column({ type: DataType.ENUM(...Object.values(PayrollAdjustmentType)), allowNull: false })
  declare type: PayrollAdjustmentType;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  declare amount: string;

  @Column({ type: DataType.STRING(300), allowNull: false })
  declare reason: string;

  /** For earnings: what kind — the tax rule decides how each kind is taxed. */
  @Default('OTHER')
  @Column({ type: DataType.STRING(24), allowNull: false, defaultValue: 'OTHER' })
  declare category: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByEmail: string | null;
}
