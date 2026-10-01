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
import { EmployeeInvitationStatus } from '@app/common';
import { Employee } from './employee.model';

export { EmployeeInvitationStatus };

/**
 * An invitation for one employee to get a portal login.
 *
 * Only the SHA-256 hash of the token is stored, so a leaked database row
 * cannot be replayed as an invitation link — the raw token exists once, in
 * the email. This mirrors OrganizationAdminInvitation, which does the same
 * for the org admin, but lives in the tenant database because it belongs to
 * an Employee row rather than to the tenant itself.
 */
@Table({
  tableName: 'employee_invitations',
  timestamps: true,
  indexes: [
    { fields: ['tokenHash'], name: 'employee_invitation_token_idx' },
    { fields: ['employeeId', 'status'], name: 'employee_invitation_employee_status_idx' },
  ],
})
export class EmployeeInvitation extends Model {
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

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare email: string;

  /** SHA-256 of the raw token. The raw value is never persisted. */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare tokenHash: string;

  @Default(EmployeeInvitationStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(EmployeeInvitationStatus)),
    allowNull: false,
    defaultValue: EmployeeInvitationStatus.PENDING,
  })
  declare status: EmployeeInvitationStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare message: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare acceptedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare invitedByUserId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare roleId: string | null;
}
