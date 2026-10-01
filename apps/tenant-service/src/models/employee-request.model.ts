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
import { EmployeeRequestStatus, EmployeeRequestType } from '@app/common';
import { Employee } from './employee.model';

export { EmployeeRequestStatus, EmployeeRequestType };

/**
 * One card on My Requests: attendance correction, work from home, overtime
 * or a general HR request. `description` is the history column as written.
 */
@Table({
  tableName: 'employee_requests',
  timestamps: true,
  indexes: [
    { fields: ['employeeId', 'status'], name: 'employee_request_employee_status_idx' },
    { fields: ['type'], name: 'employee_request_type_idx' },
    { fields: ['createdAt'], name: 'employee_request_created_at_idx' },
  ],
})
export class EmployeeRequest extends Model {
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

  @Column({
    type: DataType.ENUM(...Object.values(EmployeeRequestType)),
    allowNull: false,
  })
  declare type: EmployeeRequestType;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  /** Date shown in the history table. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare requestDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare fromDate: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare toDate: string | null;

  /** Overtime hours — the approved figure once HR decides. */
  @Column({ type: DataType.DECIMAL(4, 1), allowNull: true })
  declare hours: string | null;

  /**
   * "HH:mm" the employee entered, in their own time: the actual check-in /
   * check-out for an attendance correction, the start / end for overtime.
   */
  @Column({ type: DataType.STRING(5), allowNull: true })
  declare timeFrom: string | null;

  @Column({ type: DataType.STRING(5), allowNull: true })
  declare timeTo: string | null;

  /**
   * What approving actually changed — the corrected times, approved hours or
   * approved dates, what was originally asked for, and the attendance rows
   * touched. Null until approved.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare resolution: Record<string, unknown> | null;

  @Default(EmployeeRequestStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(EmployeeRequestStatus)),
    allowNull: false,
    defaultValue: EmployeeRequestStatus.PENDING,
  })
  declare status: EmployeeRequestStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare decisionNote: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare decidedByUserId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;
}
