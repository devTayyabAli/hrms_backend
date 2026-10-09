import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
  UpdatedAt,
  Index,
} from 'sequelize-typescript';

/** A saved report: which platform report to run, with which filters and columns. */
@Table({
  tableName: 'custom_reports',
  timestamps: true,
  indexes: [
    { fields: ['category'] },
    { fields: ['status'] },
    { fields: ['createdAt'] },
  ],
})
export class CustomReport extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare category: string; // the category of the report it runs, kept for filtering

  @Column({ type: DataType.STRING, allowNull: false })
  declare createdBy: string; // display name of the Super Admin who saved it

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdById: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** Which platform report this runs (REPORT_TYPES). Null on reports saved before it existed. */
  @Column({ type: DataType.STRING(60), allowNull: true })
  declare reportType: string | null;

  /** Column keys to include, in order; null means every column. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare columns: string[] | null;

  /** Unused since reportType and columns; kept so older rows still load. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare metrics: string[];

  @Column({ type: DataType.JSONB, allowNull: true })
  declare filters: Record<string, any>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastGeneratedAt: Date | null;

  @Default('Active')
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string; // 'Active', 'Archived'

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
