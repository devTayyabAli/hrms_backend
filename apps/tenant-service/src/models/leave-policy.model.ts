import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';
import { LeaveAccrualType, LeaveEligibility } from '@app/common';

export { LeaveAccrualType, LeaveEligibility };

/**
 * Lives in each tenant's own physical database — NOT a shared platform
 * table. `tenantId` is a plain, non-FK defense-in-depth column; the actual
 * isolation boundary is the per-tenant database itself.
 */
@Table({
  tableName: 'leave_policies',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['name'], name: 'unique_leave_policy_name' },
  ],
})
export class LeavePolicy extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 14 })
  declare annualAllocation: number;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isPaid: boolean;

  /** How the allocation is granted — monthly instalments, one annual grant, or on the qualifying event itself (e.g. maternity). */
  @Default(LeaveAccrualType.ANNUAL_GRANT)
  @Column({
    type: DataType.ENUM(...Object.values(LeaveAccrualType)),
    defaultValue: LeaveAccrualType.ANNUAL_GRANT,
  })
  declare accrualType: LeaveAccrualType;

  /** Unused days that roll into the next year. Null means nothing carries forward. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare carryForwardDays: number | null;

  @Default(LeaveEligibility.ALL_EMPLOYEES)
  @Column({
    type: DataType.ENUM(...Object.values(LeaveEligibility)),
    defaultValue: LeaveEligibility.ALL_EMPLOYEES,
  })
  declare eligibility: LeaveEligibility;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;
}
