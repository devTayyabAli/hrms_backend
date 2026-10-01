import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { PerformanceGoalStatus } from '@app/common';
import { Employee } from './employee.model';

export { PerformanceGoalStatus };

@Table({
  tableName: 'performance_goals',
  timestamps: true,
  indexes: [
    { fields: ['employeeId'], name: 'performance_goal_employee_idx' },
    { fields: ['status'], name: 'performance_goal_status_idx' },
    { fields: ['dueDate'], name: 'performance_goal_due_date_idx' },
  ],
})
export class PerformanceGoal extends Model {
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
  declare title: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare category: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare progress: number;

  @Column({ type: DataType.ENUM(...Object.values(PerformanceGoalStatus)), allowNull: false, defaultValue: PerformanceGoalStatus.NOT_STARTED })
  declare status: PerformanceGoalStatus;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare dueDate: string | null;
}
