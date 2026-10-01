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
import { OnboardingTaskCategory, OnboardingTaskStatus } from '@app/common';
import { Employee } from './employee.model';
import { NewHire } from './new-hire.model';

/**
 * One checklist item on a new hire's onboarding — the Upcoming Tasks panel,
 * the "Pending Tasks" KPI, and the tallies every derived onboarding status is
 * computed from (see NewHire).
 *
 * `status` is stored here, unlike on NewHire, because this is where the fact
 * actually lives: a checkbox being ticked is the event, not a summary of
 * anything else. `completedAt` is stamped and cleared alongside it so the
 * panel can show when something was done without a separate audit read — the
 * service keeps the two in step rather than letting a caller set either
 * directly.
 */
@Table({
  tableName: 'onboarding_tasks',
  timestamps: true,
  indexes: [
    // (newHireId, status) is composite because every progress tally counts
    // completed-vs-total for one hire, and it still serves a lookup of a
    // hire's whole checklist as a leading-column prefix.
    {
      fields: ['newHireId', 'status'],
      name: 'onboarding_task_hire_status_idx',
    },
    // The Upcoming Tasks panel filters on status and orders by due date.
    {
      fields: ['status', 'dueDate'],
      name: 'onboarding_task_status_due_date_idx',
    },
    {
      fields: ['assignedToEmployeeId'],
      name: 'onboarding_task_assignee_idx',
    },
  ],
})
export class OnboardingTask extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare title: string;

  @ForeignKey(() => NewHire)
  @Column({ type: DataType.UUID, allowNull: false })
  declare newHireId: string;

  @BelongsTo(() => NewHire, 'newHireId')
  declare newHire: NewHire;

  @Column({
    type: DataType.ENUM(...Object.values(OnboardingTaskCategory)),
    allowNull: false,
    defaultValue: OnboardingTaskCategory.OTHER,
  })
  declare category: OnboardingTaskCategory;

  @Column({
    type: DataType.ENUM(...Object.values(OnboardingTaskStatus)),
    allowNull: false,
    defaultValue: OnboardingTaskStatus.PENDING,
  })
  declare status: OnboardingTaskStatus;

  /** DATEONLY: a checklist item is due on a day, not at an instant. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare dueDate: string | null;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare assignedToEmployeeId: string | null;

  @BelongsTo(() => Employee, 'assignedToEmployeeId')
  declare assignedTo: Employee;

  /** Explicit checklist position; ties break on dueDate then title. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** Kept in step with `status` by the service — see the class comment. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare completedByUserId: string | null;
}
