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

/**
 * Lives in each tenant's own physical database (see
 * apps/tenant-service/src/services/tenant-model-provider.service.ts) — NOT
 * a shared platform table. `tenantId` is kept as a plain, non-FK column: a
 * defense-in-depth check (queries still filter by it), but the actual
 * isolation boundary is the separate database itself, per tenant. There is
 * deliberately no `@BelongsTo(() => Tenant)` here — Tenant lives in the
 * platform database, a different physical connection, so a Sequelize
 * cross-database association/FK is not possible (and isolation must not
 * depend on one anyway).
 */
@Table({
  tableName: 'departments',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['name'], name: 'unique_department_name' },
    { unique: true, fields: ['code'], name: 'unique_department_code' },
  ],
})
export class Department extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column({ allowNull: true })
  declare code: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  @ForeignKey(() => Department)
  @Column({ type: DataType.UUID, allowNull: true })
  declare parentDepartmentId: string;

  /**
   * Department head shown in the Manager column of the admin Departments
   * screen. References `employees.id` in this same tenant database, but is
   * deliberately declared without `@ForeignKey(() => Employee)`: Employee
   * already has a real FK to Department, and adding the reverse constraint
   * would make the two tables mutually dependent — `sync()` then cannot
   * create either one first. Validated in the service layer instead (see
   * OrganizationDepartmentsService.assignManager).
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare managerId: string | null;

  /**
   * The branch or office this department sits in ("Lahore HQ", "Remote").
   * Free text: organizations name their locations differently and most have
   * one, so a location table would be ceremony for them.
   */
  @Column({ type: DataType.STRING(120), allowNull: true })
  declare location: string | null;

  /**
   * The branches this department works from. A department can sit in several,
   * and an organization with one office leaves it empty. Plain ids checked by
   * the service, so neither table has to exist before the other.
   */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare branchIds: string[];

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;

  @BelongsTo(() => Department, 'parentDepartmentId')
  declare parentDepartment: Department;
}
