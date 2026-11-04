import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';

/**
 * Whether leaving needs every clearance. One row per organization; no row
 * means the gate is off and every stage is on, which is how leaving worked
 * before offboarding existed.
 */
@Table({ tableName: 'offboarding_settings', timestamps: true, indexes: [{ unique: true, fields: ['tenantId'], name: 'unique_offboarding_settings_tenant' }] })
export class OffboardingSetting extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** An employee cannot be marked Resigned until their offboarding is cleared. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare gateEnabled: boolean;

  /** Which clearances a new case needs: MANAGER, HR, IT, FINANCE. Null means all four. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare stages: string[] | null;
}

/**
 * One person leaving. Open while it is being worked through; completed when
 * the employee is marked Resigned, cancelled if they stay. Only one open case
 * per employee.
 */
@Table({
  tableName: 'offboarding_cases',
  timestamps: true,
  indexes: [
    { fields: ['employeeId'], name: 'offboarding_case_employee_idx' },
    { fields: ['status'], name: 'offboarding_case_status_idx' },
    { unique: true, fields: ['employeeId'], where: { status: 'OPEN' }, name: 'unique_open_offboarding_case' },
  ],
})
export class OffboardingCase extends Model {
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

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare type: string;

  /** OPEN | COMPLETED | CANCELLED. Whether an open case is cleared is worked out from its clearances. */
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'OPEN' })
  declare status: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare noticeDate: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare lastWorkingDay: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare initiatedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare initiatedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelledAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare cancelReason: string | null;
}

/** One department's clearance on a case. IT's is not stored as an answer: it is worked out from the asset clearance. */
@Table({
  tableName: 'offboarding_clearances',
  timestamps: true,
  indexes: [{ unique: true, fields: ['caseId', 'stage'], name: 'unique_offboarding_clearance_stage' }],
})
export class OffboardingClearance extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => OffboardingCase)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare caseId: string;

  @BelongsTo(() => OffboardingCase, { foreignKey: 'caseId', onDelete: 'CASCADE' })
  declare offboardingCase: OffboardingCase;

  /** MANAGER | HR | IT | FINANCE, or DEPT-1, DEPT-2 ... for a step the person's department added. */
  @Column({ type: DataType.STRING(12), allowNull: false })
  declare stage: string;

  /** A department step's name. Null on the standard stages. */
  @Column({ type: DataType.STRING(160), allowNull: true })
  declare label: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** A department step's owner as the department set it, and who that came to when the case started. */
  @Column({ type: DataType.STRING(20), allowNull: true })
  declare ownerKind: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare ownerEmployeeId: string | null;

  @Column({ type: DataType.STRING(80), allowNull: true })
  declare ownerPermission: string | null;

  /** The department checklist item it came from. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare itemId: string | null;

  /** PENDING | CLEARED */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'PENDING' })
  declare status: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare clearedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare clearedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare clearedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare note: string | null;
}
