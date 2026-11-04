import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';
import { HelpdeskCategory, HelpdeskPriority, HelpdeskStatus } from '@app/common';

export interface HelpdeskComment {
  at: string;
  byEmployeeId: string | null;
  byName: string;
  /** True when it was written by IT rather than the requester. */
  staff: boolean;
  /** An internal note: the requester never sees it. */
  internal: boolean;
  text: string;
}

/**
 * A ticket an employee raised with IT. The requester and the person working
 * it are plain ids (the service checks them), so the table has no
 * constraints that would decide the order tables are created in. Comments
 * are kept on the ticket: a ticket is read whole, and rarely has many.
 */
@Table({
  tableName: 'helpdesk_tickets',
  timestamps: true,
  indexes: [
    { fields: ['tenantId', 'ticketNumber'], unique: true, name: 'helpdesk_ticket_number_idx' },
    { fields: ['tenantId', 'status'], name: 'helpdesk_ticket_status_idx' },
    { fields: ['requesterId'], name: 'helpdesk_ticket_requester_idx' },
    { fields: ['assignedToEmployeeId'], name: 'helpdesk_ticket_assignee_idx' },
  ],
})
export class HelpdeskTicket extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** TKT-0001, counted per organization. */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare ticketNumber: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare requesterId: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare subject: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  @Column({ type: DataType.ENUM(...Object.values(HelpdeskCategory)), allowNull: false, defaultValue: HelpdeskCategory.OTHER })
  declare category: HelpdeskCategory;

  @Column({ type: DataType.ENUM(...Object.values(HelpdeskPriority)), allowNull: false, defaultValue: HelpdeskPriority.MEDIUM })
  declare priority: HelpdeskPriority;

  @Column({ type: DataType.ENUM(...Object.values(HelpdeskStatus)), allowNull: false, defaultValue: HelpdeskStatus.OPEN })
  declare status: HelpdeskStatus;

  @Column({ type: DataType.UUID, allowNull: true })
  declare assignedToEmployeeId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resolutionNote: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare resolvedAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare comments: HelpdeskComment[];
}
