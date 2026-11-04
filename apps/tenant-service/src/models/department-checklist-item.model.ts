import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * One responsibility a department adds: a task on the onboarding checklist of
 * someone joining it, or a clearance step when someone leaves it. Applies to
 * the department and everything under it; no department means every one.
 * References are plain ids checked by the service, so no table has to exist
 * before this one.
 */
@Table({
  tableName: 'department_checklist_items',
  timestamps: true,
  indexes: [
    { fields: ['tenantId', 'kind'], name: 'department_checklist_kind_idx' },
    { fields: ['departmentId'], name: 'department_checklist_department_idx' },
  ],
})
export class DepartmentChecklistItem extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** ONBOARDING | OFFBOARDING */
  @Column({ type: DataType.STRING(12), allowNull: false })
  declare kind: string;

  /** Null: every department. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare departmentId: string | null;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** DEPARTMENT_HEAD | REPORTING_MANAGER | EMPLOYEE | PERMISSION | NONE */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare ownerKind: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare ownerEmployeeId: string | null;

  @Column({ type: DataType.STRING(80), allowNull: true })
  declare ownerPermission: string | null;

  /** Onboarding: the task's category. */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'OTHER' })
  declare category: string;

  /** Onboarding: days from the joining date it is due. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare dueInDays: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByEmail: string | null;
}
