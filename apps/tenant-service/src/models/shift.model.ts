import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * One work shift an organization defines (Morning, Night, Flexible…).
 *
 * Lives in each tenant's own physical database — NOT a shared platform
 * table. `tenantId` is a plain, non-FK defense-in-depth column; the actual
 * isolation boundary is the per-tenant database itself.
 *
 * Separate from `WorkingHours`, which is the single organization-wide
 * schedule attendance rules are judged against today. A shift records who
 * works what hours; it does not change those rules.
 */
@Table({
  tableName: 'shifts',
  timestamps: true,
  indexes: [{ unique: true, fields: ['name'], name: 'unique_shift_name' }],
})
export class Shift extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** 24-hour "HH:mm". */
  @Column({ type: DataType.STRING(5), allowNull: false })
  declare startTime: string;

  /** 24-hour "HH:mm"; earlier than `startTime` when the shift runs past midnight. */
  @Column({ type: DataType.STRING(5), allowNull: false })
  declare endTime: string;

  @Default(60)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 60 })
  declare breakMinutes: number;

  /** MONDAY … SUNDAY. */
  @Column({ type: DataType.ARRAY(DataType.STRING), allowNull: false })
  declare workingDays: string[];

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;
}
