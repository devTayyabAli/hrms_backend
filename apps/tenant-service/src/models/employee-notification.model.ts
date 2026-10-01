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
import { EmployeeNotificationKind } from '@app/common';
import { Employee } from './employee.model';

export { EmployeeNotificationKind };

/**
 * One row on the Notifications tab. `readAt` null is the unread dot.
 */
@Table({
  tableName: 'employee_notifications',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['employeeId', 'createdAt'], name: 'employee_notification_employee_created_idx' },
  ],
})
export class EmployeeNotification extends Model {
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

  @Column({
    type: DataType.ENUM(...Object.values(EmployeeNotificationKind)),
    allowNull: false,
    defaultValue: EmployeeNotificationKind.GENERAL,
  })
  declare kind: EmployeeNotificationKind;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare readAt: Date | null;
}
