import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * When a person was last seen using Messages — what the "Online" label reads.
 * One row per login, refreshed by the heartbeat and by every chat call.
 *
 * Lives in each tenant's own physical database; `tenantId` is a plain,
 * non-FK defense-in-depth column.
 */
@Table({
  tableName: 'chat_presence',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['userId'], name: 'unique_chat_presence_user' },
    { fields: ['employeeId'], name: 'chat_presence_employee_idx' },
  ],
})
export class ChatPresence extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare userId: string;

  /** Known once the login belongs to an employee. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare employeeId: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare lastSeenAt: Date;
}
