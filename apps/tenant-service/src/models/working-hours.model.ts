import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';

/**
 * Lives in each tenant's own physical database — NOT a shared platform
 * table. `tenantId` is a plain, non-FK defense-in-depth column; the actual
 * isolation boundary is the per-tenant database itself.
 */
@Table({
  tableName: 'working_hours',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['name'], name: 'unique_working_hours_name' },
  ],
})
export class WorkingHours extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Default('Standard Office Shift')
  @Column({ allowNull: false })
  declare name: string;

  @Column({ type: DataType.ARRAY(DataType.STRING), allowNull: false })
  declare workingDays: string[];

  @Column({ allowNull: false })
  declare startTime: string;

  @Column({ allowNull: false })
  declare endTime: string;

  @Default(60)
  @Column({ type: DataType.INTEGER, defaultValue: 60 })
  declare breakDurationMinutes: number;

  @Default('UTC')
  @Column({ allowNull: false, defaultValue: 'UTC' })
  declare timezone: string;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isDefault: boolean;
}
