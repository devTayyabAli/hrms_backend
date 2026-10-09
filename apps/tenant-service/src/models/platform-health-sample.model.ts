import { Table, Column, Model, DataType, PrimaryKey, Default, CreatedAt } from 'sequelize-typescript';

/**
 * One minute's health of the platform, recorded by PlatformStatusService.
 * Uptime is the share of these that were fully operational — measured, not
 * declared. Kept for 90 days.
 */
@Table({
  tableName: 'platform_health_samples',
  updatedAt: false,
  indexes: [{ fields: ['createdAt'], name: 'platform_health_samples_created_idx' }],
})
export class PlatformHealthSample extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  /** operational: every service answered; degraded: some did; down: none did. */
  @Column({ type: DataType.STRING(12), allowNull: false })
  declare status: 'operational' | 'degraded' | 'down';

  /** Services that didn't answer, e.g. "user-service". */
  @Column({ type: DataType.STRING(200), allowNull: true })
  declare failing: string | null;

  @CreatedAt
  @Column(DataType.DATE)
  declare createdAt: Date;
}
