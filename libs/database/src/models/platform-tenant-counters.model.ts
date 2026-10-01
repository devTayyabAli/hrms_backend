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
 * Per-tenant headcount rollup for the SuperAdmin KPI cards.
 *
 * Exists so a card reading "12,480 users" does not have to scan
 * platform_directory_person — and certainly not fan out across tenant
 * databases, which is what USER.GET_TENANT_USER_COUNTS did. Recomputed from
 * the directory whenever a tenant's rows change, which is cheap because it is
 * one indexed aggregate over a single tenant.
 */
@Table({
  tableName: 'platform_tenant_counters',
  timestamps: true,
})
export class PlatformTenantCounters extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Column(DataType.UUID)
  declare tenantId: string;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare totalUsers: number;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare activeUsers: number;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare admins: number;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare hrs: number;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare managers: number;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare employees: number;
}
