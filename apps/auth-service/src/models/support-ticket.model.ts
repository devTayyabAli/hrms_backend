import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  Index,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import {
  HelpCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@app/common';

@Table({ tableName: 'support_tickets' })
export class SupportTicket extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  /** Human-facing reference shown in the UI, e.g. TKT-2026-0893. */
  @Index
  @Column({ allowNull: false, unique: true })
  declare ticketNumber: string;

  @Column({ allowNull: false })
  declare subject: string;

  @Column(DataType.TEXT)
  declare description: string;

  @Column({
    type: DataType.ENUM(...Object.values(HelpCategory)),
    allowNull: true,
  })
  declare category: HelpCategory;

  @Index
  @Default(SupportTicketStatus.OPEN)
  @Column({ type: DataType.ENUM(...Object.values(SupportTicketStatus)) })
  declare status: SupportTicketStatus;

  @Default(SupportTicketPriority.MEDIUM)
  @Column({ type: DataType.ENUM(...Object.values(SupportTicketPriority)) })
  declare priority: SupportTicketPriority;

  @Column
  declare createdBy: string;

  @Column
  declare createdByName: string;

  /** Where the reply goes: emailed when the ticket's status changes. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByEmail: string | null;

  /** e.g. 'Super Admin', 'Org Admin', 'Employee'. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByRole: string | null;

  /** The organization that raised it; null for a Super Admin's own ticket. */
  @Index
  @Column({ type: DataType.UUID, allowNull: true })
  declare tenantId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare organizationName: string | null;

  @Column(DataType.TEXT)
  declare resolutionNote: string;

  @Column(DataType.DATE)
  declare resolvedAt: Date;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
