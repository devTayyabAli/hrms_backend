import {
  Column,
  CreatedAt,
  DataType,
  Default,
  IsUUID,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * One time a platform report was generated, with the CSV it produced.
 *
 * Kept so "Download" hands back exactly what the Super Admin previewed (not a
 * re-run with newer numbers), so a custom report's last run can be fetched
 * again, and so "Reports Generated" counts real runs.
 */
@Table({
  tableName: 'report_runs',
  updatedAt: false,
  indexes: [
    { fields: ['createdAt'] },
    { fields: ['customReportId', 'createdAt'] },
  ],
})
export class ReportRun extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING(60), allowNull: false })
  declare reportType: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare customReportId: string | null;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare filters: Record<string, unknown> | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare rowCount: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare durationMs: number;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare generatedById: string | null;

  @Column({ type: DataType.STRING(200), allowNull: true })
  declare generatedByName: string | null;

  /** The CSV as generated. Null when it was too large to keep. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare content: string | null;

  @CreatedAt
  declare createdAt: Date;
}
