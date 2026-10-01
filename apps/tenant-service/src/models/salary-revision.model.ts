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
import { Employee } from './employee.model';

/**
 * One salary an employee has had, and the day it started. A raise adds a
 * row rather than overwriting the last one, so payroll for any month can be
 * worked out from the salary that applied then, and HR can see the history.
 *
 * Saving a second salary with the same effective date replaces that row —
 * a correction, not a new revision.
 */
@Table({
  tableName: 'salary_revisions',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['employeeId', 'effectiveFrom'], name: 'salary_revision_employee_date_unique' },
  ],
})
export class SalaryRevision extends Model {
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

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare basicSalary: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare allowances: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare recurringDeductions: string;

  @Column({ type: DataType.STRING(300), allowNull: true })
  declare reason: string | null;

  // ── Phase 4: the compensation behind the totals above ────────────────────
  // basicSalary / allowances / recurringDeductions stay as the totals of
  // `components`, so everything that reads them keeps working.

  /** The structure it was built from, if any — a reference, not a live link. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare structureId: string | null;

  @Column({ type: DataType.STRING(120), allowNull: true })
  declare structureName: string | null;

  /**
   * Every component with its settings and worked-out monthly amount, as
   * saved. Null for a salary saved before components existed.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare components: Record<string, any>[] | null;

  /** The compensation this replaced, for the revision's before/after view. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare previousComponents: Record<string, any>[] | null;

  /** MANUAL | STRUCTURE | IMPORT | SALARY_FORM — how it was entered. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare source: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare changedByUserId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare changedByEmail: string | null;
}
