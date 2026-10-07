import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';
import { CalendarEventKind } from '@app/common';

/**
 * An event or holiday on the Company Calendar. Birthdays and work
 * anniversaries are not stored here — they come from employee records, so
 * they stay right when an employee's details change.
 */
@Table({
  tableName: 'calendar_events',
  timestamps: true,
  indexes: [{ fields: ['date'], name: 'calendar_event_date_idx' }],
})
export class CalendarEvent extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare title: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare date: string;

  @Default(CalendarEventKind.EVENT)
  @Column({ type: DataType.ENUM(...Object.values(CalendarEventKind)), allowNull: false })
  declare kind: CalendarEventKind;

  /** HH:mm, local to the organization. Both null for an all-day entry. */
  @Column({ type: DataType.STRING(5), allowNull: true })
  declare startTime: string | null;

  @Column({ type: DataType.STRING(5), allowNull: true })
  declare endTime: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare location: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** Holidays only: NATIONAL, FESTIVAL or COMPANY (a `HolidayType`). */
  @Column({ type: DataType.STRING(20), allowNull: true })
  declare holidayType: string | null;

  /** Holidays only: an optional holiday staff may take, rather than an office closure. */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isOptional: boolean;

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;
}
