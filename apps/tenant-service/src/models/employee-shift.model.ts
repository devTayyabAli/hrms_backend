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
import { Shift } from './shift.model';

/**
 * Which shift an employee works. One row per employee — the unique index is
 * what makes "moving someone to another shift" a replacement rather than a
 * second assignment.
 *
 * Both foreign keys cascade: deleting an employee (or an unassigned shift)
 * must not be blocked by, or leave behind, its assignment row.
 */
@Table({
  tableName: 'employee_shifts',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['employeeId'], name: 'unique_employee_shift_employee' },
    { fields: ['shiftId'], name: 'employee_shift_shift_idx' },
  ],
})
export class EmployeeShift extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare employeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', onDelete: 'CASCADE' })
  declare employee: Employee;

  @ForeignKey(() => Shift)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare shiftId: string;

  @BelongsTo(() => Shift, { foreignKey: 'shiftId', onDelete: 'CASCADE' })
  declare shift: Shift;
}
