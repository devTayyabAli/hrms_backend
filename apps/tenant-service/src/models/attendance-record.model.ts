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
import { AttendanceStatus, AttendanceSource } from '@app/common';
import { Employee } from './employee.model';

/**
 * One employee's attendance outcome for one calendar day — the rows behind
 * the Attendance screen's KPI cards, overview chart, department breakdown and
 * Today's Attendance table.
 *
 * Lives in each tenant's own physical database alongside Employee and
 * AttendancePolicy, so status derivation and every aggregate stay local SQL
 * rather than a cross-service fan-out. `tenantId` is a plain, non-FK
 * defense-in-depth column; the real isolation boundary is the separate
 * per-tenant database.
 *
 * The (employeeId, date) unique index is what makes marking a day
 * idempotent: re-marking updates the existing row instead of creating a
 * second, contradictory record for the same day.
 */
@Table({
  tableName: 'attendance_records',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['employeeId', 'date'],
      name: 'unique_attendance_employee_date',
    },
    { fields: ['date'], name: 'attendance_date_idx' },
    { fields: ['status'], name: 'attendance_status_idx' },
  ],
})
export class AttendanceRecord extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @BelongsTo(() => Employee, 'employeeId')
  declare employee: Employee;

  /** DATEONLY — the attendance day, independent of check-in timezone. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare date: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare checkInAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare checkOutAt: Date | null;

  /**
   * Worked duration in whole minutes, derived on write from
   * checkOutAt - checkInAt. Stored rather than computed on read so the
   * Work Hours column and any per-department totals stay a plain SUM.
   */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare workedMinutes: number | null;

  @Default(AttendanceStatus.PRESENT)
  @Column({
    type: DataType.ENUM(...Object.values(AttendanceStatus)),
    allowNull: false,
    defaultValue: AttendanceStatus.PRESENT,
  })
  declare status: AttendanceStatus;

  @Default(AttendanceSource.MANUAL)
  @Column({
    type: DataType.ENUM(...Object.values(AttendanceSource)),
    allowNull: false,
    defaultValue: AttendanceSource.MANUAL,
  })
  declare source: AttendanceSource;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  /** 'REMOTE' on an approved work-from-home day; null means the usual place of work. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare workLocation: string | null;

  /** Overtime approved for this day, in minutes. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare overtimeMinutes: number | null;

  /**
   * Who entered or last corrected this record. A user-service User id, so
   * intentionally not an FK (different physical database).
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare markedByUserId: string | null;
}
