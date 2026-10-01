import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';
import { HrReportFormat, HrReportType } from '@app/common';

/**
 * One generated report. Kept so the Reports screen can show "Last run: 2h
 * ago" on each card — the rows themselves are rebuilt on every generate, so
 * nothing here is a cache.
 */
@Table({
  tableName: 'hr_report_runs',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['type', 'createdAt'], name: 'hr_report_run_type_created_idx' }],
})
export class HrReportRun extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({
    type: DataType.ENUM(...Object.values(HrReportType)),
    allowNull: false,
  })
  declare type: HrReportType;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare rangeLabel: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare fromDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare toDate: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare departmentId: string | null;

  @Default(HrReportFormat.JSON)
  @Column({
    type: DataType.ENUM(...Object.values(HrReportFormat)),
    allowNull: false,
    defaultValue: HrReportFormat.JSON,
  })
  declare format: HrReportFormat;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare rowCount: number;

  @Column({ type: DataType.UUID, allowNull: true })
  declare generatedByUserId: string | null;
}
