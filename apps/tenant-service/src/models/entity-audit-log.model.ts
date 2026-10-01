import { Table, Column, Model, DataType, PrimaryKey, Default, CreatedAt } from 'sequelize-typescript';

/**
 * The organization's change-history trail — the same `entity_audit_logs`
 * table user-service writes for roles and users, in the same tenant database,
 * so payroll actions show up alongside them in the Audit Log. Declared here
 * with the identical shape so tenant-service can write to it; it must stay in
 * step with user-service's `EntityAuditLog`.
 */
@Table({ tableName: 'entity_audit_logs', timestamps: false })
export class EntityAuditLog extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare tableName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare recordId: string;

  @Column({ type: DataType.ENUM('CREATE', 'UPDATE', 'DELETE'), allowNull: false })
  declare action: 'CREATE' | 'UPDATE' | 'DELETE';

  @Column({ type: DataType.UUID, allowNull: true })
  declare userId: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare changes: Record<string, { from: unknown; to: unknown }> | null;

  @CreatedAt
  declare createdAt: Date;
}
