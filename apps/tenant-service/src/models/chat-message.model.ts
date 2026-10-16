import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { ChatConversation } from './chat-conversation.model';

/**
 * One message in a conversation: text, a file, or both.
 *
 * The file itself lives in the shared file store; the row keeps its id and
 * the facts shown on the attachment card (name, type, size) so the
 * conversation reads the same however the file is later handled.
 */
@Table({
  tableName: 'chat_messages',
  timestamps: true,
  indexes: [{ fields: ['conversationId', 'createdAt'], name: 'chat_message_conversation_time_idx' }],
})
export class ChatMessage extends Model {
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

  /** The sender's login. An organization admin has no employee record, so this is the identity. */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare senderUserId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare senderEmployeeId: string | null;

  /** Null for a message that is only a file. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare body: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare attachmentFileId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare attachmentName: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare attachmentMimeType: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare attachmentSize: number | null;
}
