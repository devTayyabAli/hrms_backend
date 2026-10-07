import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, Index, CreatedAt, UpdatedAt } from 'sequelize-typescript';
import type { AiOwnerType } from '@app/common';

/**
 * One AI Assistant conversation. Kept in the platform DB for every owner type:
 * the Super Admin has no tenant DB, and keeping tenant users' history here too
 * means one retention sweep covers everyone.
 */
@Table({ tableName: 'ai_conversations' })
export class AiConversation extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Index
  @Column({ allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare ownerType: AiOwnerType;

  @Index
  @Column({ allowNull: true })
  declare tenantId: string | null;

  @Column({ allowNull: false })
  declare title: string;

  /** Messages API history, append-only (see AiAssistantService in the gateway). */
  @Default([])
  @Column(DataType.JSONB)
  declare apiMessages: unknown[];

  /** Display transcript for the chat panel. */
  @Default([])
  @Column(DataType.JSONB)
  declare transcript: unknown[];

  @Default(0)
  @Column(DataType.INTEGER)
  declare inputTokens: number;

  @Default(0)
  @Column(DataType.INTEGER)
  declare outputTokens: number;

  @CreatedAt
  declare createdAt: Date;

  @Index
  @UpdatedAt
  declare updatedAt: Date;
}
