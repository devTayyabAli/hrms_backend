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
  declare name: string; // e.g. 'Employee Activity Report'

  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare category: string; // 'Security', 'Organizations', 'Reports', 'Subscription'

  @Column({ type: DataType.STRING, allowNull: false })
  declare createdBy: string; // e.g. 'Aasma Abbas', 'Ahmed Khan', 'Zeeshan Qasim'

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdById: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metrics: string[];

  @Column({ type: DataType.JSONB, allowNull: true })
  declare filters: Record<string, any>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastGeneratedAt: Date;

  @Default('Active')
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string; // 'Active', 'Archived'

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
