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
import { LeaveRequestStatus } from '@app/common';
import { Employee } from './employee.model';
import { LeavePolicy } from './leave-policy.model';

/**
 * One employee's request for time off — the rows behind the Leave Management
 * screen's KPI cards and Leave Requests table.
 *
 * Lives in each tenant's own physical database alongside Employee and
 * LeavePolicy, so the joins behind the table stay local SQL. `tenantId` is a
 * plain, non-FK defense-in-depth column; the real isolation boundary is the
 * separate per-tenant database.
 *
 * The leave *type* shown in the table (Annual, Sick, Casual, Maternity...) is
 * not an enum here: it points at the tenant's own LeavePolicy rows, the ones
 * the Setup Wizard creates. An organization that adds "Study Leave" gets it
 * in this screen without a code change, and the allocation and paid/unpaid
 * flag stay defined in exactly one place.
 */
@Table({
  tableName: 'leave_requests',
  timestamps: true,
  indexes: [
    // (employeeId, status) is composite because the overlap check on every
    // create and date edit filters on both together, and it still serves a
    // lookup by employee alone as a leading-column prefix.
    {
      fields: ['employeeId', 'status'],
      name: 'leave_request_employee_status_idx',
    },
    { fields: ['status'], name: 'leave_request_status_idx' },
    { fields: ['fromDate'], name: 'leave_request_from_date_idx' },
    // The table defaults to newest-first; without this the default view
    // sorts the whole table on every page load.
    { fields: ['createdAt'], name: 'leave_request_created_at_idx' },
  ],
})
export class LeaveRequest extends Model {
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

  /** The Leave Type column — one of the tenant's configured leave policies. */
  @ForeignKey(() => LeavePolicy)
  @Column({ type: DataType.UUID, allowNull: false })
  declare leavePolicyId: string;

  @BelongsTo(() => LeavePolicy, 'leavePolicyId')
  declare leavePolicy: LeavePolicy;

  /** DATEONLY — a leave day is a calendar day, independent of timezone. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare fromDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare toDate: string;

  /**
   * Days deducted from the allowance, stored rather than derived on read so
   * the Duration column and any balance total stay a plain SUM. DECIMAL
   * because a half day is a real request; defaults to the inclusive calendar
   * span when the caller does not override it.
   */
  @Column({ type: DataType.DECIMAL(5, 1), allowNull: false })
  declare totalDays: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Default(LeaveRequestStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(LeaveRequestStatus)),
    allowNull: false,
    defaultValue: LeaveRequestStatus.PENDING,
  })
  declare status: LeaveRequestStatus;

  /** Approver's note — the reason shown against a rejected request. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare decisionNote: string | null;

  /**
   * Who approved or rejected, and when. A user-service User id, so
   * intentionally not an FK (different physical database).
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare decidedByUserId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  /** Who filed the request — an admin using Add Leave Request, today. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare appliedByUserId: string | null;
}
