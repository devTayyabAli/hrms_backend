import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
} from 'sequelize-typescript';

/** What the row is about. */
export type HierarchySubjectType = 'EMPLOYEE' | 'DEPARTMENT';

/** Which relationship moved. */
export type HierarchyChangeType =
  | 'REPORTING_MANAGER'
  | 'DEPARTMENT'
  | 'DESIGNATION'
  | 'DEPARTMENT_HEAD'
  | 'PARENT_DEPARTMENT'
  | 'ASSIGNMENT_ADDED'
  | 'ASSIGNMENT_ENDED';

/**
 * One row per change to the organization structure: an employee's reporting
 * manager, department or designation, or a department's head or parent.
 *
 * Append-only. Previous and next are stored as ids *and* names so the record
 * still reads correctly after the manager or department it mentions has been
 * deleted — which is also why nothing here is a foreign key.
 *
 * Lives in each tenant's own database like the rest of the operational
 * models; `tenantId` is a plain column kept as a defence-in-depth filter.
 */
@Table({
  tableName: 'hierarchy_changes',
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      fields: ['subjectType', 'subjectId'],
      name: 'hierarchy_changes_subject_idx',
    },
  ],
})
export class HierarchyChange extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare subjectType: HierarchySubjectType;

  /** The employee or department the change happened to. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare subjectId: string;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare changeType: HierarchyChangeType;

  @Column({ type: DataType.UUID, allowNull: true })
  declare previousId: string | null;

  @Column({ type: DataType.STRING(200), allowNull: true })
  declare previousLabel: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare nextId: string | null;

  @Column({ type: DataType.STRING(200), allowNull: true })
  declare nextLabel: string | null;

  /** The day the change applies from — defaults to the day it was recorded. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare effectiveFrom: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare note: string | null;

  /** Who made the change, from the signed request — a login id, not an employee id. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare changedById: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare changedByEmail: string | null;

  @CreatedAt
  declare createdAt: Date;
}
