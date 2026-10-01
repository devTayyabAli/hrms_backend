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
@Table({ tableName: 'attendance_policies', timestamps: true })
export class AttendancePolicy extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare tenantId: string;

  @Default(15)
  @Column({ type: DataType.INTEGER, defaultValue: 15 })
  declare gracePeriodMinutes: number;

  @Default(30)
  @Column({ type: DataType.INTEGER, defaultValue: 30 })
  declare lateThresholdMinutes: number;

  @Default('WEB_CLOCK_IN')
  @Column({ allowNull: false, defaultValue: 'WEB_CLOCK_IN' })
  declare trackingMode: string;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare allowOvertime: boolean;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;

  // ── Attendance Rules screen. Null means "not configured". ─────────────────

  /** Minimum hours worked for a half day. */
  @Column({ type: DataType.DECIMAL(4, 2), allowNull: true })
  declare halfDayHours: string | null;

  /** Minimum hours worked for a full day. */
  @Column({ type: DataType.DECIMAL(4, 2), allowNull: true })
  declare fullDayHours: string | null;

  /** Hours worked after which the rest counts as overtime. */
  @Column({ type: DataType.DECIMAL(4, 2), allowNull: true })
  declare overtimeAfterHours: string | null;

  /** "HH:mm" — check out anyone still clocked in at this time. */
  @Column({ type: DataType.STRING(5), allowNull: true })
  declare autoCheckoutTime: string | null;

  /** COMP_OFF | OVERTIME_PAY | NOT_ALLOWED — what working a weekend earns. */
  @Column({ type: DataType.STRING(24), allowNull: true })
  declare weekendWorkPolicy: string | null;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: false })
  declare ipRestrictionEnabled: boolean | null;

  /** IPs or CIDR ranges check-in is allowed from, when IP restriction is on. */
  @Column({ type: DataType.ARRAY(DataType.STRING), allowNull: true })
  declare allowedIpRanges: string[] | null;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: false })
  declare geofencingEnabled: boolean | null;
}
