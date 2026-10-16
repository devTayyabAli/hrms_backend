import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * A one-to-one conversation on the Messages screen. Exactly two people, and
 * only one conversation per pair: `pairKey` is both people's keys, sorted and
 * joined, and its unique index is what makes "start a conversation" return
 * the existing one instead of a second.
 *
 * Lives in each tenant's own physical database — NOT a shared platform
 * table. `tenantId` is a plain, non-FK defense-in-depth column; the actual
 * isolation boundary is the per-tenant database itself.
 *
 * The `lastMessage*` columns repeat the newest message so the Recent
 * Conversations list is one query, not one per conversation.
 */
@Table({
  tableName: 'chat_conversations',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['pairKey'], name: 'unique_chat_conversation_pair' },
    { fields: ['lastMessageAt'], name: 'chat_conversation_last_message_idx' },
  ],
})
export class ChatConversation extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** "e:<employeeId>" or "u:<userId>" for each person, sorted, joined by "|". */
  @Column({ type: DataType.STRING(160), allowNull: false })
  declare pairKey: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastMessageAt: Date | null;

  /** The first words of the newest message, or the attached file's name. */
  @Column({ type: DataType.STRING(160), allowNull: true })
  declare lastMessagePreview: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare lastMessageSenderUserId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare lastMessageSenderEmployeeId: string | null;
}
