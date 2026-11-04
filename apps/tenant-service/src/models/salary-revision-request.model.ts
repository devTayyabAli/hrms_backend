import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';

/**
 * A proposed change to someone's pay, waiting for approval. Nothing in
 * payroll reads it: the revision is only written when the approvers have
 * approved it, from the proposal as it was made. The person who proposed it
 * cannot be the one who approves it.
 */
@Table({
  tableName: 'salary_revision_requests',
  timestamps: true,
  indexes: [
    { fields: ['employeeId'], name: 'salary_revision_request_employee_idx' },
    { fields: ['status'], name: 'salary_revision_request_status_idx' },
  ],
})
export class SalaryRevisionRequest extends Model {
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

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare effectiveFrom: string;

  /** What was asked for: { structureId, lines, reason }, saved when the proposal is approved. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare payload: Record<string, any>;

  /** The totals and components as worked out when it was proposed, for the approver to read. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare proposed: Record<string, any>;

  /** The pay in effect when it was proposed, for comparison. Null for a first salary. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare current: Record<string, any> | null;

  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'PENDING' })
  declare status: string;

  /** The route of approvers and where the request is on it. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare approval: Record<string, any> | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare requestedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare requestedByEmail: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare decidedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare decidedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare decisionNote: string | null;

  /** The revision this became once approved. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare revisionId: string | null;
}
