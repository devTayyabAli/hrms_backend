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
import { ChatConversation } from './chat-conversation.model';

/**
 * One person's side of a conversation: how far they have read, and whether
 * they have deleted it from their own list. Two rows per conversation.
 *
 * A person is an employee (`employeeId`) or — for the organization admin,
 * who has no employee record — a login (`userId`). Either identifies the
 * owner of the row; an employee row carries both once the employee has a login.
 *
 * `lastReadAt` is what the other person sees as "seen", and what unread
 * counts are measured against. `clearedAt` is set when the person deletes
 * the conversation: earlier messages stay hidden for them, new ones bring
 * the conversation back.
 *
 * Both foreign keys cascade, so deleting an employee leaves nothing behind.
 */
@Table({
  tableName: 'chat_participants',
  timestamps: true,
  indexes: [
    { fields: ['conversationId'], name: 'chat_participant_conversation_idx' },
    { fields: ['employeeId'], name: 'chat_participant_employee_idx' },
    { fields: ['userId'], name: 'chat_participant_user_idx' },
  ],
})
export class ChatParticipant extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => ChatConversation)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare conversationId: string;

  @BelongsTo(() => ChatConversation, { foreignKey: 'conversationId', onDelete: 'CASCADE' })
  declare conversation: ChatConversation;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'CASCADE' })
  declare employeeId: string | null;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', onDelete: 'CASCADE' })
  declare employee: Employee | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare userId: string | null;

  /** For a person with no employee record: the name and title to show. */
  @Column({ type: DataType.STRING(150), allowNull: true })
  declare displayName: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare title: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastReadAt: Date | null;

  /** Deleted from this person's list; a new message clears it. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare hiddenAt: Date | null;

  /** Messages sent before this are not shown to this person. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare clearedAt: Date | null;
}
